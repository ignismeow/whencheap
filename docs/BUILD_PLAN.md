# WhenCheap Build Plan

## Milestone 1: Local Product Loop

- API health endpoint exposes configured Ollama model.
- Intent creation accepts wallet and natural language input.
- Ollama parser converts text into a structured execution plan.
- Intent state machine starts at `PENDING_INTENT`.
- Frontend creates intents and shows parsed plan plus audit events.

## Milestone 2: Chain Readiness

- Replace in-memory intent store with PostgreSQL entities.
- Add gas oracle abstraction with Blocknative and RPC fallback.
- Add wallet balance and nonce checks.
- Add deadline evaluation and notification hooks.

## Milestone 3: Quote And Execute

- Add Uniswap quote client.
- Add KeeperHub workflow creation.
- Add direct RPC fallback execution path.
- Add transaction table and confirmation tracking.

## Milestone 4: Failure Defense

- Implement nonce conflict detection.
- Implement stuck transaction replacement.
- Implement dropped transaction resubmission.
- Implement best-effort cancellation.
- Add downloadable audit receipt.

## Milestone 5: Hackathon Finish

- Deploy session contract on Sepolia.
- Connect frontend wallet flow.
- Add demo seed data and scripted walkthrough.
- Add optional 1inch, CoW, and L2 routing paths.
