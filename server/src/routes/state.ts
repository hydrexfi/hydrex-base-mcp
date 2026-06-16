import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  ROUTER_API_BASE,
  CHAIN_ID,
  HYDREX_STATS_API_BASE,
} from "../lib/constants";
import { fetchPositionIds, fetchPosition, publicClient } from "../lib/pool";
import type { Address } from "viem";

const router = Router();

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address");

const erc20MetadataAbi = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const knownTokenDecimals: Record<string, number> = {
  "0x00000e7efa313f4e11bfff432471ed9423ac6b30": 18, // HYDX
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC
  "0x4200000000000000000000000000000000000006": 18, // WETH
};

type StatsToken = {
  id: string;
  symbol: string;
  name?: string;
};

type StatsPair = {
  id: string;
  token0: StatsToken;
  token1: StatsToken;
  fee?: string;
  totalValueLockedUSD?: string;
  liquidityType?: string;
  aggregatedData?: {
    totalVolumeUSD?: string;
    totalFeesUSD?: string;
    totalValueLockedUSD?: string;
    averageFee?: string;
  };
};

type StatsPairsResponse = {
  summary?: unknown;
  pairs?: StatsPair[];
};

type TradeHistoryResponse = {
  trades?: unknown[];
};

function normalizeTokenFilter(value?: string) {
  if (!value) return undefined;
  return value.startsWith("0x") ? value.toLowerCase() : value.toUpperCase();
}

function tokenMatches(token: StatsToken, filter?: string) {
  if (!filter) return true;
  if (filter.startsWith("0x")) return token.id.toLowerCase() === filter;
  return token.symbol.toUpperCase() === filter;
}

async function getTokenDecimals(address: string) {
  const normalized = address.toLowerCase();
  if (knownTokenDecimals[normalized] !== undefined) {
    return knownTokenDecimals[normalized];
  }

  try {
    const decimals = await publicClient.readContract({
      address: normalized as Address,
      abi: erc20MetadataAbi,
      functionName: "decimals",
    });
    return Number(decimals);
  } catch {
    return undefined;
  }
}

function getPairTvl(pair: StatsPair) {
  return (
    pair.totalValueLockedUSD ??
    pair.aggregatedData?.totalValueLockedUSD ??
    "0"
  );
}

/**
 * GET /state/quote
 * Proxies the Hydrex Router API quote endpoint and returns the best swap
 * rate with executable transaction payload.
 *
 * Query params:
 *   tokenIn    - input token address
 *   tokenOut   - output token address
 *   amount     - input amount in wei (as decimal string)
 *   recipient  - wallet address that will execute the swap
 *   slippage   - slippage tolerance in basis points (default: 50 = 0.5%)
 *   source     - optional aggregator filter: ZEROX | OPENOCEAN | OKX | KYBERSWAP
 */
router.get("/quote", async (req: Request, res: Response) => {
  const schema = z.object({
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    amount: z.string().min(1),
    recipient: addressSchema,
    slippage: z.coerce.number().min(1).max(5000).default(50),
    source: z
      .enum(["ZEROX", "OPENOCEAN", "OKX", "KYBERSWAP"])
      .optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { tokenIn, tokenOut, amount, recipient, slippage, source } =
    parsed.data;

  const params = new URLSearchParams({
    fromTokenAddress: tokenIn,
    toTokenAddress: tokenOut,
    amount,
    taker: recipient,
    chainId: String(CHAIN_ID),
    slippage: String(slippage),
  });
  if (source) params.set("source", source);

  try {
    const upstream = await fetch(
      `${ROUTER_API_BASE}/quote?${params.toString()}`
    );
    const data = await upstream.json();
    return res.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream error";
    return res.status(502).json({ ok: false, error: message });
  }
});

/**
 * GET /state/portfolio
 * Returns token balances and positions for a wallet address.
 *
 * Query params:
 *   address - wallet address
 */
router.get("/portfolio", async (req: Request, res: Response) => {
  const parsed = z.object({ address: addressSchema }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { address } = parsed.data;

  try {
    const upstream = await fetch(
      `${ROUTER_API_BASE}/portfolio/address/${address}`
    );
    const data = await upstream.json();
    return res.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream error";
    return res.status(502).json({ ok: false, error: message });
  }
});

/**
 * GET /state/pools
 * Returns Hydrex pools discovered from the stats API.
 *
 * Query params:
 *   tokenA        - optional token symbol or address
 *   tokenB        - optional token symbol or address
 *   token0        - optional order-specific token0 symbol or address
 *   token1        - optional order-specific token1 symbol or address
 *   liquidityType - optional pool type filter
 *   days          - stats lookback window, 1-30 days (default: 1)
 *   limit         - max upstream pairs to scan, 1-1000 (default: 1000)
 */
router.get("/pools", async (req: Request, res: Response) => {
  const schema = z.object({
    tokenA: z.string().min(1).optional(),
    tokenB: z.string().min(1).optional(),
    token0: z.string().min(1).optional(),
    token1: z.string().min(1).optional(),
    liquidityType: z
      .enum(["integral", "classic-volatile", "classic-stable"])
      .optional(),
    days: z.coerce.number().int().min(1).max(30).default(1),
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const {
    tokenA,
    tokenB,
    token0,
    token1,
    liquidityType,
    days,
    limit,
  } = parsed.data;

  const tokenAFilter = normalizeTokenFilter(tokenA);
  const tokenBFilter = normalizeTokenFilter(tokenB);
  const token0Filter = normalizeTokenFilter(token0);
  const token1Filter = normalizeTokenFilter(token1);

  const matchesUnorderedPair = (pair: StatsPair) => {
    if (!tokenAFilter && !tokenBFilter) return true;
    if (tokenAFilter && !tokenBFilter) {
      return (
        tokenMatches(pair.token0, tokenAFilter) ||
        tokenMatches(pair.token1, tokenAFilter)
      );
    }
    if (!tokenAFilter && tokenBFilter) {
      return (
        tokenMatches(pair.token0, tokenBFilter) ||
        tokenMatches(pair.token1, tokenBFilter)
      );
    }
    return (
      (tokenMatches(pair.token0, tokenAFilter) &&
        tokenMatches(pair.token1, tokenBFilter)) ||
      (tokenMatches(pair.token0, tokenBFilter) &&
        tokenMatches(pair.token1, tokenAFilter))
    );
  };

  const matchesOrderedPair = (pair: StatsPair) =>
    tokenMatches(pair.token0, token0Filter) &&
    tokenMatches(pair.token1, token1Filter);

  try {
    const params = new URLSearchParams({
      days: String(days),
      limit: String(limit),
    });
    const upstream = await fetch(
      `${HYDREX_STATS_API_BASE}/stats/top-pairs?${params.toString()}`
    );

    if (!upstream.ok) {
      const errorText = await upstream.text();
      return res.status(upstream.status).json({
        ok: false,
        error: errorText || "Hydrex stats API error",
      });
    }

    const data = (await upstream.json()) as StatsPairsResponse;
    const pairs = Array.isArray(data?.pairs) ? (data.pairs as StatsPair[]) : [];
    const filtered = pairs
      .filter((pair) => !liquidityType || pair.liquidityType === liquidityType)
      .filter(matchesUnorderedPair)
      .filter(matchesOrderedPair)
      .sort((a, b) => Number(getPairTvl(b)) - Number(getPairTvl(a)));

    const uniqueTokens = new Map<string, Promise<number | undefined>>();
    for (const pair of filtered) {
      for (const token of [pair.token0, pair.token1]) {
        const address = token.id.toLowerCase();
        if (!uniqueTokens.has(address)) {
          uniqueTokens.set(address, getTokenDecimals(address));
        }
      }
    }

    const decimalsByAddress = new Map<string, number | undefined>();
    await Promise.all(
      Array.from(uniqueTokens.entries()).map(async ([address, promise]) => {
        decimalsByAddress.set(address, await promise);
      })
    );

    const pools = filtered.map((pair) => ({
      id: pair.id,
      pool: pair.id,
      liquidityType: pair.liquidityType,
      fee: pair.fee,
      token0: {
        address: pair.token0.id,
        symbol: pair.token0.symbol,
        name: pair.token0.name,
        decimals: decimalsByAddress.get(pair.token0.id.toLowerCase()),
      },
      token1: {
        address: pair.token1.id,
        symbol: pair.token1.symbol,
        name: pair.token1.name,
        decimals: decimalsByAddress.get(pair.token1.id.toLowerCase()),
      },
      tvlUsd: getPairTvl(pair),
      volumeUsd: pair.aggregatedData?.totalVolumeUSD,
      feesUsd: pair.aggregatedData?.totalFeesUSD,
      averageFee: pair.aggregatedData?.averageFee,
    }));

    return res.json({
      ok: true,
      count: pools.length,
      summary: data?.summary,
      pools,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream error";
    return res.status(502).json({ ok: false, error: message });
  }
});

/**
 * GET /state/trade-history
 * Returns swap history for a wallet address.
 *
 * Query params:
 *   address - wallet address
 */
router.get("/trade-history", async (req: Request, res: Response) => {
  const parsed = z.object({ address: addressSchema }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { address } = parsed.data;

  try {
    const upstream = await fetch(
      `${ROUTER_API_BASE}/transactions/trade-history?address=${address}&chainId=${CHAIN_ID}`
    );
    const data = (await upstream.json()) as TradeHistoryResponse;
    const trades = Array.isArray(data?.trades) ? data.trades : [];
    return res.json({ ok: true, data, trades });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream error";
    return res.status(502).json({ ok: false, error: message });
  }
});

/**
 * GET /state/positions
 *
 * Returns all open concentrated liquidity positions for a wallet by
 * reading directly from the NonfungiblePositionManager on-chain.
 * Use the returned positionId values with /prepare/remove-liquidity.
 *
 * Query params:
 *   address - wallet address
 */
router.get("/positions", async (req: Request, res: Response) => {
  const parsed = z.object({ address: addressSchema }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { address } = parsed.data;

  try {
    const tokenIds = await fetchPositionIds(address as Address);

    const positions = await Promise.all(
      tokenIds.map(async (tokenId) => {
        const pos = await fetchPosition(tokenId);

        // Derive pool address from factory via the pool contract read
        // (token0/token1/fee are sufficient context for the plugin to identify the pool)
        return {
          positionId: tokenId.toString(),
          token0: pos.token0,
          token1: pos.token1,
          fee: pos.fee,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          liquidity: pos.liquidity.toString(),
          tokensOwed0: pos.tokensOwed0.toString(),
          tokensOwed1: pos.tokensOwed1.toString(),
        };
      })
    );

    // Filter out positions with zero liquidity (already closed)
    const open = positions.filter((p) => p.liquidity !== "0");

    return res.json({ ok: true, count: open.length, positions: open });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(502).json({ ok: false, error: message });
  }
});

export default router;
