# KeeperHub Integration Feedback — WhenCheap

**Project:** WhenCheap (ETHGlobal OpenAgents 2026)
**Repo:** https://github.com/saadaltafofficial/whencheap
**Integration:** KeeperHub Direct Execution API + MCP exploration
**Period:** April 24 – May 1, 2026

---

## What We Built

WhenCheap is a gas-aware intent execution agent. Users describe transactions in plain English and the agent executes them at the optimal gas price. We integrated KeeperHub as the transaction relay layer — the "boring middle layer between trigger and transaction" that KeeperHub describes themselves as.

---

## What Worked Well

### 1. Concept alignment
KeeperHub's value proposition is a perfect match for WhenCheap's use case. An agent that monitors gas and decides WHEN to execute needs a reliable relay that handles HOW to execute. KeeperHub fills this role cleanly — we focus on intent parsing and gas intelligence, KeeperHub handles nonce management, gas estimation, and broadcast.

### 2. API key provisioning
The API key provisioning process was fast and the dashboard is clean. Getting started took minutes.

### 3. Clear documentation structure
The API reference is well-organized. The endpoint structure (`/api/execute/transfer`) is intuitive.

---

## Issues Encountered

### Issue 1 — Amount parsing bug: ETH string vs wei

**Severity:** High — blocked initial integration

**Description:** The `/api/execute/transfer` endpoint documentation states that `amount` accepts human-readable units (e.g., `"0.001"` for 0.001 ETH). In practice, sending `"0.001"` results in a transaction submitted with `value: 0x0` — the amount is silently converted to zero.

**Reproduction:**
```bash
curl -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "network": "sepolia",
    "recipientAddress": "0x9dD40426fe0dbaF3d28B4fe7f499231e6FFd3873",
    "amount": "0.001"
  }'
```

**Result:** Transaction broadcast with `value: 0`, confirmed on-chain with 0 ETH transferred. No error returned — the API returns success.

**Workaround:** Send amount in wei:
```json
{ "amount": "1000000000000000" }
```

**Error observed:** When the zero-value transaction was rejected by the receiving contract: `CALL_EXCEPTION missing revert data`

**Suggestion:** Either fix the ETH→wei conversion in the API, or return a validation error when `amount` appears to be a decimal ETH value below 1 wei threshold. Silent zero-value transactions are dangerous.

---

### Issue 2 — 401 Unauthorized with valid API key

**Severity:** High — blocked integration for ~2 hours

**Description:** After successful API key creation, requests returned `401 Unauthorized`. The key was copied directly from the dashboard. The issue resolved itself after approximately 2 hours — suggesting a propagation delay between key creation and activation.

**Reproduction:** Intermittent — occurred immediately after key creation.

**Impact:** During a hackathon with time pressure, a 2-hour unexplained 401 is very disruptive. We initially assumed the key was wrong and spent time debugging the integration code.

**Suggestion:** 
- Display an estimated activation time after key creation ("Your key will be active in ~5 minutes")
- Or activate keys immediately
- Add a `GET /api/auth/validate` endpoint that confirms key validity without executing anything

---

### Issue 3 — MCP server connection drops

**Severity:** Medium — prevented MCP integration path

**Description:** When attempting to connect to KeeperHub's MCP server (`mcp.keeperhub.com/sse`), the connection was established but immediately dropped with `Connection closed` error. This occurred consistently across multiple attempts.

**Environment:** Standard SSE client, Node.js 20, standard headers.

**Impact:** We planned to use the MCP path for the cleanest agent integration (direct tool calls from our ReAct loop), but had to fall back to the REST API.

**Suggestion:** 
- Provide a connection test page or CLI command to verify MCP connectivity
- Log the reason for connection closure server-side
- Document any prerequisites for MCP connections (IP allowlisting, specific headers, etc.)

---

### Issue 4 — No webhook/callback for transaction confirmation

**Severity:** Medium — required polling implementation

**Description:** After submitting a transaction via the Direct Execution API, there's no webhook callback when the transaction confirms on-chain. We had to implement our own polling loop against the Alchemy RPC to detect confirmation.

**Impact:** Polling adds latency to the audit trail and requires additional RPC credits.

**Suggestion:** Add a `callbackUrl` field to the execute endpoint. When provided, KeeperHub POSTs to that URL with the confirmed transaction receipt. This is standard for relayer services and would make KeeperHub significantly more production-ready for agent use cases.

---

### Issue 5 — Wallet funding requirement not clearly documented

**Severity:** Low — discovered during testing

**Description:** KeeperHub's execution wallet needs to be funded with the native token for gas. This is mentioned in the docs but the error message when the wallet is underfunded is generic (`execution failed`) with no indication that the issue is insufficient gas balance.

**Suggestion:** Return a specific error code (`INSUFFICIENT_GAS_BALANCE`) with the current balance and required amount when execution fails due to low gas funds. Include a link to the dashboard where users can top up.

---

## Architecture Suggestion for Future

For agent frameworks like WhenCheap, the ideal KeeperHub integration would be:

```
Agent decides WHEN → KeeperHub executes HOW
     ↓                        ↓
Gas monitoring            Nonce management
Intent matching           Gas estimation  
Session validation        Transaction broadcast
                          Confirmation webhook
```

The missing piece is the bidirectional communication — agents need to know when transactions confirm without polling. A webhook system + proper error codes would make this integration production-grade.

---

## Overall Assessment

KeeperHub's concept is sound and the right abstraction for multi-agent transaction infrastructure. The Direct Execution API works once the amount format issue is understood. The MCP path is promising but needs stability improvements. With the webhook system and better error messages, KeeperHub would be a natural fit for the emerging agent transaction layer.

We're excited to see this product mature — the vision of a neutral relay layer that any agent can call is exactly what the ecosystem needs.

---

*Submitted by: Saad Altaf (saadbeenco@gmail.com)*
*ENS: whencheap.eth*
*KeeperHub Organization: (your org ID here)*