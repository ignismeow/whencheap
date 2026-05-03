# Uniswap Integration Feedback — WhenCheap

**Project:** WhenCheap (ETHGlobal OpenAgents 2026)
**Repo:** https://github.com/saadaltafofficial/whencheap
**Integration:** Uniswap Trading API + SwapRouter02 + /swap_7702 endpoint
**Period:** April 24 – May 1, 2026

---

## What We Built

WhenCheap is a gas-aware intent execution agent. Users describe what they want in plain English ("swap 0.001 ETH to USDC when gas is under $2"), and the agent monitors gas prices and executes at the optimal moment using EIP-7702 session-based authorization.

Uniswap is central to WhenCheap's execution layer — every swap intent routes through the Uniswap Trading API and executes via our custom `WhenCheapSession.sol` contract's `executeSwap()` function, which atomically collects protocol fees and forwards to the Uniswap router.

---

## What Worked Well

### 1. Trading API `/quote` and `/swap` endpoints
The Trading API is well-designed and easy to integrate. The OpenAI-style JSON interface made it straightforward to build around. Quote responses came back fast and the calldata was correct.

### 2. `/swap_7702` endpoint
This was a highlight — the dedicated EIP-7702 endpoint is exactly the right primitive for account-abstracted agents like WhenCheap. Passing our `WhenCheapSession` contract as the `delegation` field allows Uniswap to generate calldata that's optimized for delegated execution. This is a strong signal that Uniswap is building for the EIP-7702 future.

### 3. Sepolia support
Having Sepolia (chain ID 11155111) available in the Trading API was essential for hackathon testing. The Universal Router address on Sepolia worked correctly.

---

## Issues Encountered

### Issue 1 — AlphaRouter (`@uniswap/smart-order-router`) returns `value: 0` for ETH→token routes

**Severity:** High — caused silent swap failures

**Description:** When using AlphaRouter with `SwapType.SWAP_ROUTER_02`, routes for native ETH input return `methodParameters.value = "0"` even for ETH→token swaps. The calldata correctly encodes WRAP_ETH, but the `value` field returned by the SDK is zero.

**Root cause:** AlphaRouter assumes the caller will handle ETH wrapping separately, but for agents sending the transaction directly this results in SwapRouter02 receiving no ETH and producing no output silently (no revert, just zero output).

**Workaround:** Override the returned value with the actual `amountIn` when `tokenIn` is native ETH:
```typescript
return {
  calldata: route.methodParameters.calldata,
  value: tokenInAddress.toLowerCase() === NATIVE_ETH
    ? amountIn  // override — AlphaRouter returns 0 for ETH input
    : BigInt(route.methodParameters.value),
  to: SWAP_ROUTER_02_ADDRESS,
};
```

**Suggestion:** AlphaRouter should return the correct `value` for ETH input routes, or document clearly that callers must override this field.

---

### Issue 2 — Sepolia V3 WETH/USDC pool has out-of-range liquidity

**Severity:** High — blocked all Sepolia swap testing for several hours

**Description:** The WETH/USDC V3 pool on Sepolia (fee tier 100) shows liquidity in Etherscan but the liquidity is concentrated in a price range that doesn't match the current ETH price. All swap attempts succeed on-chain (no revert) but produce zero USDC output.

**Detection:** Decoded `exactInputSingle` calldata showed correct `amountIn` and `recipient`, but no ERC-20 Transfer events fired in the receipt. The Uniswap UI itself showed "This swap may fail" for the same pool.

**Resolution:** Switched from AlphaRouter to the Uniswap Trading API, which successfully routed through an active pool.

**Suggestion:** Uniswap could surface pool health/liquidity range status in the Trading API response, or flag when a selected route has high failure probability due to out-of-range liquidity.

---

### Issue 3 — `@uniswap/smart-order-router` requires ethers v5, incompatible with ethers v6

**Severity:** Medium — required dual ethers version installation

**Description:** `AlphaRouter` requires an ethers v5 provider (`ethers.providers.JsonRpcProvider`). Projects using ethers v6 (which has breaking API changes) receive "invalid signer or provider" errors at runtime with no clear error message pointing to the version mismatch.

**Workaround:**
```bash
npm install ethers-v5@npm:ethers@^5.8.0
```
Then use `ethers-v5` alias specifically for AlphaRouter while keeping ethers v6 for everything else.

**Suggestion:** Either update `@uniswap/smart-order-router` to support ethers v6, or document the version requirement prominently in the README. Many new projects start with ethers v6 and hit this silently.

---

### Issue 4 — `/swap_7702` endpoint behavior on Sepolia

**Severity:** Low — fell back to `/swap` gracefully

**Description:** The `/swap_7702` endpoint occasionally returned errors on Sepolia while `/swap` worked correctly for the same quote. The error wasn't clearly documented — it was unclear whether this was a Sepolia-specific limitation or a transient issue.

**Suggestion:** Document whether `/swap_7702` has different chain support requirements than `/swap`, and return a specific error code when EIP-7702 delegation is not supported for the given chain/configuration.

---

### Issue 5 — "No quotes available" on Sepolia is intermittent and hard to debug

**Severity:** Medium — caused confusion during development

**Description:** The Trading API occasionally returned `{"errorCode":"ResourceNotFound","detail":"No quotes available"}` for ETH→USDC on Sepolia with no additional context. The same request would succeed minutes later. It was difficult to determine whether this was a liquidity issue, a rate limit, or an API availability problem.

**Suggestion:** Include a `reason` field in the error response (e.g., `"reason": "no_active_pools"` vs `"reason": "temporary_unavailable"`) so developers can distinguish transient vs permanent failures and implement appropriate retry logic.

---

## Summary

The Uniswap Trading API is production-quality and well-suited for agent integrations. The `/swap_7702` endpoint is a genuinely exciting primitive that aligns perfectly with EIP-7702's account delegation model. The main friction points were around Sepolia pool reliability and the AlphaRouter ethers v5 dependency — both of which are solvable with better documentation or SDK updates.

WhenCheap's final architecture uses the Trading API for all quote and calldata generation, with `/swap_7702` as the primary endpoint and `/swap` as fallback. This gives us clean, production-ready swap execution with full EIP-7702 compatibility.

---

*Submitted by: Saad Altaf (saadbeenco@gmail.com)*
*ENS: whencheap.eth*
*Contracts: Sepolia `0x1a0775f6cfe22ECB1D6aE84699b76E540ddD7D9e` | Mainnet `0x3CAD995494954a8197391c4194Bd39E2Eda16274`*
