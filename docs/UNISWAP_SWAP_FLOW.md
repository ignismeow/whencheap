# Uniswap Swap Handling

This document explains how WhenCheap currently handles Uniswap-style swaps end to end.

It covers:

- intent parsing
- gas and session validation
- managed-wallet execution
- Uniswap Trade API usage
- Sepolia Universal Router fallback
- platform fee handling
- audit trail behavior
- frontend minimum-balance display
- current limitations and debugging tips

## Overview

WhenCheap handles swaps through the API service in `apps/api`.

The high-level flow is:

1. The frontend sends a natural-language intent like `Swap 0.001 ETH to USDC when gas under $2 on sepolia`.
2. The backend parses that into a structured `swap` intent.
3. A scheduled evaluator checks:
   - deadline
   - gas cost against the user’s max fee limit
   - on-chain session validity using `canExecute(...)`
   - managed wallet balance
4. If valid, the backend executes the swap from the user’s managed wallet via EIP-7702-style delegated execution.
5. The transaction is tracked until confirmation.
6. Session spend is recorded and audit events are written.

## Main Files

- `apps/api/src/modules/intents/intents.service.ts`
- `apps/api/src/modules/session/session-signer.service.ts`
- `apps/api/src/modules/gas/gas-oracle.service.ts`
- `contracts/src/WhenCheapSession.sol`
- `apps/frontend/app/page.tsx`

## Intent Lifecycle

### 1. Intent creation

Intent creation starts in `IntentsService.create(...)`.

The parser turns user text into a structured intent with fields like:

- `type = "swap"`
- `fromToken`
- `toToken`
- `amount`
- `chain`
- `maxFeeUsd`
- `deadlineIso`
- `slippageBps`

Example:

`Swap 0.001 ETH to USDC on sepolia when gas under $2`

becomes a swap intent that later enters the scheduled execution loop.

### 2. Scheduled evaluation

`IntentsService.evaluatePendingIntents()` runs every 30 seconds.

For swaps it performs:

- deadline validation
- gas estimate lookup via `GasOracleService`
- session validation using `canExecute(wallet, feeWei)`
- managed-wallet balance validation

If all checks pass, the swap moves into execution.

## Gas Handling

Gas cost is estimated in:

- `apps/api/src/modules/gas/gas-oracle.service.ts`

Swap gas uses:

- `150_000` gas units

The backend records audit messages like:

- `GAS_CHECK_PASSED`
- `GAS_CHECK_FAILED`
- `GAS_CHECK_SKIPPED`

For swap intents, the audit message includes the swap-specific estimate.

## Session Handling

Session validation uses the on-chain session contract:

- `contracts/src/WhenCheapSession.sol`

The main validation call is:

- `canExecute(address wallet, uint256 feeWei)`

The backend uses:

- `SessionSignerService.canExecuteSession(...)`

This makes sure:

- the session is not expired
- the estimated fee is within the per-transaction cap
- cumulative spend is within the total session budget

## Managed Wallet / EIP-7702 Execution Model

Swaps are currently executed through the user’s managed wallet path, not through simple agent-wallet fallback.

The main execution method is:

- `SessionSignerService.broadcastWithUserWallet(...)`

The flow is:

1. Load the encrypted managed wallet for the user
2. Decrypt the managed private key
3. Build the execution payload
4. Sign an authorization against the session contract
5. Relay a transaction through the agent using the user wallet as the effective sender

This is the same core sender model used for managed-wallet execution generally.

## Swap Transaction Building

### Shared builder

All swaps go through:

- `SessionSignerService.buildExecutionTransaction(...)`

For swap intents, this calls:

- `SessionSignerService.buildSwapTransaction(...)`

That method first tries the Uniswap Trade API.

## Trade API Path

For supported routes, the backend tries:

- `POST https://trade-api.gateway.uniswap.org/v1/quote`
- `POST https://trade-api.gateway.uniswap.org/v1/swap`

The Trade API path is used to fetch executable calldata and router details.

The request uses:

- `type: EXACT_INPUT`
- input token / output token
- chain id
- swapper
- slippage

If successful, the backend uses the returned:

- router address
- calldata
- ETH value
- gas hint

and relays that through the managed-wallet execution path.

## Sepolia Fallback Path

The Trade API has returned `NO_ROUTE` / `404` for some Sepolia pairs, so there is a manual fallback for Sepolia.

This fallback is implemented in:

- `SessionSignerService.buildDirectSepoliaSwapTransaction(...)`

### Current Sepolia fallback strategy

For Sepolia `ETH -> USDC`, the backend now uses the Uniswap Universal Router manually.

It encodes:

- `WRAP_ETH`
- `V3_SWAP_EXACT_IN`

through Universal Router `execute(...)`.

### Universal Router details

Current fallback constants include:

- Universal Router address on Sepolia
- fee tier `500`
- WETH and USDC Sepolia addresses

The fallback currently:

1. Wraps ETH into WETH inside Universal Router
2. Swaps WETH to USDC through a V3 path
3. Sends USDC to the user wallet

### Current route assumptions

Supported Sepolia fallback pairs:

- `ETH -> USDC`
- `ETH -> WETH`

Unsupported Sepolia pairs throw a descriptive error.

## Fee Handling

This is the most important part of the swap path.

### Where fees are enforced

Platform fees are enforced on-chain by `WhenCheapSession.execute(...)`.

Important contract behavior:

- `execute(to, value, data)` calculates fee from the `value` argument
- it does **not** calculate fee from `msg.value`
- it forwards `net = value - totalFee` to the downstream target

That means:

- if the router should receive exactly `swapAmount`
- then `execute(..., value, ...)` must be grossed up so that:

`value - feeForAmount(value) = swapAmount`

### Gross-up logic

The backend solves this using:

- `SessionSignerService.grossUpForSessionFee(...)`

and:

- `SessionSignerService.getTotalChargedWeiForNetValue(...)`

That means the user-requested swap amount is treated as the exact net swap amount, and the wallet is charged slightly more so the session contract can take its fee on top.

### Result

For a user request like:

- `swapAmount = 0.001 ETH`

the backend computes:

- exact swap amount to router = `0.001 ETH`
- platform fee = grossed-up delta
- total charged from wallet = `swap amount + fee`

This is reflected both in execution audit messages and the frontend estimate panel.

## Current Universal Router Encoding

The Sepolia fallback manually encodes:

- `commands`
- `inputs`
- `deadline`

It uses:

- `WRAP_ETH`
- `V3_SWAP_EXACT_IN`

The V3 path is built as:

- `WETH + fee + USDC`

The fee tier currently configured in code is:

- `500`

The fallback also includes:

- a small non-zero `amountOutMin`
- development assertions for command selector and path shape

## Audit Trail

Swap execution produces a sequence of audit events in `IntentsService`.

Common events:

- `GAS_CHECK_PASSED`
- `SESSION_CHECK_PASSED`
- `SWAP_EXECUTING`
- `STATUS_CHANGED`
- `SWAP_EXECUTED`
- `SESSION_SPEND_RECORDED`
- `FEE_COLLECTED`
- `EXECUTION_FAILED`

The `SWAP_EXECUTING` message currently includes:

- input token
- output token
- swap amount
- fee charged
- total deducted from wallet

## Receipt / Finalization

Submitted transactions are polled in:

- `IntentsService.pollSubmittedIntents()`

When a receipt arrives:

- gas paid is recorded
- session spend is recorded
- fee collection events are decoded
- the intent is finalized or marked stuck if reverted

If the swap succeeds, the backend writes:

- `SWAP_EXECUTED`

and transitions the intent to:

- `FINALIZED`

## Frontend Minimum Balance Display

The session modal in:

- `apps/frontend/app/page.tsx`

shows a minimum-balance estimate for the draft intent.

For swaps it now distinguishes:

- `Swap amount`
- `Platform fee`
- `Gas est`
- `Total charged`

The frontend intentionally models swap charging as:

- exact requested swap amount
- plus fee on top
- plus gas estimate

This matches the current backend fee semantics.

## Token Addresses

### Sepolia

- ETH: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
- WETH: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

### Mainnet

Mainnet tokens are also configured in `session-signer.service.ts`.

## Current Sepolia Assumptions

The current Sepolia fallback is designed for testnet robustness, not market-accurate pricing.

That means:

- `amountOutMin` is intentionally very low
- fallback routing is hardcoded for known supported pairs
- pool assumptions are specific to current Sepolia usage

This is acceptable for testnet development, but not sufficient for production-grade mainnet protection.

## Known Limitations

### 1. Sepolia fallback is specialized

The manual Universal Router fallback is not a general swap router for arbitrary token pairs.

### 2. Trade API and fallback differ

Mainnet and supported routes use the Trade API.
Sepolia may use the hardcoded fallback.
That means behavior is not identical across environments.

### 3. Slippage protection is intentionally weak on Sepolia

The fallback uses a tiny `amountOutMin` for testnet reliability.

### 4. On-chain fee semantics are easy to get wrong

Because `WhenCheapSession.execute(...)` deducts fee from the `value` parameter, any downstream contract expecting an exact `msg.value` must be handled with gross-up logic.

## How To Debug

If a Sepolia swap fails, check:

1. intent audit events in the UI
2. API logs from `session-signer.service.ts`
3. Universal Router selector assertion
4. path logs and path length
5. session status endpoint output
6. managed wallet balance
7. session per-tx limit and total budget

Useful questions:

- Did the Trade API fail and trigger fallback?
- Did the managed wallet have enough ETH for swap + fee + gas?
- Did the session contract receive enough grossed-up value?
- Did the router path match the expected WETH/USDC fee-tier route?

## Summary

Today, WhenCheap handles swaps like this:

- parse natural-language swap intent
- estimate gas and validate session
- execute from the user’s managed wallet
- prefer Uniswap Trade API when available
- fall back to manually encoded Universal Router flow on Sepolia
- gross up session value so the user gets the exact requested swap amount after platform fee deduction
- record everything in the audit trail

If you want, I can also make a second document that focuses only on:

- `Sepolia swap fallback internals`

or only on:

- `session fee math and execute() semantics`
