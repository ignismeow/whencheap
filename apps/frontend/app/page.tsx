'use client';

import { Activity, Clock3, Link2, PlugZap, RefreshCcw, Send, ShieldCheck, Wallet } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract
} from 'wagmi';
import { sessionContractAddress, whenCheapSessionAbi } from '../lib/session-contract';
import useSWR from 'swr';

type AuditEvent = {
  id: string;
  at: string;
  type: string;
  message: string;
};

type IntentRecord = {
  id: string;
  wallet: string;
  rawInput: string;
  status: string;
  parsed: {
    type: string;
    fromToken: string;
    toToken?: string;
    recipient?: string;
    amount: string;
    maxFeeUsd: number;
    deadlineIso: string;
    chain: string;
    slippageBps: number;
    repeatCount?: number;
    notes?: string;
  };
  createdAt: string;
  updatedAt: string;
  audit: AuditEvent[];
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function Home() {
  const { address, chainId, isConnected } = useAccount();
  const [wallet, setWallet] = useState('0x0000000000000000000000000000000000000000');
  const [input, setInput] = useState('Swap 0.1 ETH to USDC when gas is under $1 before midnight');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, mutate, isLoading } = useSWR<IntentRecord[]>(`${apiUrl}/intents`, fetcher, {
    refreshInterval: 5000
  });

  const intents = data ?? [];
  const selected = useMemo(
    () => intents.find((intent) => intent.id === selectedId) ?? intents[0],
    [intents, selectedId]
  );

  useEffect(() => {
    if (address) {
      setWallet(address);
    }
  }, [address]);

  async function createIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, input })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || 'Intent creation failed');
      }

      const created = (await response.json()) as IntentRecord;
      setSelectedId(created.id);
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intent creation failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen">
      <section className="border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">WhenCheap</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Gas-aware intent execution with local Ollama parsing.</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <ShieldCheck size={18} className="text-[var(--accent)]" />
            Sepolia demo mode
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[420px_1fr]">
        <div className="grid content-start gap-5">
          <WalletSessionPanel address={address} chainId={chainId} isConnected={isConnected} />

          <form onSubmit={createIntent} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="mb-4 flex items-center gap-2">
              <Wallet size={18} />
              <h2 className="text-base font-semibold">Create Intent</h2>
            </div>

            <label className="block text-sm font-medium" htmlFor="wallet">
              Wallet
            </label>
            <input
              id="wallet"
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              className="mt-2 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              placeholder="0x..."
            />

            <label className="mt-4 block text-sm font-medium" htmlFor="intent">
              Intent
            </label>
            <textarea
              id="intent"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="mt-2 min-h-36 w-full resize-y rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              placeholder="Swap 0.1 ETH to USDC when gas is under $1 before midnight"
            />

            {error ? <p className="mt-3 text-sm text-[var(--danger)]">{error}</p> : null}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send size={16} />
              {isSubmitting ? 'Creating' : 'Create Intent'}
            </button>
          </form>
        </div>

        <div className="grid gap-5">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <div className="flex items-center gap-2">
                <Activity size={18} />
                <h2 className="text-base font-semibold">Active Intents</h2>
              </div>
              <button
                onClick={() => void mutate()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)]"
                title="Refresh intents"
              >
                <RefreshCcw size={16} />
              </button>
            </div>

            <div className="grid divide-y divide-[var(--border)]">
              {isLoading ? <p className="px-4 py-5 text-sm text-[var(--muted)]">Loading intents</p> : null}
              {!isLoading && intents.length === 0 ? (
                <p className="px-4 py-5 text-sm text-[var(--muted)]">No intents yet.</p>
              ) : null}
              {intents.map((intent) => (
                <button
                  key={intent.id}
                  onClick={() => setSelectedId(intent.id)}
                  className="grid gap-1 px-4 py-3 text-left hover:bg-[var(--panel-strong)]"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{intent.rawInput}</span>
                    <span className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs">
                      {intent.status}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    {intent.parsed.amount} {intent.parsed.fromToken}
                    {intent.parsed.toToken ? ` -> ${intent.parsed.toToken}` : ''} · max ${intent.parsed.maxFeeUsd} USD
                  </span>
                </button>
              ))}
            </div>
          </div>

          {selected ? <IntentDetail intent={selected} /> : null}
        </div>
      </section>
    </main>
  );
}

function WalletSessionPanel({
  address,
  chainId,
  isConnected
}: {
  address?: `0x${string}`;
  chainId?: number;
  isConnected: boolean;
}) {
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const { writeContract, data: hash, isPending: isWriting, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash });
  const [maxFeePerTxEth, setMaxFeePerTxEth] = useState('0.001');
  const [maxTotalSpendEth, setMaxTotalSpendEth] = useState('0.01');
  const [expiryHours, setExpiryHours] = useState('6');

  const { data: sessionData, refetch } = useReadContract({
    address: sessionContractAddress,
    abi: whenCheapSessionAbi,
    functionName: 'sessions',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(sessionContractAddress && address)
    }
  });

  useEffect(() => {
    if (isConfirmed) {
      void refetch();
    }
  }, [isConfirmed, refetch]);

  const isWrongChain = isConnected && chainId !== sepolia.id;
  const injectedConnector = connectors[0];

  async function authorizeSession() {
    if (!sessionContractAddress || !walletClient) return;

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Number(expiryHours) * 60 * 60);

    // Attempt EIP-7702 delegation — delegates EOA code to the session contract so
    // the agent can call recordSpend with msg.sender == user's wallet.
    // Falls back silently if the wallet doesn't support it yet.
    let authorizationList: unknown[] | undefined;
    try {
      const auth = await (walletClient as { signAuthorization?: (args: { contractAddress: `0x${string}`; chainId: number }) => Promise<unknown> }).signAuthorization?.({
        contractAddress: sessionContractAddress,
        chainId: sepolia.id
      });
      if (auth) authorizationList = [auth];
    } catch {
      // wallet doesn't support EIP-7702 yet — plain updateSession still works
    }

    writeContract({
      address: sessionContractAddress,
      abi: whenCheapSessionAbi,
      functionName: 'updateSession',
      args: [parseEther(maxFeePerTxEth), parseEther(maxTotalSpendEth), expiresAt, []],
      ...(authorizationList ? { authorizationList } : {})
    } as Parameters<typeof writeContract>[0]);
  }

  function revokeSession() {
    if (!sessionContractAddress) {
      return;
    }

    writeContract({
      address: sessionContractAddress,
      abi: whenCheapSessionAbi,
      functionName: 'revokeSession'
    });
  }

  const session = Array.isArray(sessionData)
    ? {
        maxFeePerTxWei: sessionData[0],
        maxTotalSpendWei: sessionData[1],
        spentWei: sessionData[2],
        expiresAt: sessionData[3]
      }
    : null;
  const expiresAtMs = session && session.expiresAt > BigInt(0) ? Number(session.expiresAt) * 1000 : null;
  const sessionActive = Boolean(expiresAtMs && expiresAtMs > Date.now());

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="mb-4 flex items-center gap-2">
        <PlugZap size={18} />
        <h2 className="text-base font-semibold">Session Authorization</h2>
      </div>

      <div className="grid gap-3">
        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-strong)] px-3 py-2">
          <p className="text-xs font-medium uppercase text-[var(--muted)]">Contract</p>
          <p className="mt-1 break-all text-xs font-semibold">{sessionContractAddress ?? 'Not configured'}</p>
        </div>

        {!isConnected ? (
          <button
            type="button"
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={isConnecting || !injectedConnector}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Wallet size={16} />
            {isConnecting ? 'Connecting' : 'Connect MetaMask'}
          </button>
        ) : (
          <div className="grid gap-3">
            <div className="rounded-md border border-[var(--border)] bg-[var(--panel-strong)] px-3 py-2">
              <p className="text-xs font-medium uppercase text-[var(--muted)]">Wallet</p>
              <p className="mt-1 break-all text-xs font-semibold">{address}</p>
            </div>

            {isWrongChain ? (
              <button
                type="button"
                onClick={() => switchChain({ chainId: sepolia.id })}
                disabled={isSwitching}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--warning)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Link2 size={16} />
                {isSwitching ? 'Switching' : 'Switch to Sepolia'}
              </button>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">
                Max fee per tx ETH
                <input
                  value={maxFeePerTxEth}
                  onChange={(event) => setMaxFeePerTxEth(event.target.value)}
                  className="mt-2 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  inputMode="decimal"
                />
              </label>
              <label className="text-sm font-medium">
                Total budget ETH
                <input
                  value={maxTotalSpendEth}
                  onChange={(event) => setMaxTotalSpendEth(event.target.value)}
                  className="mt-2 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  inputMode="decimal"
                />
              </label>
            </div>

            <label className="text-sm font-medium">
              Expiry hours
              <input
                value={expiryHours}
                onChange={(event) => setExpiryHours(event.target.value)}
                className="mt-2 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                inputMode="numeric"
              />
            </label>

            <button
              type="button"
              onClick={authorizeSession}
              disabled={isWrongChain || isWriting || isConfirming || !sessionContractAddress}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ShieldCheck size={16} />
              {isWriting ? 'Confirm in wallet' : isConfirming ? 'Authorizing' : 'Authorize Session'}
            </button>

            <button
              type="button"
              onClick={revokeSession}
              disabled={isWrongChain || isWriting || isConfirming || !sessionContractAddress}
              className="inline-flex w-full items-center justify-center rounded-md border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              Revoke Session
            </button>

            <button
              type="button"
              onClick={() => disconnect()}
              className="inline-flex w-full items-center justify-center rounded-md border border-[var(--border)] px-4 py-2 text-sm font-semibold"
            >
              Disconnect
            </button>
          </div>
        )}

        {session ? (
          <div className="grid gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-strong)] px-3 py-2 text-sm">
            <p className="font-semibold">{sessionActive ? 'Session active' : 'No active session'}</p>
            <p className="text-[var(--muted)]">Per tx: {formatEther(session.maxFeePerTxWei)} ETH</p>
            <p className="text-[var(--muted)]">Budget: {formatEther(session.maxTotalSpendWei)} ETH</p>
            <p className="text-[var(--muted)]">Spent: {formatEther(session.spentWei)} ETH</p>
            <p className="text-[var(--muted)]">
              Expires: {expiresAtMs ? new Date(expiresAtMs).toLocaleString() : 'Not set'}
            </p>
          </div>
        ) : null}

        {hash ? <p className="break-all text-xs text-[var(--muted)]">Tx: {hash}</p> : null}
        {isConfirmed ? <p className="text-sm font-medium text-[var(--accent)]">Session authorized.</p> : null}
        {writeError ? <p className="text-sm text-[var(--danger)]">{writeError.message}</p> : null}
      </div>
    </section>
  );
}

function IntentDetail({ intent }: { intent: IntentRecord }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="mb-4 flex items-center gap-2">
          <Clock3 size={18} />
          <h2 className="text-base font-semibold">Parsed Execution Plan</h2>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Type" value={intent.parsed.type} />
          <Field label="Status" value={intent.status} />
          <Field label="Amount" value={`${intent.parsed.amount} ${intent.parsed.fromToken}`} />
          <Field
            label={intent.parsed.type === 'send' ? 'Recipient' : 'Output'}
            value={intent.parsed.recipient ?? intent.parsed.toToken ?? 'Not set'}
          />
          <Field label="Max Fee" value={`$${intent.parsed.maxFeeUsd}`} />
          <Field label="Chain" value={intent.parsed.chain} />
          <Field label="Slippage" value={`${intent.parsed.slippageBps / 100}%`} />
          <Field label="Deadline" value={new Date(intent.parsed.deadlineIso).toLocaleString()} />
          {intent.parsed.repeatCount ? <Field label="Repeats" value={`${intent.parsed.repeatCount} times`} /> : null}
        </dl>
        {intent.parsed.notes ? <p className="mt-4 text-sm text-[var(--warning)]">{intent.parsed.notes}</p> : null}
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <h2 className="mb-4 text-base font-semibold">Audit Trail</h2>
        <div className="grid gap-3">
          {intent.audit.map((event) => (
            <div key={event.id} className="border-l-2 border-[var(--accent)] pl-3">
              <p className="text-sm font-medium">{event.type}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{event.message}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{new Date(event.at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-strong)] px-3 py-2">
      <dt className="text-xs font-medium uppercase text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold">{value}</dd>
    </div>
  );
}
