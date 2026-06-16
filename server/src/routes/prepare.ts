import { Router, Request, Response } from "express";
import { z } from "zod";
import { encodeFunctionData, parseUnits, type Address } from "viem";

const nfpmMulticallAbi = [
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

/**
 * The Hydrex SDK's NonfungiblePositionManager returns `calldata: string[]`.
 * A single-element array is used directly; multiple elements are packed into
 * a `multicall(bytes[])` call that the NFPM handles atomically.
 */
function encodeNfpmCalldata(calldatas: string[]): string {
  if (calldatas.length === 1) return calldatas[0];
  return encodeFunctionData({
    abi: nfpmMulticallAbi,
    functionName: "multicall",
    args: [calldatas as `0x${string}`[]],
  });
}
import {
  NonfungiblePositionManager,
  Position,
  Token,
  CurrencyAmount,
  Percent,
  ChainId,
  TickMath,
  nearestUsableTick,
} from "@hydrexfi/hydrex-sdk";
import { CHAIN_ID, ROUTER_API_BASE } from "../lib/constants";
import {
  fetchPool,
  fetchPosition,
  priceToTick,
  NFPM_ADDRESS,
  publicClient,
} from "../lib/pool";

const router = Router();

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

const addressSchema = z
  .string()
  .regex(addressPattern, "Invalid EVM address")
  .transform((v) => v as Address);

type PreparedTransaction = {
  step: string;
  to: Address;
  data: string;
  value: string;
  chainId: typeof CHAIN_ID;
};

type SendCallsPayload = {
  chain: "base";
  calls: Array<{
    to: Address;
    value: string;
    data: string;
  }>;
};

const hexSchema = /^0x[0-9a-fA-F]*$/;
const hexValueSchema = /^0x[0-9a-fA-F]+$/;
const nativeTokenAddresses = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

function assertHexData(data: string, step: string): void {
  if (!hexSchema.test(data)) {
    throw new Error(`${step} calldata must be a 0x-prefixed hex string`);
  }
  if ((data.length - 2) % 2 !== 0) {
    throw new Error(`${step} calldata must have an even hex length`);
  }
}

function assertHexValue(value: string, step: string): void {
  if (!hexValueSchema.test(value)) {
    throw new Error(`${step} value must be a 0x-prefixed hex string`);
  }
}

function assertAddress(value: string, step: string): void {
  if (!addressPattern.test(value)) {
    throw new Error(`${step} target must be an EVM address`);
  }
}

function buildPreparePayload(transactions: PreparedTransaction[]): {
  transactions: PreparedTransaction[];
  sendCalls: SendCallsPayload;
} {
  for (const tx of transactions) {
    assertAddress(tx.to, tx.step);
    assertHexData(tx.data, tx.step);
    assertHexValue(tx.value, tx.step);
  }

  return {
    transactions,
    sendCalls: {
      chain: "base",
      calls: transactions.map(({ to, value, data }) => ({ to, value, data })),
    },
  };
}

function isNativeToken(address: Address): boolean {
  return nativeTokenAddresses.has(address.toLowerCase());
}

// ─── ABI fragments for ERC-20 and gauge interactions ─────────────────────────

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const gaugeGetRewardAbi = [
  {
    name: "getReward",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
  },
] as const;

// ─── Swap ─────────────────────────────────────────────────────────────────────

/**
 * GET /prepare/swap
 *
 * Fetches the best route from the Hydrex Router API and returns executable
 * calldata in the ordered-batch format expected by Base MCP's send_calls.
 *
 * Query params:
 *   tokenIn    - input token address
 *   tokenOut   - output token address
 *   amount     - human-readable input amount (e.g. "1.5" for 1.5 USDC)
 *   decimals   - decimals of tokenIn (default: 18)
 *   recipient  - wallet address
 *   slippage   - slippage in bps (default: 50 = 0.5%)
 *   source     - optional aggregator: ZEROX | OPENOCEAN | OKX | KYBERSWAP
 */
router.get("/swap", async (req: Request, res: Response) => {
  const schema = z.object({
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    amount: z.string().min(1),
    decimals: z.coerce.number().min(0).max(18).default(18),
    recipient: addressSchema,
    slippage: z.coerce.number().min(1).max(5000).default(50),
    source: z.enum(["ZEROX", "OPENOCEAN", "OKX", "KYBERSWAP"]).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { tokenIn, tokenOut, amount, decimals, recipient, slippage, source } =
    parsed.data;

  const amountWei = parseUnits(amount, decimals).toString();
  const params = new URLSearchParams({
    fromTokenAddress: tokenIn,
    toTokenAddress: tokenOut,
    amount: amountWei,
    taker: recipient,
    chainId: String(CHAIN_ID),
    slippage: String(slippage),
  });
  if (source) params.set("source", source);

  try {
    const upstream = await fetch(`${ROUTER_API_BASE}/quote?${params}`);
    if (!upstream.ok) {
      const text = await upstream.text();
      return res
        .status(upstream.status)
        .json({ ok: false, error: `Router API error: ${text}` });
    }

    const quote = (await upstream.json()) as {
      amountIn?: string;
      amountOut: string;
      source?: string;
      priceImpact?: number;
      transaction: {
        to: string;
        data: string;
        value?: string;
      };
    };

    const { to, data, value } = quote.transaction;
    const routerAddress = to as Address;
    const amountIn = BigInt(quote.amountIn ?? amountWei);
    const swapTransaction: PreparedTransaction = {
      step: "swap",
      to: routerAddress,
      data,
      value: value ? `0x${BigInt(value).toString(16)}` : "0x0",
      chainId: CHAIN_ID,
    };
    const transactions: PreparedTransaction[] = [];

    if (!isNativeToken(tokenIn)) {
      const allowance = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [recipient, routerAddress],
      });

      if (allowance < amountIn) {
        transactions.push({
          step: "approve-tokenIn",
          to: tokenIn,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [routerAddress, amountIn],
          }),
          value: "0x0",
          chainId: CHAIN_ID,
        });
      }
    }

    transactions.push(swapTransaction);

    return res.json({
      ok: true,
      quote: {
        tokenIn,
        tokenOut,
        amountIn: quote.amountIn ?? amountWei,
        amountOut: quote.amountOut,
        source: quote.source,
        priceImpact: quote.priceImpact,
      },
      approval: {
        required: transactions[0]?.step === "approve-tokenIn",
        token: tokenIn,
        spender: routerAddress,
        amount: amountIn.toString(),
      },
      ...buildPreparePayload(transactions),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(502).json({ ok: false, error: message });
  }
});

// ─── Gauge rewards ────────────────────────────────────────────────────────────

/**
 * GET /prepare/claim
 *
 * Builds a getReward transaction to claim pending gauge emissions.
 *
 * Query params:
 *   from  - wallet address (rewards recipient)
 *   gauge - gauge contract address
 */
router.get("/claim", async (req: Request, res: Response) => {
  const schema = z.object({
    from: addressSchema,
    gauge: addressSchema,
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const { from, gauge } = parsed.data;
  const transactions: PreparedTransaction[] = [
    {
      step: "claim",
      to: gauge,
      data: encodeFunctionData({
        abi: gaugeGetRewardAbi,
        functionName: "getReward",
        args: [from],
      }),
      value: "0x0",
      chainId: CHAIN_ID,
    },
  ];

  return res.json({
    ok: true,
    ...buildPreparePayload(transactions),
  });
});

// ─── Liquidity management ─────────────────────────────────────────────────────

/**
 * GET /prepare/add-liquidity
 *
 * Builds the calldata to mint a new concentrated liquidity position
 * via Hydrex's NonfungiblePositionManager. Returns an approve + approve
 * + mint batch (three transactions).
 *
 * Reads current pool state on-chain to resolve tick spacing and
 * current price. If priceLower/priceUpper are omitted, defaults to
 * ±20% of the current pool price.
 *
 * Query params:
 *   from        - wallet address providing liquidity
 *   pool        - pool contract address
 *   token0      - token0 contract address (must match pool order)
 *   token1      - token1 contract address (must match pool order)
 *   decimals0   - token0 decimals (default: 18)
 *   decimals1   - token1 decimals (default: 18)
 *   amount0     - desired token0 amount, human-readable (e.g. "0.05")
 *   amount1     - desired token1 amount, human-readable (e.g. "100")
 *   priceLower  - lower bound price (token1 per token0), optional
 *   priceUpper  - upper bound price (token1 per token0), optional
 *   slippage    - slippage in bps (default: 50)
 */
router.get("/add-liquidity", async (req: Request, res: Response) => {
  const schema = z.object({
    from: addressSchema,
    pool: addressSchema,
    token0: addressSchema,
    token1: addressSchema,
    decimals0: z.coerce.number().min(0).max(18).default(18),
    decimals1: z.coerce.number().min(0).max(18).default(18),
    amount0: z.string().min(1),
    amount1: z.string().min(1),
    priceLower: z.coerce.number().positive().optional(),
    priceUpper: z.coerce.number().positive().optional(),
    fullRange: z
      .enum(["true", "false", "1", "0"])
      .transform((v) => v === "true" || v === "1")
      .default("false"),
    slippage: z.coerce.number().min(1).max(5000).default(50),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const {
    from,
    pool: poolAddress,
    token0: token0Address,
    token1: token1Address,
    decimals0,
    decimals1,
    amount0,
    amount1,
    priceLower,
    priceUpper,
    fullRange,
    slippage,
  } = parsed.data;

  try {
    const pool = await fetchPool(
      poolAddress,
      token0Address,
      token1Address,
      decimals0,
      decimals1
    );

    const token0 = pool.token0 as Token;
    const token1 = pool.token1 as Token;

    let tickLower: number;
    let tickUpper: number;

    if (fullRange) {
      tickLower = nearestUsableTick(TickMath.MIN_TICK, pool.tickSpacing);
      tickUpper = nearestUsableTick(TickMath.MAX_TICK, pool.tickSpacing);
    } else {
      // Default price range to ±20% of current price if not specified.
      // currentPrice is expressed as token1 per token0.
      const currentPrice = parseFloat(pool.token0Price.toSignificant(18));
      const lower = priceLower ?? currentPrice * 0.8;
      const upper = priceUpper ?? currentPrice * 1.2;

      tickLower = priceToTick(lower, token0, token1, pool.tickSpacing);
      tickUpper = priceToTick(upper, token0, token1, pool.tickSpacing);
    }

    if (tickLower >= tickUpper) {
      return res.status(400).json({
        ok: false,
        error:
          "priceLower must be strictly less than priceUpper after tick rounding",
      });
    }

    const amount0Raw = parseUnits(amount0, decimals0);
    const amount1Raw = parseUnits(amount1, decimals1);

    const position = Position.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: amount0Raw.toString(),
      amount1: amount1Raw.toString(),
      useFullPrecision: true,
    });

    const deadline = (Math.floor(Date.now() / 1000) + 1200).toString();
    const slippagePct = new Percent(slippage, 10_000);

    const { calldata, value } = NonfungiblePositionManager.addCallParameters(
      position,
      {
        recipient: from,
        deadline,
        slippageTolerance: slippagePct,
      }
    );

    const approveToken0 = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [NFPM_ADDRESS, amount0Raw],
    });

    const approveToken1 = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [NFPM_ADDRESS, amount1Raw],
    });
    const transactions: PreparedTransaction[] = [
      {
        step: "approve-token0",
        to: token0Address,
        data: approveToken0,
        value: "0x0",
        chainId: CHAIN_ID,
      },
      {
        step: "approve-token1",
        to: token1Address,
        data: approveToken1,
        value: "0x0",
        chainId: CHAIN_ID,
      },
      {
        step: "mint",
        to: NFPM_ADDRESS,
        data: encodeNfpmCalldata(calldata),
        value: `0x${BigInt(value).toString(16)}`,
        chainId: CHAIN_ID,
      },
    ];

    return res.json({
      ok: true,
      position: {
        tickLower,
        tickUpper,
        amount0: position.amount0.toSignificant(6),
        amount1: position.amount1.toSignificant(6),
      },
      ...buildPreparePayload(transactions),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(502).json({ ok: false, error: message });
  }
});

/**
 * GET /prepare/remove-liquidity
 *
 * Builds the calldata to decrease liquidity and collect tokens from an
 * existing NonfungiblePositionManager position. Reads position state
 * on-chain to determine current liquidity and owed tokens.
 *
 * Query params:
 *   from              - wallet address that owns the position
 *   positionId        - NFT tokenId of the position
 *   pool              - pool contract address
 *   decimals0         - token0 decimals (default: 18)
 *   decimals1         - token1 decimals (default: 18)
 *   liquidityPercent  - percentage of liquidity to remove, 1–100 (default: 100)
 *   slippage          - slippage in bps (default: 50)
 */
router.get("/remove-liquidity", async (req: Request, res: Response) => {
  const schema = z.object({
    from: addressSchema,
    positionId: z.coerce.bigint().positive(),
    pool: addressSchema,
    decimals0: z.coerce.number().min(0).max(18).default(18),
    decimals1: z.coerce.number().min(0).max(18).default(18),
    liquidityPercent: z.coerce.number().min(1).max(100).default(100),
    slippage: z.coerce.number().min(1).max(5000).default(50),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const {
    from,
    positionId,
    pool: poolAddress,
    decimals0,
    decimals1,
    liquidityPercent,
    slippage,
  } = parsed.data;

  try {
    const posData = await fetchPosition(positionId);

    if (posData.liquidity === 0n) {
      return res
        .status(400)
        .json({ ok: false, error: "Position has no liquidity to remove" });
    }

    const pool = await fetchPool(
      poolAddress,
      posData.token0,
      posData.token1,
      decimals0,
      decimals1
    );

    const position = new Position({
      pool,
      tickLower: posData.tickLower,
      tickUpper: posData.tickUpper,
      liquidity: posData.liquidity.toString(),
    });

    const token0 = pool.token0 as Token;
    const token1 = pool.token1 as Token;

    const deadline = (Math.floor(Date.now() / 1000) + 1200).toString();
    const slippagePct = new Percent(slippage, 10_000);
    const liquidityPct = new Percent(liquidityPercent, 100);

    const { calldata, value } =
      NonfungiblePositionManager.removeCallParameters(position, {
        tokenId: positionId.toString(),
        liquidityPercentage: liquidityPct,
        slippageTolerance: slippagePct,
        deadline,
        collectOptions: {
          expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(
            token0,
            posData.tokensOwed0.toString()
          ),
          expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(
            token1,
            posData.tokensOwed1.toString()
          ),
          recipient: from,
        },
      });
    const transactions: PreparedTransaction[] = [
      {
        step: "remove-liquidity",
        to: NFPM_ADDRESS,
        data: encodeNfpmCalldata(calldata),
        value: `0x${BigInt(value).toString(16)}`,
        chainId: CHAIN_ID,
      },
    ];

    return res.json({
      ok: true,
      ...buildPreparePayload(transactions),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(502).json({ ok: false, error: message });
  }
});

export default router;
