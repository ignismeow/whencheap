-- WhenCheap API database schema reference.
-- TypeORM currently creates these tables with synchronize=true, but we keep
-- this file checked in so the schema is visible and portable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_identifier_type AS ENUM ('google', 'email', 'wallet');

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier varchar(255) NOT NULL,
  "identifierType" user_identifier_type NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_identifier"
  ON users (identifier);

CREATE TABLE IF NOT EXISTS whencheap_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "walletAddress" varchar(64) NOT NULL,
  "encryptedPrivateKey" text NOT NULL,
  iv varchar(64) NOT NULL,
  "authTag" varchar(64) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_whencheap_wallets_walletAddress"
  ON whencheap_wallets ("walletAddress");

CREATE TABLE IF NOT EXISTS session_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "walletAddress" varchar(64) NOT NULL,
  chain varchar(32) NOT NULL DEFAULT 'sepolia',
  "authorizationJson" text NOT NULL,
  "isActive" boolean NOT NULL DEFAULT true,
  "expiresAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_session_authorizations_walletAddress_chain"
  ON session_authorizations ("walletAddress", chain);

CREATE TABLE IF NOT EXISTS intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  "walletAddress" varchar(64) NOT NULL,
  "rawInput" text NOT NULL,
  status varchar(64) NOT NULL,
  parsed jsonb NOT NULL,
  "txHash" varchar(128) NULL,
  "blockNumber" integer NULL,
  "inferenceProvider" varchar(32) NULL,
  "repeatCount" integer NOT NULL DEFAULT 1,
  "repeatCompleted" integer NOT NULL DEFAULT 0,
  deadline timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "intentId" uuid NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  "executionNumber" integer NOT NULL,
  "txHash" varchar(128) NOT NULL,
  "blockNumber" integer NULL,
  status varchar(64) NOT NULL,
  "gasPaidWei" varchar(128) NOT NULL,
  "confirmedAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_executions_txHash"
  ON executions ("txHash");

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "intentId" uuid NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  "eventType" varchar(64) NOT NULL,
  message text NOT NULL,
  metadata jsonb NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
