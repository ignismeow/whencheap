# WhenCheap — Complete Build Requirements

> Every package, API key, env var, and integration needed to ship · ETHGlobal Open Agents 2026

---

## Section 1 — Sponsor Integrations

### 1.1 KeeperHub — Transaction Execution Layer

KeeperHub is your execution backbone. It handles gas-aware scheduling, exponential backoff on retries, private mempool routing, and audit logs. You call it via REST API or their MCP server. Your agent creates a workflow, KeeperHub executes it on-chain.

**What KeeperHub does for WhenCheap**

- Receives a workflow definition from your agent (trigger conditions + steps)
- Monitors the trigger condition (gas price, time window, token price)
- Submits the transaction when conditions are met with smart gas estimation
- Retries automatically with exponential backoff if tx is dropped or stuck
- Returns full audit log: submitted hash, confirmation block, gas paid

**Integration method**

- REST API — `POST /workflows` to create, `GET /workflows/:id` to monitor
- MCP server — call `keeperhub.create_workflow()` directly from your agent loop
- x402 micropayment protocol supported — agent can pay per execution

**What you build on top**

- Workflow creation logic: translate parsed intent into KeeperHub workflow JSON
- Status polling loop: check workflow execution every 30s, update your DB state
- Fallback: if KeeperHub returns 5xx, fall back to direct ethers.js RPC submission

**Packages**

| Package | Install | Used for |
|---|---|---|
| `node-fetch / axios` | `npm i axios` | HTTP calls to KeeperHub REST API |
| `@modelcontextprotocol/sdk` | `npm i @modelcontextprotocol/sdk` | If using MCP server path |

**Sample workflow payload**

```http
POST https://api.keeperhub.com/v1/workflows
```

```json
{
  "name": "WhenCheap: swap ETH->USDT",
  "trigger": { "type": "gas_price", "condition": "baseFee < 2000000000" },
  "steps": [
    {
      "action": "uniswap.swap",
      "params": {
        "tokenIn": "ETH",
        "tokenOut": "USDT",
        "amountIn": "0.1",
        "slippage": 0.5
      }
    }
  ],
  "chain": "base",
  "wallet": "0x...",
  "maxGasUSD": 1.00
}
```

---

### 1.2 Uniswap — Swap Routing & Quoting

Uniswap is your swap execution layer. Use the Uniswap Trade API to get quotes across v2, v3, and v4 pools, then submit the best route. The Universal Router handles multi-hop swaps in a single transaction.

**Three Uniswap APIs you use**

- **Trade API (quote endpoint)** — get best route + estimated gas for any token pair
- **Universal Router** — single contract that executes multi-hop swaps on v2/v3/v4
- **v4 SDK** — build pool keys, encode swap params, interact with PoolManager

**Quote API call**

```http
POST https://trade-api.gateway.uniswap.org/v1/quote
Headers: { "x-api-key": "<UNISWAP_API_KEY>" }
```

```json
{
  "type": "EXACT_INPUT",
  "tokenIn": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  "tokenOut": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "tokenInChainId": 1,
  "tokenOutChainId": 1,
  "amount": "100000000000000000",
  "swapper": "0x<USER_WALLET>",
  "routingPreference": "BEST_PRICE",
  "protocols": ["V2", "V3", "V4"],
  "urgency": "normal"
}
```

Response gives you: `amountOut`, route path, estimated gas, price impact, and calldata ready for Universal Router.

**What you build on top**

- Quote aggregator: call Uniswap + 1inch Fusion + CoW Swap in parallel, pick best net output
- Route display: show user the path (ETH → WETH → USDT via Uniswap v3 0.05% pool)
- Slippage guard: set `amountOutMinimum = quote * (1 - slippage)` before submitting
- v4 hook (stretch): gas-aware dynamic fee hook that reduces pool fee when gas is cheap

**Packages**

| Package | Install | Used for |
|---|---|---|
| `@uniswap/v4-sdk` | `npm i @uniswap/v4-sdk` | Pool keys, swap params, v4 encoding |
| `@uniswap/sdk-core` | `npm i @uniswap/sdk-core` | Token, CurrencyAmount, Percent |
| `@uniswap/universal-router-sdk` | `npm i @uniswap/universal-router-sdk` | Build Universal Router calldata |
| `@uniswap/permit2-sdk` | `npm i @uniswap/permit2-sdk` | Permit2 token approval (required for v4) |

**API key:** Register at `developers.uniswap.org` — free tier available. Store as `UNISWAP_API_KEY`.

---

### 1.3 0G Labs — Decentralised AI Inference

0G provides verifiable AI inference running inside Trusted Execution Environments (TEEs). Your agent calls 0G instead of OpenAI for intent parsing and gas prediction — making WhenCheap's AI layer decentralised, privacy-preserving, and cryptographically verified.

**What 0G does for WhenCheap**

- Runs your LLM inference on decentralised hardware (Qwen3, GLM-5, 1M context)
- Every response is signed inside a TEE — cryptographically provable
- OpenAI-compatible API — drop-in replacement, almost no code change
- Supported models: Qwen3-VL-30B, Qwen3.6-Plus, GLM-5

**Integration steps**

1. Install 0G compute CLI and SDK
2. Fund a 0G account with testnet tokens (faucet at `docs.0g.ai`)
3. Acknowledge a provider on-chain: `await broker.inference.acknowledgeProviderSigner(providerAddress)`
4. Get a Bearer token: `0g-compute-cli inference get-secret --provider <ADDR>`
5. Call inference using OpenAI-compatible client pointing to 0G endpoint

**TypeScript integration**

```typescript
import { createServingBroker } from '@0glabs/0g-serving-broker';
import OpenAI from 'openai';

const broker = await createServingBroker(signer, '0x...contractAddress', provider);
await broker.inference.acknowledgeProviderSigner(PROVIDER_ADDRESS);

const client = new OpenAI({
  baseURL: 'https://<0G_PROVIDER_URL>/v1',
  apiKey: ZG_BEARER_TOKEN
});

const response = await client.chat.completions.create({
  model: 'Qwen3-VL-30B-Instruct',
  messages: [{ role: 'user', content: intentPrompt }]
});
```

**What you call 0G for**

- Intent parsing — user's natural language → structured tx object
- Route reasoning — given 4 quotes, which is best for this user's constraints?
- Gas forecast — given last 200 blocks of base fee data, predict next 30 minutes

**Packages**

| Package | Install | Used for |
|---|---|---|
| `@0glabs/0g-serving-broker` | `npm i @0glabs/0g-serving-broker` | On-chain broker, provider ack |
| `crypto-js` | `npm i crypto-js@4.2.0` | Required peer dep of 0G SDK |
| `openai` | `npm i openai` | OpenAI-compatible client for 0G calls |
| `0g-compute-cli` | `npm i -g 0g-compute-cli` | Get Bearer token, test inference |

---

## Section 2 — Supporting APIs & Services

### 2.1 Ethereum RPC — Chain State

| Provider | URL | Free tier |
|---|---|---|
| Alchemy | `alchemy.com/dashboard` | 300M compute units/month |
| Infura | `infura.io` | 100k req/day |

**Endpoints you call:**
`eth_getBalance`, `eth_getTransactionCount`, `eth_gasPrice`, `eth_feeHistory`, `eth_getTransactionReceipt`, `eth_getTransactionByHash`

Use WebSocket (`wss://`) for real-time block subscriptions — cheaper than polling.

| Package | Install | Used for |
|---|---|---|
| `ethers` | `npm i ethers@6` | Provider, wallet, contract interaction |
| `viem` | `npm i viem` | Lightweight alternative for read calls |

---

### 2.2 Gas Oracle — Real-Time Pricing

**Blocknative Gas Platform** — best-in-class, free tier 5k req/day.

```http
GET https://api.blocknative.com/gasprices/blockprices
Headers: { "Authorization": "<BLOCKNATIVE_API_KEY>" }
```

Returns: `baseFeePerGas`, `estimatedPrices` at 70% / 80% / 95% / 99% confidence.

Fallback: `eth_feeHistory` on your RPC if Blocknative is unavailable.

---

### 2.3 1inch Fusion API — Gasless Swap Option

Use when user's wallet has low ETH balance or mainnet gas is high. Resolvers compete via Dutch auction, pay gas on the user's behalf.

- Quote: `GET https://api.1inch.dev/swap/v6.0/1/quote`
- Fusion order: `POST https://api.1inch.dev/orderbook/v4.0/1`
- API key: `portal.1inch.dev` — free

| Package | Install | Used for |
|---|---|---|
| `@1inch/fusion-sdk` | `npm i @1inch/fusion-sdk` | Fusion order creation and signing |

---

### 2.4 CoW Swap API — MEV-Protected Swaps

Best for large swaps. Batch auctions + solver competition. Completely gasless, no API key required.

- Quote: `POST https://api.cow.fi/mainnet/api/v1/quote`
- Order: `POST https://api.cow.fi/mainnet/api/v1/orders`

| Package | Install | Used for |
|---|---|---|
| `@cowprotocol/cow-sdk` | `npm i @cowprotocol/cow-sdk` | Order creation, signing, status |

---

### 2.5 ENS Resolution

Resolve ENS names to addresses (e.g. `vitalik.eth` → `0xd8dA...`). Built into ethers.js — no separate package needed.

```typescript
const address = await provider.resolveName('vitalik.eth');
```

Set content hash on `whencheap.eth` via `app.ens.domains` for Brave browser resolution.

---

### 2.6 Notification Layer

| Method | Service | Free tier |
|---|---|---|
| Email | Resend (`resend.com`) | 100 emails/day |
| Webhook | User-configurable POST | n/a |

| Package | Install | Used for |
|---|---|---|
| `resend` | `npm i resend` | Email notifications on tx events |

---

## Section 3 — Backend Packages (NestJS / TypeScript)

### 3.1 Core Agent Framework

| Package | Install | Used for |
|---|---|---|
| `@nestjs/core` | `npm i @nestjs/core @nestjs/common` | API server framework |
| `@nestjs/schedule` | `npm i @nestjs/schedule` | Cron jobs for gas polling loop |
| `@nestjs/websockets` | `npm i @nestjs/websockets` | Real-time status push to frontend |
| `typescript` | `npm i -D typescript ts-node` | Language runtime |
| `zod` | `npm i zod` | Intent schema validation |
| `dotenv` | `npm i dotenv` | Environment variable loading |

### 3.2 Database

| Package | Install | Used for |
|---|---|---|
| `@nestjs/typeorm` | `npm i @nestjs/typeorm typeorm` | ORM for PostgreSQL |
| `pg` | `npm i pg` | PostgreSQL driver |
| `ioredis` | `npm i ioredis` | Intent queue + session state cache |

**PostgreSQL schema:**
- `intents` — id, wallet, fromToken, toToken, amount, maxFeeUSD, deadline, status, createdAt
- `transactions` — id, intentId, txHash, nonce, gasUsed, feePaid, chain, confirmedAt
- `gas_snapshots` — id, chain, baseFee, timestamp

### 3.3 Blockchain Interaction

| Package | Install | Used for |
|---|---|---|
| `ethers` | `npm i ethers@6` | Wallet, provider, contract calls, signing |
| `viem` | `npm i viem` | Alternative — lighter, faster for read calls |
| `@safe-global/protocol-kit` | `npm i @safe-global/protocol-kit` | EIP-7702 session key management |

### 3.4 Security & Auth

| Package | Install | Used for |
|---|---|---|
| `@nestjs/jwt` | `npm i @nestjs/jwt` | JWT for API authentication |
| `bcrypt` | `npm i bcrypt` | Password hashing for user accounts |
| `helmet` | `npm i helmet` | HTTP security headers |
| `@nestjs/throttler` | `npm i @nestjs/throttler` | Rate limiting on API endpoints |

---

## Section 4 — Frontend Packages (Next.js)

### 4.1 Framework & UI

| Package | Install | Used for |
|---|---|---|
| `next` | `npx create-next-app@latest` | React framework, App Router |
| `tailwindcss` | `npm i tailwindcss` | Utility CSS styling |
| `framer-motion` | `npm i framer-motion` | Streaming reasoning panel animation |
| `lucide-react` | `npm i lucide-react` | Icons |
| `sonner` | `npm i sonner` | Toast notifications on tx events |

### 4.2 Wallet Connection

| Package | Install | Used for |
|---|---|---|
| `wagmi` | `npm i wagmi` | React hooks for Ethereum wallet state |
| `@rainbow-me/rainbowkit` | `npm i @rainbow-me/rainbowkit` | Wallet connect modal UI |
| `viem` | `npm i viem` | Required peer dep of wagmi |
| `@tanstack/react-query` | `npm i @tanstack/react-query` | Required peer dep of wagmi |

### 4.3 Real-Time Updates

| Package | Install | Used for |
|---|---|---|
| `socket.io-client` | `npm i socket.io-client` | WebSocket to NestJS backend |
| `swr` | `npm i swr` | Data fetching / polling for intent status |

---

## Section 5 — Smart Contracts

### 5.1 EIP-7702 Session Permission Contract

Deploy on Sepolia for hackathon demo. Users sign an EIP-7702 authorization delegating scoped permissions here. Every agent-signed transaction is validated before execution.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct SessionPermission {
    uint256 maxFeePerTxWei;    // max gas fee per transaction
    uint256 maxTotalSpendWei;  // total budget for entire session
    uint256 spentWei;          // running total spent so far
    uint256 expiresAt;         // unix timestamp
    address[] allowedTokens;   // whitelist (empty = all tokens allowed)
}

mapping(address => SessionPermission) public sessions;

function canExecute(address wallet, uint256 feeWei) public view returns (bool) {
    SessionPermission memory s = sessions[wallet];
    return block.timestamp < s.expiresAt
        && feeWei <= s.maxFeePerTxWei
        && s.spentWei + feeWei <= s.maxTotalSpendWei;
}
```

**Toolchain**

| Package | Install | Used for |
|---|---|---|
| `foundry` | `curl -L https://foundry.paradigm.xyz \| bash` | Solidity compile, test, deploy |
| `@openzeppelin/contracts` | `npm i @openzeppelin/contracts` | ReentrancyGuard, Ownable |

### 5.2 Uniswap v4 Gas-Aware Hook *(Stretch Goal — days 8–9)*

A custom v4 hook that dynamically adjusts swap fees based on current gas. When gas is cheap, fees drop. When congested, fees rise to compensate for execution cost. Targets the Uniswap Foundation prize specifically.

- Implement `BaseHook` from `@uniswap/v4-periphery`
- Override `beforeSwap` to read current `baseFee` and adjust pool fee dynamically
- Deploy to Sepolia, register with PoolManager, create ETH/USDT pool with your hook

> Build this only if core product is complete and stable by day 7.

---

## Section 6 — Environment Variables

### 6.1 Backend `.env`

| Variable | Example value | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis for intent queue + cache |
| `JWT_SECRET` | random 64-char hex | API authentication |
| `ALCHEMY_API_KEY` | `abc123...` | Ethereum RPC provider |
| `ALCHEMY_WS_URL` | `wss://eth-mainnet...` | WebSocket for block subscriptions |
| `KEEPERHUB_API_KEY` | `khub_...` | KeeperHub workflow creation |
| `KEEPERHUB_API_URL` | `https://api.keeperhub.com` | KeeperHub base URL |
| `UNISWAP_API_KEY` | `uni_...` | Uniswap Trade API quotes |
| `ZG_PROVIDER_ADDRESS` | `0x...` | 0G Labs inference provider address |
| `ZG_BEARER_TOKEN` | `app-sk-...` | 0G inference auth token |
| `ZG_CONTRACT_ADDRESS` | `0x...` | 0G compute contract on-chain |
| `ONEINCH_API_KEY` | `1inch_...` | 1inch Fusion quotes |
| `BLOCKNATIVE_API_KEY` | `bn_...` | Gas oracle pricing data |
| `RESEND_API_KEY` | `re_...` | Email notifications |
| `AGENT_WALLET_PK` | `0x...` | Hot wallet for gas on fallback path |
| `SESSION_CONTRACT_ADDR` | `0x...` | Deployed EIP-7702 session contract |
| `NETWORK` | `sepolia` | Target network (sepolia for demo) |

### 6.2 Frontend `.env.local`

| Variable | Example value | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Backend NestJS base URL |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3001` | WebSocket for live status |
| `NEXT_PUBLIC_CHAIN_ID` | `11155111` | 11155111 = Sepolia, 1 = mainnet |
| `NEXT_PUBLIC_WALLETCONNECT_ID` | `wc_...` | WalletConnect project ID |
| `NEXT_PUBLIC_SESSION_CONTRACT` | `0x...` | EIP-7702 contract address |
| `NEXT_PUBLIC_ALCHEMY_KEY` | `abc123...` | Public RPC for wagmi |

---

## Section 7 — Repo Structure & Day One Setup

### 7.1 Monorepo Structure

```
whencheap/
  apps/
    api/                  # NestJS backend (agent + REST API)
      src/
        intents/          # IntentModule — parse, store, manage intents
        agent/            # AgentModule — ReAct loop, tool registry
        tools/            # gas-oracle.ts, keeperhub.ts, uniswap.ts,
                          #   oneinch.ts, cowswap.ts, l2-router.ts
        transactions/     # TxModule — state machine, nonce manager
        notifications/    # NotificationModule — email + webhook
        zerogee/          # ZeroGeeModule — 0G inference client
      .env
    frontend/             # Next.js UI
      app/
        page.tsx          # Intent input + agent reasoning panel
        status/           # Live transaction status view
      .env.local
  contracts/              # Foundry project
    src/
      WhenCheapSession.sol
      GasAwareHook.sol    # stretch goal
    test/
    script/               # Deploy scripts
  docker-compose.yml      # PostgreSQL + Redis
  README.md
```

### 7.2 Day One Commands (April 25)

**Spin up infrastructure**
```bash
docker-compose up -d   # starts PostgreSQL on 5432, Redis on 6379
```

**Bootstrap API**
```bash
cd apps/api
npm i @nestjs/cli -g && nest new . --skip-git
npm i ethers@6 viem axios zod ioredis typeorm pg @nestjs/typeorm
npm i @nestjs/jwt @nestjs/schedule @nestjs/websockets socket.io
npm i @0glabs/0g-serving-broker crypto-js@4.2.0 openai
npm i @uniswap/v4-sdk @uniswap/sdk-core @uniswap/universal-router-sdk
npm i @cowprotocol/cow-sdk @1inch/fusion-sdk
npm i resend helmet @nestjs/throttler
```

**Bootstrap frontend**
```bash
cd apps/frontend
npx create-next-app@latest . --typescript --tailwind --app
npm i wagmi viem @tanstack/react-query @rainbow-me/rainbowkit
npm i framer-motion lucide-react sonner socket.io-client swr
```

**Bootstrap contracts**
```bash
cd contracts
forge init --no-git
forge install OpenZeppelin/openzeppelin-contracts
# copy WhenCheapSession.sol into src/
forge test && forge deploy --rpc-url $SEPOLIA_RPC
```

### 7.3 API Keys to Register on Day One

| Service | Where to register | Free tier? |
|---|---|---|
| Alchemy RPC | `alchemy.com/dashboard` | ✅ 300M CU/month |
| KeeperHub | `app.keeperhub.com` | Email them for hackathon access |
| Uniswap Trade API | `developers.uniswap.org` | ✅ Free tier |
| 0G Labs | `docs.0g.ai` / testnet faucet | ✅ Testnet tokens free |
| 1inch | `portal.1inch.dev` | ✅ Free tier |
| Blocknative Gas | `explorer.blocknative.com` | ✅ 5k req/day free |
| WalletConnect | `cloud.walletconnect.com` | ✅ Free |
| Resend Email | `resend.com` | ✅ 100 emails/day free |

---

*WhenCheap · Build Requirements · ETHGlobal Open Agents 2026 · Start: April 25*