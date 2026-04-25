# WhenCheap — Edge Case & Failure Mode Defense

> How WhenCheap handles everything that can go wrong · ETHGlobal Open Agents 2026

This document maps every significant failure scenario the WhenCheap agent can encounter, explains precisely what happens at the protocol level, and describes how the system handles it. Use this as a reference during live judging, investor Q&A, or technical review.

---

## Section 1 — The Nonce Collision Problem

Every Ethereum wallet has a single sequential nonce counter shared across all transactions — whether submitted by the user manually or by the WhenCheap agent. There is no lane separation at the protocol level. This is the most technically nuanced failure mode in the entire system.

### Background: How Ethereum Nonces Work

When a transaction is submitted to Ethereum, the network assigns it a nonce equal to the number of confirmed transactions from that address. Transactions must be processed in strict nonce order. If nonce 47 is pending, nonce 48 cannot confirm until 47 is resolved. This is by design — it prevents double-spends.

This becomes a problem when two actors — the user and the WhenCheap agent — share the same wallet and submit transactions independently.

---

### Scenario 1A — User sends manual tx while agent holds a pending intent

> **STATUS: HANDLED — agent detects and resubmits with updated nonce**

| | |
|---|---|
| **What happens** | Agent is holding a pending intent at nonce 47, waiting for gas to drop below $1. User opens MetaMask and manually sends ETH — MetaMask assigns nonce 47 and the tx confirms. Agent's nonce 47 intent is now invalid. |
| **How agent detects it** | Agent polls the wallet's confirmed nonce every 30 seconds via `eth_getTransactionCount(address, 'latest')`. When confirmed nonce increments past the agent's held nonce, it knows the slot was consumed by an external transaction. |
| **What agent does** | Agent re-evaluates the intent: is the original recipient address still valid? Is the user's balance still sufficient? If yes — resubmit the intent with the new nonce (48). Notifies user: "Your manual transaction was detected. Your WhenCheap intent has been rescheduled with an updated nonce." |
| **What user sees** | A notification. No frozen wallet. No lost transaction. The intent continues executing autonomously toward the original goal. |
| **Edge case within this** | If the user's manual tx reduced the wallet balance below the intent amount, the agent cancels the intent and notifies: "Insufficient balance after your recent transaction. Please update your intent." |

---

### Scenario 1B — Agent and user submit transactions simultaneously (race condition)

> **STATUS: HANDLED — one wins, one gets resubmitted**

| | |
|---|---|
| **What happens** | Both the agent and the user submit a transaction in the same ~12 second block window. Both attempt to use nonce 47. Only one can confirm. The other is dropped from the mempool. |
| **How Ethereum resolves it** | The transaction with the higher effective gas price (base fee + priority tip) wins the block. The other is dropped. There is no error thrown — the dropped tx simply disappears from the mempool. |
| **How agent detects the race** | Agent monitors its submitted tx hash. If the hash disappears from mempool without confirming (detectable via `eth_getTransactionByHash` returning null) and the confirmed nonce has advanced, it knows it lost the race. |
| **What agent does** | Resubmit intent with nonce 48. Log the race event in the audit trail. Notify user: "A nonce collision occurred — your manual transaction took priority. Your WhenCheap intent has been rescheduled." |
| **Prevention strategy** | WhenCheap UI shows a live indicator: "Agent is actively holding nonce 47." This warns the user before they open MetaMask. A soft lock warning — not a hard block, user can always override. |

---

### Scenario 1C — User wants to send multiple manual transactions while agent is active

> **STATUS: HANDLED — via nonce reservation system**

| | |
|---|---|
| **The deeper problem** | If the agent holds nonce 47 indefinitely waiting for cheap gas, and the user needs to send 3 urgent transactions, the user cannot advance past nonce 47. Their wallet is effectively soft-locked. |
| **WhenCheap's solution** | The agent maintains a "nonce reservation" with a configurable hold timeout (default: 2 hours). If the user signals urgency — either via the UI or by submitting a manual tx — the agent detects the conflict and temporarily yields its nonce slot. |
| **How yielding works** | Agent submits a zero-value self-transfer (to own address, 0 ETH) with its held nonce and a high priority fee. This consumes the nonce slot immediately and costs ~$0.01. Agent then takes the next available nonce. The user's queue is unblocked. |
| **Cost of yielding** | ~$0.01 gas for the self-transfer. WhenCheap absorbs this cost. It is logged in the audit trail as "nonce yield event." |
| **User control** | UI has a prominent "Release nonce" button when the agent is holding an active intent. One tap unblocks the wallet instantly. The intent is rescheduled automatically. |

---

## Section 2 — Transaction Execution Failures

Beyond nonce conflicts, transactions can fail at multiple stages of the execution pipeline. Each stage requires a different recovery strategy.

---

### Scenario 2A — Transaction stuck in mempool — gas price moved up after submission

> **STATUS: HANDLED — automatic speed-up via replacement transaction**

| | |
|---|---|
| **What happens** | Agent submits tx at what appeared to be a good gas price. Network congestion spikes within the next few blocks. Validators now ignore the tx because higher-tipped transactions fill the blocks. |
| **Detection** | Agent monitors tx confirmation status every block (~12 seconds). If tx is unconfirmed after 3 blocks and mempool gas price has risen more than 20% above the submitted price, it triggers a speed-up. |
| **Speed-up mechanism** | Resubmit the identical transaction (same nonce, same recipient, same value) with a priority fee at least 10% higher than the current pending tx. Ethereum nodes accept this as a replacement. The old tx is evicted from the mempool. EIP-1559 enforces minimum 10% bump. |
| **Escalation logic** | If still unconfirmed after 3 more blocks, bump again by 15%. Then 20%. Cap at the user's stated maximum fee. If cap is reached before confirmation, move to Scenario 2C. |
| **User visibility** | Live status in UI: "Your transaction is taking longer than expected. I've increased the priority fee to $0.42 to speed it up. Still within your $1 limit." |

---

### Scenario 2B — Transaction dropped from mempool — node eviction

> **STATUS: HANDLED — drop detection + clean resubmission**

| | |
|---|---|
| **What happens** | Most Ethereum full nodes evict pending transactions after 3 hours if unconfirmed. Some nodes have mempool size limits and evict low-fee transactions during congestion. The tx hash simply disappears — no error, no notification. |
| **Detection** | Agent calls `eth_getTransactionByHash` every 5 minutes for any pending tx. If the call returns null AND the nonce has not advanced (confirmed nonce is still below the dropped tx's nonce), the tx was dropped — not confirmed, not replaced. |
| **Recovery** | Resubmit from scratch with current market gas price. New tx hash, same intent. Agent checks whether the user's deadline has passed before resubmitting. If deadline is within 10 minutes, escalate gas aggressively. |
| **Why this is safe** | A dropped transaction never executed. No ETH moved. The nonce slot is still free. Resubmission is always safe as long as the wallet balance is intact. |

---

### Scenario 2C — Deadline passes before transaction confirms

> **STATUS: HANDLED — clean cancellation + wallet unblock**

| | |
|---|---|
| **What happens** | The user set a deadline of 3 hours. Gas stayed high for the full 3 hours. The agent could not execute within the user's stated fee constraints. Deadline expires with tx still pending or never submitted. |
| **What agent does immediately** | If a tx was submitted but not confirmed: agent sends a cancellation — zero-value self-transfer with the same nonce and a high priority fee. This burns the nonce slot and removes the pending tx. Cost: ~$0.01. Wallet is fully unblocked. |
| **If no tx was submitted yet** | Agent simply marks the intent as EXPIRED. No on-chain action needed. No gas consumed. Wallet is untouched. |
| **User notification** | "Your intent expired. Current gas is still $2.80 — above your $1 limit. Want to retry with a higher fee limit or a longer window? Here are the last 6 hours of gas data to help you decide." |
| **Audit trail** | Full log: intent created, gas checks every 5 minutes, each check result, cancellation tx hash. User can download this as a receipt. |

---

### Scenario 2D — Transaction confirmed then undone by chain reorganisation

> **STATUS: HANDLED — finality monitoring before marking complete**

| | |
|---|---|
| **What is a reorg** | Occasionally two miners find valid blocks simultaneously. The network temporarily has two competing chain tips. One chain wins — the other is orphaned. Transactions in the orphaned block are unconfirmed and return to the mempool. |
| **How common** | 1-block reorgs happen ~3–5 times per day on Ethereum mainnet. 2-block reorgs are rare. Anything deeper than 3 blocks is extremely rare post-Merge. |
| **WhenCheap's response** | Agent does not mark a transaction COMPLETE until it has 12 confirmations (~2.5 minutes of finality). Only after 12 blocks does the UI show the green confirmation receipt. |
| **If a reorg hits before 12 confirmations** | Agent detects that the tx has dropped below the confirmation threshold. Treats this identically to Scenario 2B — drop detected, resubmit. User is notified that confirmation was delayed due to a chain reorganisation. |

---

## Section 3 — EIP-7702 Session Signing Scenarios

EIP-7702 scoped session permissions introduce their own class of edge cases around authorisation expiry, scope violations, and concurrent signing contexts.

---

### Scenario 3A — User's manual transaction conflicts with agent's EIP-7702 session

> **STATUS: BY DESIGN — coexistence is fully supported**

| | |
|---|---|
| **The key clarification** | EIP-7702 does not lock the wallet. The user can still send manual transactions at any time using MetaMask or any other wallet interface. The session key only grants the agent additional signing authority — it does not restrict the owner's authority. |
| **How coexistence works** | The user's EOA master key can always override. If the user sends a manual tx, it is processed normally. The agent's session is not revoked. Both can operate concurrently — the only shared resource is the nonce (handled by Section 1). |
| **What the session contract enforces** | Every transaction the agent signs is checked against the session permission struct: max fee per tx, max total session spend, expiry timestamp, optional recipient whitelist. The user's manual transactions are not subject to these checks — only agent-signed transactions are. |

---

### Scenario 3B — EIP-7702 session expires mid-execution

> **STATUS: HANDLED — agent detects expiry before submission**

| | |
|---|---|
| **What happens** | User granted a 6-hour session. The agent finds a good gas window at hour 5:58. It constructs the transaction and attempts to sign using the session key. The session expires at hour 6:00 before the tx is submitted. |
| **Prevention** | Agent checks session expiry timestamp before every signing attempt. If less than 5 minutes remain, agent flags the intent as PENDING_REAUTHORIZATION and notifies the user to renew rather than attempting a transaction that may fail. |
| **If expiry hits mid-submission** | The EIP-7702 session contract rejects the transaction at the EVM level — the agent's signature is invalid after expiry. No gas is consumed (tx reverts before execution). Agent detects the rejection, marks intent as NEEDS_REAUTHORIZATION, notifies user. |
| **User experience** | "Your session expired before I could execute. Please re-authorise for another session to continue. Your intent is saved and will execute as soon as you approve." |

---

### Scenario 3C — Agent attempts a transaction that exceeds session fee limit

> **STATUS: BLOCKED BY CONTRACT — on-chain enforcement**

| | |
|---|---|
| **What happens** | Gas spikes unexpectedly. To confirm the transaction before the deadline, the agent calculates it needs to pay $1.80. The user's session permission caps fees at $1.00. |
| **What the contract does** | The WhenCheap session contract checks the fee against `maxFeePerTx` before signing. The check fails. The transaction is NOT submitted. No gas is wasted. This is enforced at the EVM level — no amount of agent-side bugs can override it. |
| **User notification** | "Gas is currently $1.80 — above your $1.00 limit. I can wait for it to drop, or you can increase your fee limit. Your deadline is in 47 minutes." |
| **The trust guarantee** | This is the core security property of EIP-7702 in WhenCheap: the agent is mathematically incapable of spending more than the user authorised. Not just by policy — by smart contract logic. This is what separates WhenCheap from any agent that holds a raw private key. |

---

## Section 4 — Infrastructure & External Dependency Failures

WhenCheap depends on external services: KeeperHub for execution, Blocknative for gas data, and Ethereum RPC nodes for chain state. Each can fail.

---

### Scenario 4A — KeeperHub API is unavailable

> **STATUS: HANDLED — fallback to direct RPC submission**

| | |
|---|---|
| **What happens** | KeeperHub returns a 5xx error or times out. The scheduled workflow cannot be created or the pending execution cannot be triggered. |
| **Fallback strategy** | WhenCheap maintains a direct ethers.js RPC execution path as a fallback. If KeeperHub is unavailable, the agent submits the transaction directly via the configured RPC endpoint (Alchemy or Infura). This path lacks KeeperHub's advanced features (private routing, mempool simulation) but guarantees execution. |
| **User notification** | "Executing via backup path. Your transaction may be slightly less optimised but will still confirm." |
| **Recovery** | Once KeeperHub comes back online, all new intents route through it again. In-flight fallback transactions are monitored directly via RPC. |

---

### Scenario 4B — Gas oracle data is stale or unavailable

> **STATUS: HANDLED — conservative fallback pricing**

| | |
|---|---|
| **What happens** | Blocknative API returns stale data or goes offline. The agent cannot get a reliable current gas price. |
| **Fallback** | Agent falls back to `eth_gasPrice` and `eth_feeHistory` from the RPC node directly. Less accurate (no next-block prediction) but always available as long as the node is reachable. |
| **Conservative mode** | When oracle data quality is uncertain, the agent only submits if the on-chain base fee is comfortably below the user's limit (50% margin). It does not attempt to optimise timing — it waits for oracle data to recover. |
| **User notification** | "Gas data is limited right now. I'm being conservative and will wait until I have reliable pricing before executing." |

---

### Scenario 4C — L2 bridge or destination chain is experiencing an outage

> **STATUS: HANDLED — automatic fallback to mainnet or alternative L2**

| | |
|---|---|
| **What happens** | Agent decides to route through Base L2 to save fees. Base sequencer is down or experiencing unusual latency. |
| **Detection** | Agent checks L2 sequencer health endpoint before routing. Base, Arbitrum, and Optimism all expose public sequencer status APIs. |
| **Fallback chain priority** | Base (primary) → Arbitrum → Optimism → mainnet. Agent routes to the next healthy option. If all L2s are degraded and mainnet fee exceeds user's limit, agent waits and notifies. |
| **User notification** | "Base is experiencing delays. I've rerouted to Arbitrum where fees are $0.006. Proceeding with execution." |

---

## Section 5 — User Behaviour Edge Cases

---

### Scenario 5A — User drains wallet balance after submitting an intent

> **STATUS: HANDLED — balance check before every execution attempt**

| | |
|---|---|
| **What happens** | User submits intent: send 0.1 ETH. Later manually sends 0.09 ETH elsewhere. Wallet now has 0.02 ETH — insufficient for the intent plus gas. |
| **Detection** | Before every execution attempt, agent checks current wallet balance via `eth_getBalance`. If balance is below (intent amount + estimated gas + 10% buffer), agent pauses and notifies. |
| **User notification** | "Insufficient balance to execute your intent. You need at least 0.105 ETH (0.1 + gas). Current balance: 0.02 ETH. Top up your wallet or cancel this intent." |
| **Intent state** | Moves to `INSUFFICIENT_BALANCE`. Resumes automatically if balance is topped up before deadline. |

---

### Scenario 5B — User cancels intent after transaction is already in mempool

> **STATUS: HANDLED — best-effort cancellation**

| | |
|---|---|
| **What happens** | User hits cancel in the WhenCheap UI. The agent has already submitted the transaction to the mempool 8 seconds ago. |
| **What agent does** | Immediately submits a cancellation transaction: zero-value self-transfer using the same nonce with a priority fee 20% higher than the submitted tx. This replacement races against the original. If the cancellation wins the block, the original is evicted. |
| **If the original confirms first** | Transaction cannot be reversed — this is a fundamental property of Ethereum. Agent notifies: "Your transaction confirmed before the cancellation could process. Ethereum transactions are irreversible once confirmed. Your funds have been sent." |
| **Honest UX copy** | The cancel button in WhenCheap UI clearly states: "Best-effort cancel — not guaranteed if transaction is already submitted." No false promises. |

---

### Scenario 5C — User submits contradictory intents (same funds, two recipients)

> **STATUS: HANDLED — conflict detection at intent creation**

| | |
|---|---|
| **What happens** | User submits: Intent A — send 0.5 ETH to Alice. Intent B — send 0.5 ETH to Bob. Wallet has 0.6 ETH total. Both cannot execute. |
| **Detection at intake** | When Intent B is created, agent checks total pending intent value against available balance. 0.5 + 0.5 = 1.0 ETH exceeds available 0.6 ETH. Agent flags the conflict immediately. |
| **User choice** | "You have two pending intents totalling 1.0 ETH but only 0.6 ETH available. Which should I prioritise? [Intent A] [Intent B] [Cancel both]" |
| **If balance changes during execution** | Handled by Scenario 5A — balance check before every attempt catches this dynamically. |

---

## Section 6 — The Trust Contract

WhenCheap makes four explicit guarantees to every user. These are not marketing claims — each is enforced by the mechanisms documented above.

| Guarantee | Enforced by |
|---|---|
| Your wallet is never frozen | Nonce yield mechanism (Scenario 1C) |
| Agent cannot exceed your fee limit | EIP-7702 session contract — on-chain enforcement (Scenario 3C) |
| Your master key is never exposed | EIP-7702 scoped session signing — no raw key held by agent |
| Every decision is auditable | Full audit log: intent created, every gas check, every tx hash, every state transition |

---

## Transaction Lifecycle State Machine

Every intent in WhenCheap moves through a defined set of states. No transitions happen outside this machine.

```
PENDING_INTENT
  └─→ SUBMITTED
        ├─→ CONFIRMING (in mempool)
        │     ├─→ CONFIRMED (1 block)
        │     │     └─→ FINALIZED (12+ blocks) ✅
        │     ├─→ STUCK
        │     │     └─→ SPEED_UP_SUBMITTED → (back to CONFIRMING)
        │     └─→ DROPPED
        │           └─→ RESUBMITTED → (back to CONFIRMING)
        └─→ DEADLINE_EXCEEDED → CANCELLED ❌

PENDING_INTENT can also transition to:
  INSUFFICIENT_BALANCE (Scenario 5A)
  NEEDS_REAUTHORIZATION (Scenario 3B)
  NONCE_CONFLICT → RESCHEDULED (Scenarios 1A, 1B)
```

---

*WhenCheap · Edge Case Defense · ETHGlobal Open Agents 2026*