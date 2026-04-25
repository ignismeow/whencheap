# WhenCheap

WhenCheap is a gas-aware autonomous transaction agent. Users create intents such as "swap 0.1 ETH to USDC when gas is under $1 before midnight"; the agent parses the intent, waits for acceptable gas and route conditions, executes within user limits, and keeps an audit trail.

## Local AI

This build uses Ollama for intent parsing.

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:35b
```

The API expects Ollama's `/api/generate` endpoint. If Ollama is unavailable or returns invalid JSON, the parser falls back to a conservative deterministic parser so the app remains usable during development.

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
