#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API_ENV="$ROOT_DIR/apps/api/.env"
CONTRACT_ENV="$ROOT_DIR/contracts/.env"

if [[ -f "$API_ENV" ]]; then
  set -a
  source "$API_ENV"
  set +a
fi

if [[ -f "$CONTRACT_ENV" ]]; then
  set -a
  source "$CONTRACT_ENV"
  set +a
fi

if [[ -z "${RPC_URL:-}" ]]; then
  echo "RPC_URL is missing. Set it in apps/api/.env."
  exit 1
fi

if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "DEPLOYER_PRIVATE_KEY is missing. Copy contracts/.env.example to contracts/.env and set a funded Sepolia key."
  exit 1
fi

source "$HOME/.zshenv" 2>/dev/null || true

cd "$ROOT_DIR/contracts"

forge script script/DeployWhenCheapSession.s.sol:DeployWhenCheapSession \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
