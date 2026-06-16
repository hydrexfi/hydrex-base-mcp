import { Router, Request, Response } from "express";
import { z } from "zod";
import { ROUTER_API_BASE, CHAIN_ID } from "../lib/constants";
import { fetchPositionIds, fetchPosition, publicClient, NFPM_ADDRESS } from "../lib/pool";
import { POOL_ABI } from "../lib/constants";
import type { Address } from "viem";

const router = Router();

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address");

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
    const data = (await upstream.json()) as { trades?: unknown[] };
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
