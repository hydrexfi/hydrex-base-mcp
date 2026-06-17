# hydrex-base-skill

A [Base MCP](https://docs.base.org/ai-agents) custom plugin for [Hydrex](https://hydrex.fi) on Base mainnet. Lets AI assistants (Cursor, Claude, ChatGPT) quote swaps, add/remove concentrated liquidity positions, and read portfolio state — all through the user's Base Account wallet.

---

## What it does

| Action | How |
|---|---|
| Swap any token pair | Hydrex Router API (`router.api.hydrex.fi`) |
| Add liquidity (enter a position) | Hydrex SDK `NonfungiblePositionManager` |
| Remove liquidity (exit a position) | Hydrex SDK `NonfungiblePositionManager` |
| Read open positions (on-chain) | NFPM contract read |
| Read portfolio + trade history | Hydrex Router API |

Write actions go through Base MCP's `send_calls` — the user approves each batch in their wallet via a single Coinbase popup.

---

## How it works

Base MCP plugins are markdown specs that tell an AI which APIs to call and how to convert the response into onchain calls. This repo has two parts:

1. **`skills/base-mcp/plugins/hydrex.md`** — the plugin spec. Defines onboarding, read endpoints, prepare endpoints, and the `send_calls` mapping.
2. **`server/`** — a small Express server that exposes GET prepare-endpoints. Custom hosts are not on Base MCP's `web_request` allowlist, so this server acts as the calldata builder.

```
get_wallets → read state → GET /prepare/<action> → send_calls → get_request_status
```

---

## Repo layout

```
skills/base-mcp/plugins/hydrex.md   plugin spec (main deliverable)
server/src/routes/prepare.ts        calldata endpoints (swap, stake, liquidity)
server/src/routes/state.ts          read endpoints (quote, portfolio, positions)
server/src/lib/pool.ts              Hydrex SDK pool helpers + price→tick math
server/src/lib/constants.ts         pool + NFPM ABI fragments
.cursor/mcp.json                    Base MCP connection for Cursor
```

---

## Quick start

### 1 — Connect Base MCP in Cursor

The `.cursor/mcp.json` in this repo auto-registers `base-mcp`. After cloning, restart Cursor and go to **Settings (`Ctrl+Shift+J`) → Tools & MCP** to confirm it's active.

### 2 — Load the plugin as a Cursor rule

```bash
mkdir -p .cursor/rules
cp skills/base-mcp/plugins/hydrex.md .cursor/rules/hydrex.mdc
```

The rule loads automatically in every new chat for this project.

### 3 — Run the prepare server

```bash
cd server
cp .env.example .env   # BASE_RPC_URL is required for add/remove liquidity
npm install
npm run dev            # http://localhost:3000
```

Verify it's running:
```bash
curl http://localhost:3000/health
# {"ok":true,"service":"hydrex-base-skill-server","chainId":8453}
```

Swap routing works without the server (hits the Hydrex Router API directly). Liquidity endpoints require the server and a `BASE_RPC_URL` for on-chain pool reads.

---

## How to prompt the agent

Open a new agent chat in Cursor. Supply pool addresses from [hydrex.fi](https://hydrex.fi). Token addresses for common assets (USDC, WETH) are already known to the agent.

### Swapping

```
Swap 5 USDC for ETH on Hydrex
Swap 0.01 ETH for USDC on Hydrex with 1% slippage
Swap 10 USDC for HYDX (0x<HYDX_ADDRESS>) on Hydrex
```

The agent fetches a quote, shows you the output amount and price impact, asks for confirmation, then executes.

---

### Adding liquidity (entering a position)

On Hydrex, adding liquidity creates a concentrated liquidity position that earns fees and rewards immediately — no separate staking step is required.

```
Add liquidity to the USDC/ETH pool on Hydrex
  pool: 0x<pool_address>
  amounts: 100 USDC and 0.04 ETH
```

```
Add liquidity to the USDC/ETH pool on Hydrex
  pool: 0x<pool_address>
  amounts: 100 USDC and 0.04 ETH
  price range: 1800 to 2200
```

**Price range** — if omitted, the agent defaults to the **Common (±12.5%)** preset around the current pool price and tells you what range was used. You can choose **Tight (±1%)**, **Narrow (±5%)**, **Common (±12.5%)**, **Wide (±20%)**, a **custom** range (explicit lower/upper prices), or **full range**. Tighter ranges capture more fees (with higher impermanent loss risk); wider ranges need less maintenance.

The wallet approval batches three calls atomically: approve token0 → approve token1 → mint position.

---

### Removing liquidity (exiting a position)

Removing liquidity exits your position and returns both tokens to your wallet. This is the equivalent of unstaking.

```
Show my Hydrex liquidity positions
```

```
Remove liquidity from my Hydrex position #<positionId>
  pool: 0x<pool_address>
```

```
Remove 50% of liquidity from Hydrex position #12345
  pool: 0x<pool_address>
```

Always run "Show my Hydrex liquidity positions" first to get your `positionId` values. You can remove a partial percentage or all liquidity (default: 100%).

---

### Portfolio & history

```
Show my Hydrex portfolio
Show my Hydrex liquidity positions
Show my Hydrex trade history
```

---

## Server endpoints

### Read

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health check |
| `GET` | `/state/quote` | Best swap quote with tx payload |
| `GET` | `/state/portfolio` | Token balances for a wallet |
| `GET` | `/state/positions` | Open LP positions (on-chain, from NFPM) |
| `GET` | `/state/pools` | Discover Hydrex pools by token pair and liquidity type |
| `GET` | `/state/trade-history` | Swap history for a wallet (`trades`, with upstream payload under `data`) |

### Prepare

All prepare endpoints return ordered-batch transactions:

```json
{
  "ok": true,
  "transactions": [
    { "step": "<label>", "to": "0x...", "data": "0x...", "value": "0x0", "chainId": 8453 }
  ],
  "sendCalls": {
    "chain": "base",
    "calls": [
      { "to": "0x...", "value": "0x0", "data": "0x..." }
    ]
  }
}
```

Use `sendCalls` directly with Base MCP `send_calls`. It is the same calldata from `transactions[]`, pre-shaped to avoid manually copying long hex strings.

For swaps, ERC-20 input tokens may include an `approve-tokenIn` transaction before the `swap` transaction when wallet allowance is too low. Native ETH swaps return the swap transaction only.

| Method | Path | Key params |
|---|---|---|
| `GET` | `/prepare/swap` | `tokenIn`, `tokenOut`, `amount`, `decimals`, `recipient`, `slippage` |
| `GET` | `/prepare/add-liquidity` | `from`, `pool`, `token0`, `token1`, `amount0`, `amount1`, `rangePreset`?, `priceLower`?, `priceUpper`?, `fullRange`? |
| `GET` | `/prepare/remove-liquidity` | `from`, `positionId`, `pool`, `liquidityPercent`?, `slippage` |

---

## References

- [Base MCP overview](https://docs.base.org/ai-agents)
- [Custom plugins guide](https://docs.base.org/ai-agents/plugins/custom-plugins)
- [Hydrex SDK docs](https://hydrex-sdk-docs.vercel.app/)
- [Hydrex Router API Swagger](https://router.api.hydrex.fi/api)
- [Base skills reference repo](https://github.com/base/skills)
