# WhenCheap ⛽

> **Execute Ethereum transactions at the cheapest possible gas — automatically.**

WhenCheap is a gas-aware intent execution agent. Tell it what you want in plain English. It monitors gas prices and executes your transaction at the optimal moment — atomically, with on-chain fee proof.

**Live demo:** [whencheap.eth](https://whencheap.eth)
**Mainnet contract:** `0xA928D43DEA05e2ce4Af9208150468d472932bB74`
**Sepolia contract:** `0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e`

---

## The Problem

Ethereum gas fees are unpredictable. A simple token swap can cost $0.50 at 3 AM or $15 during peak hours — the same transaction, 30x the cost. Regular users have no tools to act on this. They manually check gas trackers, set reminders, and still often pay too much.

Gas fee UX is broken. WhenCheap fixes it.

---

## How It Works

```
User: "Swap 0.001 ETH to USDC when gas is under $2 on Sepolia"
         ↓
  0G TEE Inference (Qwen-2.5-7b) parses intent
         ↓
  Agent monitors gas every 30 seconds
         ↓
  Gas drops below $2 limit
         ↓
  EIP-7702 session executes swap atomically:
    → WhenCheapSession.executeSwap() called
    → Fee collected (agent + treasury) on-chain
    → Uniswap /swap_7702 routes ETH → USDC
    → USDC lands in user wallet
         ↓
  User sees: "🎉 8.636 USDC received in block 10765210"
```

One transaction. Atomic. Verifiable. No post-swap fee collection. No nonce conflicts.

---

## Key Features

- **Natural language intents** — "Send 0.01 ETH to vitalik.eth when gas < $1"
- **Gas intelligence** — Real-time monitoring, historical patterns, cheapest hour predictions
- **EIP-7702 execution** — User wallet acts as its own smart account via delegation
- **Atomic swap + fees** — Single transaction handles everything including protocol fees
- **Multi-token support** — ETH→USDC, ETH→DAI, ETH→USDT, ETH send, ERC-20 send
- **ENS resolution** — Send to `vitalik.eth`, agent resolves to address automatically
- **Conversational UI** — Chat interface with live execution status updates
- **Gas Analytics page** — Live base fee chart, price tiers, cheapest hours (DB-backed)
- **Decentralised AI** — Intent parsing via 0G TEE-verified inference (Groq fallback)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Next.js Frontend                   │
│  Chat UI · Gas Analytics · Command Center · Audit   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                  NestJS API                          │
│                                                      │
│  Intent Parser ──→ 0G Inference (Qwen-2.5-7b)       │
│       │            └→ Groq fallback                  │
│       │            └→ Regex fallback                 │
│       ▼                                              │
│  Gas Monitor ──→ Alchemy eth_feeHistory              │
│       │         └→ Etherscan Gas Oracle              │
│       │         └→ PostgreSQL (30s snapshots)        │
│       ▼                                              │
│  Session Signer ──→ EIP-7702 type-4 tx              │
│       │             └→ WhenCheapSession.sol          │
│       ▼                                              │
│  Uniswap Router ──→ Trading API /quote               │
│                     └→ /swap_7702 (EIP-7702)        │
└─────────────────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│              WhenCheapSession.sol                    │
│                                                      │
│  executeSwap(swapRouter, calldata)                   │
│    → _collectFees() [atomic, on-chain]               │
│    → swapRouter.call{value: netAmount}(calldata)     │
│                                                      │
│  execute(to, value, data)    ← for ETH/token sends  │
│  authorize() / revokeSession()                       │
│  canExecute() / recordSpend()                        │
└─────────────────────────────────────────────────────┘
```

---

## Sponsor Integrations

### Uniswap Foundation
- **Trading API** (`/quote` + `/swap_7702`) for all swap routing
- **`/swap_7702` endpoint** — EIP-7702 optimized calldata with `delegation` field pointing to `WhenCheapSession.sol`
- **SwapRouter02 + Universal Router** for on-chain execution
- **Atomic fee collection** inside `executeSwap()` before forwarding to Uniswap
- See [`FEEDBACK_UNISWAP.md`](./FEEDBACK_UNISWAP.md) for integration feedback

### 0G Labs
- **0G Compute Router** for decentralised TEE-verified AI inference
- Intent parsing runs on `qwen/qwen-2.5-7b-instruct` via 0G's network
- Every intent parse is cryptographically verifiable — not just "AI said so"
- Fallback chain: `0G → Groq → Regex` (always works)
- Code: [`zg-inference.service.ts`](./apps/api/src/modules/intents/zg-inference.service.ts)

### ENS
- `whencheap.eth` registered as agent identity on mainnet
- Shows as sender on Etherscan for all mainnet transactions
- ENS resolution in recipient field — users can type `vitalik.eth` instead of `0x...`
- Agent's ENS name logged on startup via `provider.lookupAddress()`

### KeeperHub
- Integrated as transaction relay layer (Direct Execution API)
- Explored MCP server path for agent tool integration
- See [`FEEDBACK_KEEPERHUB.md`](./FEEDBACK_KEEPERHUB.md) for detailed feedback

---

## Smart Contracts

### WhenCheapSession.sol

Deployed on both networks:
- **Sepolia:** [`0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e`](https://sepolia.etherscan.io/address/0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e)
- **Mainnet:** [`0xA928D43DEA05e2ce4Af9208150468d472932bB74`](https://etherscan.io/address/0xA928D43DEA05e2ce4Af9208150468d472932bB74)

Key design decisions:
- `agentAddress` is **immutable** — required for EIP-7702 (storage reads zero via delegation)
- `executeSwap()` atomically collects fees AND executes swap in one call
- `_collectFees()` splits to agent + treasury on every execution
- OZ `ReentrancyGuard` + `Pausable`
- `feeBps=30` (0.3%), `agentFeeSplit=50` (50/50 agent/treasury)

```solidity
function executeSwap(
    address swapRouter,
    bytes calldata swapCalldata
) external payable nonReentrant whenNotPaused {
    if (msg.sender != agentAddress) revert OnlyAgent();
    (, , uint256 netAmount) = _collectFees(msg.value);
    (bool success,) = swapRouter.call{value: netAmount}(swapCalldata);
    if (!success) revert ExecutionFailed(0);
    emit Executed(address(this), swapRouter, netAmount, swapCalldata);
}
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Backend | NestJS, TypeScript |
| Database | PostgreSQL (intents, wallets, sessions, gas snapshots) |
| Cache | Redis |
| Contracts | Solidity 0.8.24, Foundry |
| EVM | viem 2.48, ethers v6 |
| AI Inference | 0G Compute Router → Groq (llama-3.3-70b) → Regex |
| Gas Data | Alchemy `eth_feeHistory` + Etherscan Gas Oracle |
| Swap Routing | Uniswap Trading API |
| Auth | Google OAuth + AES-256-GCM encrypted managed wallets |
| Infra | Docker Compose |

---

## EIP-7702 Implementation

WhenCheap uses EIP-7702 type-4 transactions throughout:

```
1. User wallet signs authorization for WhenCheapSession contract
2. Agent submits type-4 tx with authorizationList
3. User wallet is temporarily delegated to WhenCheapSession
4. executeSwap() runs as if called on the user wallet
5. Fees deducted, swap executed, USDC arrives in user wallet
6. Delegation expires after tx
```

Etherscan labels these as **"EIP-7702: [user wallet] Delegate to [WhenCheapSession]"** — visible in the Authorizations tab of every swap transaction.

---

## Getting Started

```bash
# Clone
git clone https://github.com/saadaltafofficial/whencheap
cd whencheap

# Install
npm install

# Configure
cp apps/api/.env.example apps/api/.env
# Fill in: RPC_URL, AGENT_WALLET_PK, ENCRYPTION_KEY, 
#          UNISWAP_API_KEY, ZG_API_KEY, GROQ_API_KEY,
#          GOOGLE_CLIENT_ID, ETHERSCAN_API_KEY

# Run
docker compose up -d

# Open
open http://localhost:3000
```

---

## Try It

```
Swap 0.001 ETH to USDC when gas is under $2 on Sepolia
Send 0.001 ETH to 0x9dD40426fe0dbaF3d28B4fe7f499231e6FFd3873 when gas < $1
Swap 0.001 ETH to DAI when gas is under $5 on Sepolia in next 30 minutes
Send 1 DAI to vitalik.eth when gas is cheap on Sepolia
```

---

## Confirmed Working Transactions

| Type | Chain | Tx Hash | Result |
|------|-------|---------|--------|
| ETH→USDC swap | Sepolia | [0x19f59f30...](https://sepolia.etherscan.io/tx/0x19f59f30a22675b8f35315d1a70f3c800f8e7da0cc2c379cbe88ece9580c14b3) | 8.636 USDC ✓ |
| ETH→USDC swap | Sepolia | [0xf4f32e90...](https://sepolia.etherscan.io/tx/0xf4f32e9041219fd492230e4fa02dcd01666f2fe06351fbf8d341698387185774) | 8.636 USDC ✓ |
| ETH send | Sepolia | Multiple | ✓ |
| DAI send | Sepolia | Multiple | ✓ |
| Mainnet contract | Mainnet | Deployed | ✓ |

---

## Team

**Saad Altaf** — Full-stack + DevOps + Smart Contracts
- GitHub: [@saadaltafofficial](https://github.com/saadaltafofficial)
- ENS: whencheap.eth

---

## License

MIT