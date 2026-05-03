# ETHGlobal OpenAgents 2026 — Project Submission

## Project Name
WhenCheap

## Tagline
Execute Ethereum transactions at the cheapest possible gas — automatically.

---

## Description (Short — for ETHGlobal listing)

WhenCheap is a gas-aware intent execution agent for Ethereum. Users describe what they want in plain English — "swap 0.001 ETH to USDC when gas is under $2" — and the agent monitors gas prices and executes the transaction at the optimal moment.

Built on EIP-7702 session authorization, every swap executes atomically in a single transaction: fees collected on-chain, Uniswap routing via `/swap_7702`, and USDC landing directly in the user's wallet. No approvals, no post-swap transactions, no nonce conflicts.

Intent parsing runs on 0G's TEE-verified inference network (Qwen-2.5-7b), making every routing decision cryptographically verifiable. `whencheap.eth` serves as the agent's on-chain identity.

---

## Description (Long — for ETHGlobal project page)

### The Problem

Ethereum gas fees vary by 10-30x depending on time of day and network congestion. A swap that costs $0.50 at 4 AM costs $15 during peak hours — same transaction, same tokens, 30x the price. Regular users have no tools to act on this. They manually check gas trackers, set phone reminders, and still often pay too much or miss the window entirely.

Gas fee UX is broken. The tools that exist (gas trackers, alert services) tell you when gas is cheap but don't act on it. The user still has to be awake, available, and fast enough to submit the transaction before the window closes.

WhenCheap solves this with a fully autonomous agent that monitors, decides, and executes — without the user needing to do anything after setting the intent.

### What We Built

WhenCheap is a full-stack agent system:

**Intent Layer** — Users type plain English intents. 0G's TEE inference network (Qwen-2.5-7b via the 0G Compute Router) parses them into structured transaction objects. Every parse is cryptographically verifiable inside a Trusted Execution Environment.

**Gas Intelligence Layer** — The agent polls Alchemy (`eth_feeHistory`) and Etherscan Gas Oracle every 30 seconds. Gas snapshots are persisted to PostgreSQL, enabling historical pattern analysis (cheapest hours by day of week, 1h/24h/7d averages). A dedicated Gas Analytics page visualizes this data in real time.

**Execution Layer** — When gas drops below the user's limit, the agent executes via EIP-7702:
1. User wallet signs an authorization delegating to `WhenCheapSession.sol`
2. Agent submits an EIP-7702 type-4 transaction
3. `executeSwap()` atomically deducts protocol fees and calls Uniswap's `/swap_7702` endpoint
4. Output tokens land directly in the user's wallet
5. On-chain `FeeCollected` events serve as verifiable proof

The entire execution is one transaction. No approval transactions, no post-swap fee collection, no nonce conflicts from parallel transactions.

**Conversation UI** — A chat interface where users interact with WhenCheap as an AI agent. The agent confirms parsed intent details, shows real-time gas cost before confirmation, and provides live status updates as execution progresses.

### Technical Highlights

**EIP-7702 throughout** — `WhenCheapSession.sol` is designed specifically for EIP-7702's storage constraints (immutable `agentAddress`). Every swap transaction is labeled "EIP-7702 delegate" on Etherscan. We use Uniswap's `/swap_7702` endpoint with the `delegation` field set to our contract address for optimized calldata.

**Atomic executeSwap** — The custom `executeSwap(address swapRouter, bytes calldata)` function collects fees via `_collectFees()` and forwards net ETH to Uniswap in a single call. This eliminates the nonce conflict problem that plagued earlier architectures where fee collection and execution were separate transactions.

**Decentralised AI** — Intent parsing uses 0G's Compute Router (TEE-verified Qwen-2.5-7b). The agent falls back to Groq (llama-3.3-70b) and finally a deterministic regex parser. The system never fails to parse — and the primary path is cryptographically verifiable.

**ENS identity** — `whencheap.eth` is registered on mainnet and shows as the sender on all mainnet transactions. ENS resolution is built into the intent parser — users can type `vitalik.eth` as the recipient.

### Sponsor Integrations

**Uniswap Foundation** — All swap routing uses the Uniswap Trading API. We use `/swap_7702` as the primary endpoint, passing `WhenCheapSession.sol` as the `delegation` field. This produces EIP-7702-optimized calldata that batches approval and swap. Detailed integration feedback in `FEEDBACK_UNISWAP.md`.

**0G Labs** — Intent parsing runs on 0G's Compute Router using TEE-verified inference. Every routing decision is cryptographically signed inside an Intel TDX TEE. Code in `zg-inference.service.ts`.

**ENS** — `whencheap.eth` serves as the agent's on-chain identity. ENS names resolve in recipient fields. The agent's ENS name is logged and displayed on every mainnet execution.

**KeeperHub** — Integrated as transaction relay exploration. Detailed feedback on API issues discovered during integration in `FEEDBACK_KEEPERHUB.md`.

### What's Live

- Mainnet contract: `0x3CAD995494954a8197391c4194Bd39E2Eda16274`
- Sepolia contract: `0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e`
- Confirmed swaps on Sepolia with real USDC received
- Gas Analytics page with live DB-backed charts
- Google OAuth + managed wallet flow
- Multi-token support: ETH→USDC, ETH→DAI, ETH send, ERC-20 send

---

## Prize Tracks

- Uniswap Foundation — EIP-7702 swap integration via `/swap_7702`
- 0G Labs — Decentralised TEE inference for intent parsing
- ENS — Agent identity + ENS recipient resolution
- KeeperHub — Integration + feedback

---

## Links

- **GitHub:** https://github.com/saadaltafofficial/whencheap
- **ENS:** whencheap.eth
- **Demo video:** [Loom link]
- **Mainnet contract:** https://etherscan.io/address/0x3CAD995494954a8197391c4194Bd39E2Eda16274
- **Sepolia contract:** https://sepolia.etherscan.io/address/0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e
- **Sample tx (EIP-7702 swap):** https://sepolia.etherscan.io/tx/0x19f59f30a22675b8f35315d1a70f3c800f8e7da0cc2c379cbe88ece9580c14b3
