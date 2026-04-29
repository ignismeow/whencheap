# WhenCheap

WhenCheap is a gas-aware autonomous transaction agent. Users create intents such as "swap 0.1 ETH to USDC when gas is under $1 before midnight"; the agent parses the intent, waits for acceptable gas and route conditions, executes within user limits, and keeps an audit trail.

## AI Parser

This build uses Gemini for intent parsing.

```bash
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

If Gemini is unavailable or returns invalid JSON, the parser falls back to a conservative deterministic parser so the app remains usable during development.

## Structure

```text
apps/api       NestJS API and agent scaffold
apps/frontend  Next.js app
contracts      Foundry contracts
```

## Start

### Docker

Run the full stack:

```bash
docker compose up -d --build
```

Then open:

- Frontend: `http://localhost:3000`
- API health: `http://localhost:3001/health`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6389` on the host, `redis:6379` inside Docker

### Local Node

```bash
docker-compose up -d
npm install
npm run dev:api
npm run dev:frontend
```

Copy env examples before running:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/frontend/.env.local.example apps/frontend/.env.local
```

## Execution Fee

WhenCheap supports a configurable execution fee charged on confirmed transactions.

Examples at `0.3%`:

- Intent: Send `0.001 ETH`
- Fee: `0.000003 ETH` (`$0.007` at `$2300/ETH`)

- Intent: Send `0.1 ETH`
- Fee: `0.0003 ETH` (`$0.69` at `$2300/ETH`)

- Intent: Send `1 ETH`
- Fee: `0.003 ETH` (`$6.90` at `$2300/ETH`)
