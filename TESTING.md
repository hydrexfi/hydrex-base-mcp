# Team Testing Guide

How to set up and run the Hydrex Base MCP plugin on your local machine for testing.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [Cursor](https://cursor.com) desktop app | Any recent version |
| Node.js 20+ | Verify with `node --version` |
| Coinbase Smart Wallet | Needs a small amount of ETH on Base mainnet for write actions |

---

## Setup

### 1 — Clone the repo

```bash
git clone https://github.com/hydrexfi/hydrex-base-skill.git
cd hydrex-base-skill
```

### 2 — Start the prepare server

The prepare server builds unsigned calldata for swap, liquidity, and staking actions. It must be running for the agent to work.

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

The defaults in `.env.example` work out of the box (`BASE_RPC_URL` points to the public Base mainnet RPC). Edit `.env` only if you want to use a private RPC endpoint.

Verify the server started correctly:

```bash
curl http://localhost:3000/health
# {"ok":true,"service":"hydrex-base-skill-server","chainId":8453}
```

Verify prepare responses include a Base MCP-ready handoff payload:

```bash
curl -s "http://localhost:3000/prepare/swap?tokenIn=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&tokenOut=0x4200000000000000000000000000000000000006&amount=1&decimals=6&recipient=0x0000000000000000000000000000000000000001&slippage=50" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s); const tx=j.transactions?.[0]; const call=j.sendCalls?.calls?.[0]; if(!j.ok) throw new Error(JSON.stringify(j.error)); if(j.sendCalls?.chain !== 'base') throw new Error('missing base sendCalls'); if(!tx || !call || tx.to !== call.to || tx.value !== call.value || tx.data !== call.data) throw new Error('sendCalls mismatch'); if(!/^0x[0-9a-fA-F]*$/.test(call.data) || (call.data.length - 2) % 2) throw new Error('invalid calldata'); console.log('sendCalls ok');})"
```

Keep this terminal open for the full testing session.

### 3 — Open the project root in Cursor

```bash
cd ..
cursor .
```

Open the repo root — not the `server/` subfolder. Cursor needs the root to pick up `.cursor/mcp.json` and `.cursor/rules/`.

### 4 — Confirm Base MCP is connected

Go to **Settings** (`Ctrl+Shift+J`) → **Tools & MCP**. You should see `base-mcp` with a green connected indicator. If it shows disconnected, click the refresh icon next to it or fully restart Cursor.

The `.cursor/mcp.json` in this repo registers Base MCP automatically — no manual configuration needed.

### 5 — Confirm the Hydrex plugin rule is loaded

The plugin spec lives at `.cursor/rules/hydrex.mdc` and loads automatically for every new agent chat in this project. To verify it's active, open a new Agent chat and ask:

```
What Hydrex actions can you help me with?
```

The agent should describe swapping, adding/removing liquidity, and portfolio reads. If it doesn't, restart Cursor and try again with a fresh chat.

---

## Running test prompts

Open a new Agent chat in Cursor. When a write action reaches `send_calls`, the agent will surface a wallet approval link — click it to open the Coinbase popup and approve the transaction.

### Portfolio and positions

```
Show my Hydrex portfolio
Show my Hydrex liquidity positions
Show my Hydrex trade history
```

### Swapping

```
Swap 1 USDC for ETH on Hydrex
Swap 0.01 ETH for USDC on Hydrex with 1% slippage
```

The agent fetches a quote, shows you the output amount and price impact, asks for confirmation, then executes.

### Adding liquidity

```
Add liquidity to the USDC/ETH pool on Hydrex
  pool: 0x<pool_address>
  amounts: 100 USDC and 0.04 ETH
```

If you omit a price range, the agent defaults to ±20% of the current pool price and tells you what it used. The wallet approval batches three calls atomically: approve token0 → approve token1 → mint position.

Pool addresses are available at [hydrex.fi](https://hydrex.fi).

### Removing liquidity

```
Show my Hydrex liquidity positions
Remove liquidity from my Hydrex position #<positionId>
  pool: 0x<pool_address>
```

Always run the positions query first to get your `positionId` values. You can remove a partial percentage or all liquidity (default: 100%).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `base-mcp` shows disconnected | Restart Cursor; confirm you opened the repo root, not a subfolder |
| Agent doesn't know Hydrex actions | Check that `.cursor/rules/hydrex.mdc` exists; start a fresh chat |
| Prepare endpoint 500 errors | Check the `server/` terminal output; most common cause is a bad `BASE_RPC_URL` |
| `send_calls` rejects odd-length hex | Re-fetch `/prepare/*` and submit `response.sendCalls` directly; do not copy or edit `calls[].data` |
| Wallet popup never appears | Ensure a Coinbase Smart Wallet is set up; the popup appears on the first `send_calls` |
| Port 3000 already in use | Set `PORT=3001` in `server/.env` and restart the server |

---

## What's covered in this repo

| File | Purpose |
|---|---|
| `skills/base-mcp/plugins/hydrex.md` | Plugin spec — the source of truth for agent behavior |
| `.cursor/rules/hydrex.mdc` | Plugin spec loaded as a Cursor rule (auto-applied to all agent chats) |
| `server/src/routes/prepare.ts` | Calldata endpoints for swap, liquidity, and staking |
| `server/src/routes/state.ts` | Read endpoints for quotes, portfolio, and positions |
| `.cursor/mcp.json` | Registers Base MCP in Cursor automatically on clone |

For the full endpoint reference and architecture overview, see the [README](./README.md).
