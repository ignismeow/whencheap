'use client';

import {
  Copy,
  LogOut,
  RefreshCcw,
  Send,
  ShieldCheck,
  XCircle
} from 'lucide-react';
import { FormEvent, KeyboardEvent, ReactNode, RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { useReadContract } from 'wagmi';
import useSWR from 'swr';
import {
  mainnetSessionContractAddress,
  sessionContractAddress,
  whenCheapSessionAbi,
} from '../lib/session-contract';

type AuditEvent = {
  id: string;
  at: string;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type IntentRecord = {
  id: string;
  wallet: string;
  rawInput: string;
  status: string;
  txHash?: string;
  parsed: {
    type: string;
    fromToken: string;
    toToken?: string;
    recipient?: string;
    resolvedRecipient?: string;
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

type ExecutionDetails = {
  txHash?: string;
  blockNumber?: number | string;
  gasPaidWei?: string;
};

type ManagedIdentity = {
  email: string;
  address: `0x${string}`;
  created?: boolean;
};

type GoogleCredentialResponse = {
  credential: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: Record<string, string | number | boolean>,
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
const fetcher = (url: string) => fetch(url).then((res) => res.json());
const authStorageKey = 'whencheap-google-identity';
const chainStorageKey = 'whencheap-selected-chain';

export default function Home() {
  const [input, setInput] = useState('Send 0.001 ETH to 0xfC2b1688B9776ae0cA6dbf8Fc335a69a6e97578D when gas is under $1 in next 30 minutes'
);
  const [selectedChain, setSelectedChain] = useState<'sepolia' | 'mainnet'>('sepolia');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingIntentId, setCancellingIntentId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [managedIdentity, setManagedIdentity] = useState<ManagedIdentity | null>(null);
  const [isSessionCardOpen, setIsSessionCardOpen] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [ensCandidate, setEnsCandidate] = useState<string | null>(null);
  const [resolvedEnsAddress, setResolvedEnsAddress] = useState<string | null>(null);
  const [ensResolutionError, setEnsResolutionError] = useState<string | null>(null);
  const [isResolvingEns, setIsResolvingEns] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const { data, mutate, isLoading } = useSWR<IntentRecord[]>(`${apiUrl}/intents`, fetcher, {
    refreshInterval: 5000
  });

  const intents = data ?? [];
  const filteredIntents = useMemo(
    () => intents.filter((intent) => normalizeIntentChain(intent.parsed.chain) === selectedChain),
    [intents, selectedChain],
  );
  const selected = useMemo(
    () => filteredIntents.find((intent) => intent.id === selectedId) ?? filteredIntents[0] ?? null,
    [filteredIntents, selectedId]
  );
  const effectiveAddress = managedIdentity?.address;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(authStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ManagedIdentity;
      if (parsed?.email && parsed?.address) {
        setManagedIdentity(parsed);
      }
    } catch {
      window.localStorage.removeItem(authStorageKey);
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(chainStorageKey);
      if (stored === 'sepolia' || stored === 'mainnet') {
        setSelectedChain(stored);
      }
    } catch {}
  }, []);

  useEffect(() => {
    window.localStorage.setItem(chainStorageKey, selectedChain);
    setSelectedId(null);
  }, [selectedChain]);

  useEffect(() => {
    const candidate = extractEnsCandidate(input);
    setEnsCandidate(candidate);

    if (!candidate) {
      setResolvedEnsAddress(null);
      setEnsResolutionError(null);
      setIsResolvingEns(false);
      return;
    }

    const timeout = window.setTimeout(async () => {
      setIsResolvingEns(true);
      setEnsResolutionError(null);

      try {
        const response = await fetch(
          `${apiUrl}/intents/resolve-name/lookup?name=${encodeURIComponent(candidate)}`
        );
        const payload = (await response.json()) as { address?: string | null; message?: string };

        if (!response.ok) {
          throw new Error(payload.message || 'ENS lookup failed');
        }

        setResolvedEnsAddress(payload.address ?? null);
        setEnsResolutionError(payload.address ? null : `No address found for ${candidate}`);
      } catch (err) {
        setResolvedEnsAddress(null);
        setEnsResolutionError(err instanceof Error ? err.message : 'ENS lookup failed');
      } finally {
        setIsResolvingEns(false);
      }
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [input]);

  useEffect(() => {
    if (!googleClientId || managedIdentity) {
      return;
    }

    const initialize = () => {
      if (!window.google || !googleButtonRef.current) {
        return;
      }

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => {
          void authenticateWithGoogle(response.credential);
        }
      });

      googleButtonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'filled_black',
        size: 'large',
        width: 320,
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left'
      });
    };

    if (window.google) {
      initialize();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-whencheap-google-auth="true"]'
    );
    if (existingScript) {
      existingScript.addEventListener('load', initialize, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.whencheapGoogleAuth = 'true';
    script.addEventListener('load', initialize, { once: true });
    script.addEventListener(
      'error',
      () => setAuthError('Could not load Google authentication.'),
      { once: true },
    );
    document.head.appendChild(script);
  }, [managedIdentity]);

  async function authenticateWithGoogle(credential: string) {
    try {
      setIsAuthenticating(true);
      setAuthError(null);

      const response = await fetch(`${apiUrl}/intents/google-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential })
      });

      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (!response.ok || payload.ok !== true) {
        throw new Error(
          typeof payload.message === 'string' ? payload.message : rawBody || 'Google authentication failed',
        );
      }

      const identity: ManagedIdentity = {
        email: String(payload.email),
        address: String(payload.address) as `0x${string}`,
        created: Boolean(payload.created)
      };
      setManagedIdentity(identity);
      window.localStorage.setItem(authStorageKey, JSON.stringify(identity));
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google authentication failed');
    } finally {
      setIsAuthenticating(false);
    }
  }

  function signOutManagedIdentity() {
    setManagedIdentity(null);
    setSelectedId(null);
    window.localStorage.removeItem(authStorageKey);
    window.google?.accounts.id.disableAutoSelect();
  }

  async function createIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveAddress) {
      setError('Verify with Google first.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const normalizedInput = enforceChainSelection(input, selectedChain);
      const response = await fetch(`${apiUrl}/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: effectiveAddress, input: normalizedInput })
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

  function submitIntentOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function cancelIntent(id: string) {
    try {
      setCancellingIntentId(id);
      setCancelError(null);

      const response = await fetch(`${apiUrl}/intents/${id}/cancel`, {
        method: 'POST'
      });

      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (!response.ok) {
        throw new Error(typeof payload.message === 'string' ? payload.message : rawBody || 'Intent cancellation failed');
      }

      await mutate();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Intent cancellation failed');
    } finally {
      setCancellingIntentId(null);
    }
  }

  if (!managedIdentity) {
    return (
      <main className="console-shell">
        <AuthGate
          authError={authError}
          isAuthenticating={isAuthenticating}
          googleButtonRef={googleButtonRef}
        />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <HeaderBar
        address={effectiveAddress}
        email={managedIdentity.email}
        selectedChain={selectedChain}
        onToggleChain={() =>
          setSelectedChain((current) => (current === 'sepolia' ? 'mainnet' : 'sepolia'))
        }
        onOpenSessionCard={() => setIsSessionCardOpen(true)}
      />

      <div className="console-root">
        <aside className="console-sidebar">
          <ConsolePanel title="Intent Input" eyebrow="TRANSLATE NATURAL LANGUAGE" className="console-intent-panel">
            <form onSubmit={createIntent} className="space-y-4">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={submitIntentOnEnter}
                className="console-input min-h-[220px] w-full resize-none xl:min-h-[320px]"
                placeholder="Send 0.1 ETH to vitalik.eth when gas is under $0.50..."
              />

              <div className="space-y-2 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
                <div className="console-subpanel">
                  <span className="block text-[10px] text-[var(--color-label)]">Managed wallet</span>
                  <span className="mt-1 block text-[var(--color-text)]">{truncateAddress(effectiveAddress ?? '')}</span>
                  <span className="mt-2 block normal-case tracking-normal text-[var(--color-muted)]">
                    Press Enter to submit. Use Shift+Enter for a new line.
                  </span>
                </div>

                {showsMainnetSwapWarning(input) ? (
                  <p className="text-[11px] normal-case tracking-normal text-[var(--color-warning)]">
                    {selectedChain === 'mainnet'
                      ? 'Mainnet mode active. Real ETH will be used.'
                      : 'Swap intents without an explicit chain default to Ethereum mainnet.'}
                  </p>
                ) : null}

                {ensCandidate ? (
                  <div className="console-subpanel">
                    <span className="block text-[10px] text-[var(--color-label)]">ENS resolver</span>
                    <span className="mt-1 block text-[var(--color-text)] normal-case tracking-normal">
                      {isResolvingEns
                        ? `Resolving ${ensCandidate}...`
                        : resolvedEnsAddress
                          ? `${ensCandidate} -> ${truncateAddress(resolvedEnsAddress)}`
                          : ensResolutionError ?? `No resolution found for ${ensCandidate}`}
                    </span>
                  </div>
                ) : null}

                {error ? <p className="text-[var(--color-danger)] normal-case tracking-normal">{error}</p> : null}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="console-button console-button-primary w-full"
              >
                <Send size={15} />
                {isSubmitting ? 'Creating Command...' : 'Create Intent'}
              </button>
            </form>
          </ConsolePanel>

          {/* <ConsolePanel
            title="Recent Commands"
            eyebrow="QUEUE"
            action={
              <button
                type="button"
                onClick={() => void mutate()}
                className="console-icon-button"
                title="Refresh intents"
              >
                <RefreshCcw size={14} />
              </button>
            }
          >
            <div className="console-scroll h-[280px] space-y-2 pr-1">
              {isLoading ? (
                <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
                  Loading intents...
                </p>
              ) : intents.length === 0 ? (
                <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
                  No commands queued.
                </p>
              ) : (
                intents.map((intent) => (
                  <button
                    key={intent.id}
                    type="button"
                    onClick={() => setSelectedId(intent.id)}
                    className={`console-list-item ${selected?.id === intent.id ? 'console-list-item-active' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs uppercase tracking-[0.14em] text-[var(--color-text)]">
                          {intent.rawInput}
                        </p>
                        <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                          {new Date(intent.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <StatusBadge status={intent.status} compact />
                    </div>
                  </button>
                ))
              )}
            </div>
          </ConsolePanel> */}
        </aside>

        <section className="console-main">
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_220px] gap-4">
            <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
              {selected ? (
                <CommandCenter
                  intent={selected}
                  onCancel={() => void cancelIntent(selected.id)}
                  isCancelling={cancellingIntentId === selected.id}
                  cancelError={cancelError}
                />
              ) : <CommandCenterEmpty />}
              {selected ? <AuditTrail intent={selected} /> : <AuditTrailEmpty />}
            </div>
            <RecentCommandsPanel
              intents={filteredIntents}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              onRefresh={() => void mutate()}
              isLoading={isLoading}
              onCancel={(id) => void cancelIntent(id)}
              cancellingIntentId={cancellingIntentId}
            />
          </div>
        </section>
      </div>

      {isSessionCardOpen ? (
        <SessionCardModal onClose={() => setIsSessionCardOpen(false)}>
          <SessionCard
            address={effectiveAddress}
            email={managedIdentity.email}
            sessionChain={selectedChain}
            onSessionChainChange={setSelectedChain}
            onLogout={signOutManagedIdentity}
            onClose={() => setIsSessionCardOpen(false)}
          />
        </SessionCardModal>
      ) : null}
    </main>
  );
}

function AuthGate({
  authError,
  isAuthenticating,
  googleButtonRef
}: {
  authError: string | null;
  isAuthenticating: boolean;
  googleButtonRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[760px] border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <div className="space-y-3 border-b border-[var(--color-border)] pb-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
            Verified Access Required
          </p>
          <h1 className="text-xl font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
            Link Google to allocate a managed WhenCheap wallet
          </h1>
          <p className="max-w-2xl text-sm uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Each verified Gmail gets a unique wallet generated on the server and bound to that email.
            A different Google account receives a different wallet.
          </p>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="space-y-3 border border-[var(--color-border)] p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Wallet policy
            </p>
            <ul className="space-y-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text)]">
              <li>Unique wallet per verified Google identity.</li>
              <li>Private key encrypted server-side with AES-256-GCM.</li>
              <li>Use only a dedicated Gmail and dedicated funded wallet.</li>
            </ul>
          </div>

          <div className="space-y-4 border border-[var(--color-border)] p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Google verification
            </p>
            {googleClientId ? (
              <div className="space-y-3">
                <div ref={googleButtonRef} className="min-h-[44px]" />
                {isAuthenticating ? (
                  <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
                    Verifying account and allocating wallet...
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-danger)]">
                NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured.
              </p>
            )}

            {authError ? (
              <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-danger)]">{authError}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeaderBar({
  address,
  email,
  selectedChain,
  onToggleChain,
  onOpenSessionCard
}: {
  address?: `0x${string}`;
  email?: string;
  selectedChain: 'sepolia' | 'mainnet';
  onToggleChain: () => void;
  onOpenSessionCard: () => void;
}) {
  return (
    <header className="console-header">
      <div className="mx-auto flex h-[64px] w-full max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <img
              src="/logo.svg"
              alt="WhenCheap logo"
              className="h-6 w-6 shrink-0"
            />
            <p className="text-base font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
              WhenCheap
            </p>
          </div>
          <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
            
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleChain}
            className="console-chip hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
            title={`Switch to ${selectedChain === 'sepolia' ? 'mainnet' : 'sepolia'}`}
          >
            <span className="h-2 w-2 bg-[var(--color-accent)]" />
            <span>{selectedChain === 'mainnet' ? 'Mainnet' : 'Sepolia'}</span>
          </button>
          {email ? (
            <button
              type="button"
              onClick={onOpenSessionCard}
              className="console-chip hidden lg:flex hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
            >
              <span>{email}</span>
            </button>
          ) : null}
          {address ? (
            <button
              type="button"
              onClick={onOpenSessionCard}
              className="console-chip hidden sm:flex hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
            >
              <span>{truncateAddress(address)}</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function SessionCardModal({
  children,
  onClose
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4 py-6">
      <button
        type="button"
        aria-label="Close session details"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[760px]">
        {children}
      </div>
    </div>
  );
}

function SessionCard({
  address,
  email,
  sessionChain,
  onSessionChainChange,
  onLogout,
  onClose
}: {
  address?: `0x${string}`;
  email: string;
  sessionChain: 'sepolia' | 'mainnet';
  onSessionChainChange: (chain: 'sepolia' | 'mainnet') => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const [maxFeePerTxEth, setMaxFeePerTxEth] = useState('0.001');
  const [maxTotalSpendEth, setMaxTotalSpendEth] = useState('0.01');
  const [expiryHours, setExpiryHours] = useState('6');
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [sessionTxHash, setSessionTxHash] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [activeAction, setActiveAction] = useState<'authorize' | 'revoke' | 'disconnect' | null>(null);
  const sessionContractForChain =
    sessionChain === 'mainnet' ? mainnetSessionContractAddress : sessionContractAddress;
  const sessionChainId = sessionChain === 'mainnet' ? mainnet.id : sepolia.id;
  const { data: sessionData, refetch } = useReadContract({
    address: sessionContractForChain,
    abi: whenCheapSessionAbi,
    functionName: 'sessions',
    args: address ? [address] : undefined,
    chainId: sessionChainId,
    query: {
      enabled: Boolean(sessionContractForChain && address)
    }
  });

  useEffect(() => {
    if (!copiedAddress) return;
    const timeout = window.setTimeout(() => setCopiedAddress(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedAddress]);

  async function authorizeSession() {
    if (!address) return;

    try {
      setActiveAction('authorize');
      setSessionMessage(null);
      setSessionTxHash(null);
      setSessionError(null);

      const response = await fetch(`${apiUrl}/intents/wallet/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress: address,
          maxFeePerTxEth,
          maxTotalSpendEth,
          expiryHours,
          chain: sessionChain,
        })
      });

      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.message === 'string' ? payload.message : rawBody || 'Authorization failed');
      }

      setSessionMessage('Session authorized.');
      setSessionTxHash(String(payload.txHash ?? ''));
      await refetch();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Session authorization failed');
    } finally {
      setActiveAction(null);
    }
  }

  async function revokeSession() {
    if (!address) return;

    try {
      setActiveAction('revoke');
      setSessionMessage(null);
      setSessionTxHash(null);
      setSessionError(null);

      const response = await fetch(`${apiUrl}/intents/wallet/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress: address, chain: sessionChain })
      });

      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.message === 'string' ? payload.message : rawBody || 'Revoke failed');
      }

      setSessionMessage('Session revoked.');
      setSessionTxHash(String(payload.txHash ?? ''));
      await refetch();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to revoke session');
    } finally {
      setActiveAction(null);
    }
  }

  function disconnectWallet() {
    setActiveAction('disconnect');
    setSessionMessage(null);
    setSessionTxHash(null);
    setSessionError(null);
    onLogout();
    setSessionMessage('Google session disconnected.');
    setActiveAction(null);
  }

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopiedAddress(true);
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
  const budgetRemainingWei = session
    ? session.maxTotalSpendWei > session.spentWei
      ? session.maxTotalSpendWei - session.spentWei
      : 0n
    : 0n;

  return (
    <ConsolePanel
      title="Session Matrix"
      eyebrow="MANAGED EXECUTION LAYER"
      className="console-glitch-panel"
      action={
        <button type="button" onClick={onClose} className="console-icon-button" aria-label="Close session details">
          <XCircle size={15} />
        </button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 text-[11px] uppercase tracking-[0.16em] md:grid-cols-2">
          <div className="console-subpanel">
            <span className="text-[10px] text-[var(--color-label)]">Active</span>
            <p className="mt-2 text-[var(--color-text)]">{sessionActive ? 'Yes' : 'No'}</p>
          </div>
          <div className="console-subpanel">
            <span className="text-[10px] text-[var(--color-label)]">Google identity</span>
            <p className="mt-2 break-all text-[var(--color-text)] normal-case tracking-normal">{email}</p>
          </div>
        </div>

        <div className="console-subpanel">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-label)]">
              System-generated wallet
            </span>
            <button type="button" onClick={() => void copyAddress()} className="console-icon-button">
              <Copy size={14} />
            </button>
          </div>
          <p className="mt-2 break-all text-sm text-[var(--color-text)]">{address}</p>
          <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            {copiedAddress ? 'Address copied' : 'Allocated to this Google account'}
          </p>
        </div>

        <div className="console-scroll max-h-[70vh] space-y-4 pr-1">
          <div className="grid gap-[1px] border border-[var(--color-border)] bg-[var(--color-border)]">
            <InfoRow label="ACTIVE" value={sessionActive ? 'Yes' : 'No'} />
            <InfoRow label="CHAIN" value={sessionChain === 'mainnet' ? 'Mainnet' : 'Sepolia'} />
            <InfoRow label="BUDGET REMAINING" value={`${formatEther(budgetRemainingWei)} ETH`} />
            <InfoRow label="SPENT" value={session ? `${formatEther(session.spentWei)} ETH` : '0 ETH'} />
            <InfoRow label="EXPIRES" value={expiresAtMs ? new Date(expiresAtMs).toLocaleString() : 'Not set'} />
          </div>

          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Session chain
            </p>
            <div className="flex gap-2">
              {(['sepolia', 'mainnet'] as const).map((chain) => (
                <button
                  key={chain}
                  type="button"
                  onClick={() => onSessionChainChange(chain)}
                  className={`border px-3 py-2 text-[10px] uppercase tracking-[0.18em] ${
                    sessionChain === chain
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-black'
                      : 'border-[var(--color-border)] text-[var(--color-muted)]'
                  }`}
                >
                  {chain === 'mainnet' ? 'Mainnet' : 'Sepolia'}
                </button>
              ))}
            </div>
            {sessionChain === 'mainnet' ? (
              <p className="text-[11px] normal-case tracking-normal text-[var(--color-warning)]">
                Authorizing on mainnet. Real ETH required for gas.
              </p>
            ) : null}
          </div>

          <div className="grid gap-3">
            <label className="space-y-1 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              <span>Per-tx limit</span>
              <input
                value={maxFeePerTxEth}
                onChange={(event) => setMaxFeePerTxEth(event.target.value)}
                className="console-input w-full"
                inputMode="decimal"
              />
            </label>
            <label className="space-y-1 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              <span>Budget</span>
              <input
                value={maxTotalSpendEth}
                onChange={(event) => setMaxTotalSpendEth(event.target.value)}
                className="console-input w-full"
                inputMode="decimal"
              />
            </label>
            <label className="space-y-1 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              <span>Expiry hours</span>
              <input
                value={expiryHours}
                onChange={(event) => setExpiryHours(event.target.value)}
                className="console-input w-full"
                inputMode="numeric"
              />
            </label>
          </div>

          <div className="border border-[var(--color-border)] p-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Managed wallet policy
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              This wallet was generated for your verified Gmail. Session authorization and revocation are executed from the server using the encrypted managed key.
            </p>
          </div>

          <button
            type="button"
            onClick={authorizeSession}
            disabled={activeAction !== null}
            className="console-button console-button-primary w-full"
          >
            <ShieldCheck size={15} />
            {activeAction === 'authorize' ? 'Creating...' : 'Create New Session'}
          </button>

          <div className="flex flex-wrap gap-3 text-[11px] uppercase tracking-[0.14em]">
            <button
              type="button"
              onClick={revokeSession}
              disabled={activeAction !== null && activeAction !== 'revoke'}
              className="console-text-button text-[var(--color-danger)]"
            >
              <XCircle size={14} />
              {activeAction === 'revoke' ? 'Revoking...' : 'Revoke Session'}
            </button>
            <button
              type="button"
              onClick={disconnectWallet}
              className="console-text-button"
            >
              <LogOut size={14} />
              Disconnect
            </button>
          </div>
        </div>

        {sessionMessage ? (
          <div className="console-alert console-alert-success">
            <span className="console-alert-label">System</span>
            <p>
              {sessionMessage}
              {sessionTxHash ? (
                <>
                  {' '}
                  <a
                    href={explorerTxUrl(sessionChain, sessionTxHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--color-accent)] underline"
                  >
                    {shortHash(sessionTxHash)}
                  </a>
                </>
              ) : null}
            </p>
          </div>
        ) : null}
        {sessionError ? (
          <div className="console-alert console-alert-danger">
            <span className="console-alert-label">Error</span>
            <p>{sessionError}</p>
          </div>
        ) : null}
      </div>
    </ConsolePanel>
  );
}

function normalizeIntentChain(chain: string) {
  return isMainnetChain(chain) ? 'mainnet' : 'sepolia';
}

function enforceChainSelection(input: string, chain: 'sepolia' | 'mainnet') {
  const withoutExplicitChain = input
    .replace(/\bon\s+sepolia\b/gi, '')
    .replace(/\bon\s+mainnet\b/gi, '')
    .replace(/\bon\s+ethereum\b/gi, '')
    .replace(/\bon\s+eth\b/gi, '')
    .replace(/\bsepolia\b/gi, '')
    .replace(/\bmainnet\b/gi, '')
    .replace(/\bethereum\b/gi, '')
    .replace(/\beth\b(?=\s+chain\b)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return `${withoutExplicitChain} on ${chain === 'mainnet' ? 'mainnet' : 'sepolia'}`;
}

function CommandCenter({
  intent,
  onCancel,
  isCancelling,
  cancelError
}: {
  intent: IntentRecord;
  onCancel: () => void;
  isCancelling: boolean;
  cancelError: string | null;
}) {
  const details = deriveExecutionDetails(intent);
  const summaryRecipient = intent.parsed.resolvedRecipient
    ? `${intent.parsed.recipient ?? 'ENS'} -> ${intent.parsed.resolvedRecipient}`
    : intent.parsed.recipient ?? intent.parsed.toToken ?? 'Not set';
  const canCancel = isCancellableIntentStatus(intent.status);

  return (
    <ConsolePanel title="Command Center" eyebrow="EXECUTION STATE" className="min-h-0">
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusBadge status={intent.status} />
            <ChainBadge chain={intent.parsed.chain} />
            {canCancel ? (
              <button
                type="button"
                onClick={onCancel}
                disabled={isCancelling}
                className="border border-[var(--color-danger)] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-danger)] disabled:opacity-40"
              >
                {isCancelling ? 'Cancelling...' : 'Cancel'}
              </button>
            ) : null}
          </div>
          <div className="text-right text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
            <div>Intent {intent.id.slice(0, 8)}</div>
            <div className="mt-1">{new Date(intent.createdAt).toLocaleString()}</div>
          </div>
        </div>

        <div className="grid gap-[1px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 xl:grid-cols-3">
          <SummaryField label="Type" value={intent.parsed.type} />
          <SummaryField label="Amount" value={`${intent.parsed.amount} ${intent.parsed.fromToken}`} />
          <SummaryField label="Recipient" value={summaryRecipient} />
          <SummaryField label="Max Fee" value={`$${intent.parsed.maxFeeUsd}`} />
          <SummaryField label="Chain" value={normalizeChainLabel(intent.parsed.chain)} />
          <SummaryField label="Deadline" value={new Date(intent.parsed.deadlineIso).toLocaleString()} />
          <SummaryField label="Slippage" value={`${intent.parsed.slippageBps / 100}%`} />
          <SummaryField label="Wallet" value={truncateAddress(intent.wallet)} />
          <SummaryField label="Tx Hash" value={details.txHash ? shortHash(details.txHash) : 'Pending'} />
          <SummaryField label="Block" value={details.blockNumber ? String(details.blockNumber) : 'Pending'} />
          <SummaryField
            label="Gas Paid"
            value={details.gasPaidWei ? `${formatEther(BigInt(details.gasPaidWei))} ETH` : 'Pending'}
          />
          <SummaryField label="Input" value={intent.rawInput} />
        </div>

        {details.txHash ? (
          <div className="console-subpanel">
            <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-label)]">Explorer</span>
            <a
              href={explorerTxUrl(intent.parsed.chain, details.txHash)}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] underline"
            >
              Open transaction {shortHash(details.txHash)}
            </a>
          </div>
        ) : null}

        {intent.parsed.notes ? (
          <div className="border border-dashed border-[var(--color-warning)] px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-warning)]">
            {intent.parsed.notes}
          </div>
        ) : null}

        {cancelError && canCancel ? (
          <div className="console-alert console-alert-danger">
            <span className="console-alert-label">Error</span>
            <p>{cancelError}</p>
          </div>
        ) : null}

        <div className="console-subpanel flex-1">
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-label)]">Execution feed</span>
          <div className="console-scroll mt-3 h-[180px] space-y-4 pr-1">
            {intent.audit.slice(0, 8).map((event) => (
              <div key={event.id} className={`border-l-2 pl-3 ${auditBorderClass(event.type)}`}>
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-label)]">
                  {event.type}
                </div>
                <div className="mt-1 text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--color-text)]">
                  {event.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ConsolePanel>
  );
}

function AuditTrail({ intent }: { intent: IntentRecord }) {
  return (
    <ConsolePanel title="Audit Trail" eyebrow="LIVE TERMINAL" className="min-h-0">
      <div className="console-scroll h-full min-h-[560px] space-y-4 pr-1">
        {intent.audit.map((event, index) => (
          <div key={event.id} className={`terminal-line ${auditToneClass(event.type)}`} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}>
            <div className="terminal-meta">
              <span className="opacity-50">{formatAuditTime(event.at)}</span>
              <span>{event.type}</span>
            </div>
            <p className="mt-1 text-xs uppercase tracking-[0.12em] text-[var(--color-text)]">{event.message}</p>
          </div>
        ))}
      </div>
    </ConsolePanel>
  );
}

function CommandCenterEmpty() {
  return (
    <ConsolePanel title="Command Center" eyebrow="EXECUTION STATE" className="min-h-0">
      <div className="flex h-full min-h-[640px] items-center justify-center px-6 py-12 text-center">
        <div className="space-y-3">
          <div className="text-4xl text-[var(--color-accent)]">⚡</div>
          <h2 className="text-lg font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
            Create your first command
          </h2>
          <p className="max-w-sm text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            Verify with Google, use the assigned wallet, and submit a command to start execution.
          </p>
        </div>
      </div>
    </ConsolePanel>
  );
}

function AuditTrailEmpty() {
  return (
    <ConsolePanel title="Audit Trail" eyebrow="LIVE TERMINAL" className="min-h-0">
      <div className="flex h-full min-h-[640px] items-center justify-center px-6 py-12 text-center">
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
            No events yet
          </p>
          <p className="max-w-xs text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            Audit events will stream here after the first intent is created and evaluated.
          </p>
        </div>
      </div>
    </ConsolePanel>
  );
}

function RecentCommandsPanel({
  intents,
  selectedId,
  onSelect,
  onRefresh,
  isLoading,
  onCancel,
  cancellingIntentId
}: {
  intents: IntentRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  onCancel: (id: string) => void;
  cancellingIntentId: string | null;
}) {
  return (
    <ConsolePanel
      title="Recent Commands"
      eyebrow="QUEUE"
      action={
        <button
          type="button"
          onClick={onRefresh}
          className="console-icon-button"
          title="Refresh intents"
        >
          <RefreshCcw size={14} />
        </button>
      }
      className="min-h-0"
    >
      <div className="console-scroll grid h-full min-h-0 gap-2 pr-1 xl:grid-cols-3">
        {isLoading ? (
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            Loading intents...
          </p>
        ) : intents.length === 0 ? (
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            No commands queued.
          </p>
        ) : (
          intents.map((intent) => (
            <div
              key={intent.id}
              className={`console-list-item ${selectedId === intent.id ? 'console-list-item-active' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onSelect(intent.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-xs uppercase tracking-[0.14em] text-[var(--color-text)]">
                    {intent.rawInput}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                    {new Date(intent.createdAt).toLocaleString()}
                  </p>
                </button>
                <div className="flex items-center gap-2">
                  <ChainBadge chain={intent.parsed.chain} compact />
                  {isCancellableIntentStatus(intent.status) ? (
                    <button
                      type="button"
                      onClick={() => onCancel(intent.id)}
                      disabled={cancellingIntentId === intent.id}
                      className="border border-[var(--color-danger)] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-danger)] disabled:opacity-40"
                    >
                      {cancellingIntentId === intent.id ? 'Cancelling...' : 'Cancel'}
                    </button>
                  ) : null}
                  <StatusBadge status={intent.status} compact />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </ConsolePanel>
  );
}

function ConsolePanel({
  title,
  eyebrow,
  action,
  children,
  className = ''
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`console-panel ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-[var(--color-border)] pb-3">
        <div>
          {eyebrow ? (
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">{eyebrow}</p>
          ) : null}
          <h2 className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
            {title}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoRow({
  label,
  value
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-[1px] bg-[var(--color-border)]">
      <span className="bg-[var(--color-surface)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
        {label}
      </span>
      <span className="bg-[var(--color-surface)] px-3 py-2 text-right text-xs uppercase tracking-[0.12em] text-[var(--color-text)]">
        {value}
      </span>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-4">
      <dt className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--color-label)]">{label}</dt>
      <dd className="mt-2 break-words text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--color-text)]">
        {value}
      </dd>
    </div>
  );
}

function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  const { bg, text, border } = statusTone(status);
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-medium uppercase tracking-[0.18em] ${bg} ${text} ${border} ${
        compact ? 'text-[10px]' : 'text-[11px]'
      }`}
    >
      {normalizeStatusLabel(status)}
    </span>
  );
}

function ChainBadge({ chain, compact = false }: { chain: string; compact?: boolean }) {
  const mainnet = isMainnetChain(chain);
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-medium uppercase tracking-[0.18em] ${
        mainnet
          ? 'border-[var(--color-warning)] bg-[rgba(255,145,0,0.08)] text-[var(--color-warning)]'
          : 'border-[var(--color-border)] bg-[rgba(255,255,255,0.03)] text-[#b5b5b5]'
      } ${compact ? 'text-[10px]' : 'text-[11px]'}`}
    >
      {mainnet ? 'MAINNET' : 'SEPOLIA'}
    </span>
  );
}

function extractEnsCandidate(input: string): string | null {
  const match = input.match(/\b[a-z0-9-]+\.eth\b/i);
  return match?.[0] ?? null;
}

function truncateAddress(value: string) {
  if (!value) return '';
  return value.length > 10 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function shortHash(hash: string) {
  return hash.length > 14 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash;
}

function explorerTxUrl(chain: string, hash: string) {
  return isMainnetChain(chain)
    ? `https://etherscan.io/tx/${hash}`
    : `https://sepolia.etherscan.io/tx/${hash}`;
}

function normalizeChainLabel(chain: string) {
  return isMainnetChain(chain) ? 'ethereum' : 'sepolia';
}

function normalizeStatusLabel(status: string) {
  const upper = status.toUpperCase();
  if (upper === 'PENDING_INTENT') return 'PENDING';
  if (upper === 'DEADLINE_EXCEEDED') return 'EXPIRED';
  if (upper === 'NEEDS_REAUTHORIZATION') return 'NEEDS REAUTH';
  if (upper === 'FINALIZED') return 'CONFIRMED';
  return upper.replaceAll('_', ' ');
}

function statusTone(status: string) {
  const upper = status.toUpperCase();
  if (upper === 'FINALIZED') {
    return {
      bg: 'bg-[rgba(77,255,163,0.08)]',
      text: 'text-[#4dffa3]',
      border: 'border-[#4dffa3]'
    };
  }
  if (upper === 'SUBMITTED' || upper === 'CONFIRMING') {
    return {
      bg: 'bg-[rgba(77,163,255,0.08)]',
      text: 'text-[var(--color-info)]',
      border: 'border-[var(--color-info)]'
    };
  }
  if (upper === 'GAS_CHECK_FAILED' || upper === 'NEEDS_REAUTHORIZATION') {
    return {
      bg: 'bg-[rgba(255,145,0,0.08)]',
      text: 'text-[var(--color-warning)]',
      border: 'border-[var(--color-warning)]'
    };
  }
  if (upper === 'STUCK' || upper === 'DEADLINE_EXCEEDED') {
    return {
      bg: 'bg-[rgba(255,59,48,0.08)]',
      text: 'text-[var(--color-danger)]',
      border: 'border-[var(--color-danger)]'
    };
  }
  if (upper === 'CANCELLED') {
    return {
      bg: 'bg-[rgba(255,255,255,0.03)]',
      text: 'text-[var(--color-muted)]',
      border: 'border-[var(--color-border)]'
    };
  }
  if (upper === 'PENDING_INTENT') {
    return {
      bg: 'bg-[rgba(255,255,255,0.03)]',
      text: 'text-[var(--color-muted)]',
      border: 'border-[var(--color-border)]'
    };
  }
  return {
    bg: 'bg-[rgba(255,255,255,0.03)]',
    text: 'text-[var(--color-muted)]',
    border: 'border-[var(--color-border)]'
  };
}

function isMainnetChain(chain: string) {
  return ['ethereum', 'mainnet', 'eth'].includes(chain.toLowerCase());
}

function showsMainnetSwapWarning(input: string) {
  return /\bswap\b/i.test(input);
}

function isCancellableIntentStatus(status: string) {
  const upper = status.toUpperCase();
  return [
    'PENDING_INTENT',
    'SUBMITTED',
    'CONFIRMING',
    'NEEDS_REAUTHORIZATION'
  ].includes(upper);
}

function auditToneClass(type: string) {
  const upper = type.toUpperCase();
  if (upper.includes('EIP7702')) return 'terminal-info';
  if (upper.includes('PASSED') || upper.includes('CONFIRMED') || upper.includes('FINALIZED')) {
    return 'terminal-success';
  }
  if (upper.includes('FAILED') || upper.includes('STUCK')) {
    return 'terminal-danger';
  }
  if (upper.includes('WARNING') || upper.includes('SKIPPED')) {
    return 'terminal-warning';
  }
  return 'terminal-neutral';
}

function auditBorderClass(type: string) {
  const upper = type.toUpperCase();
  if (upper.includes('PASSED') || upper.includes('CONFIRMED') || upper.includes('FINALIZED')) {
    return 'border-[var(--color-accent)]';
  }
  if (upper.includes('FAILED') || upper.includes('STUCK') || upper.includes('INVALID')) {
    return 'border-[var(--color-danger)]';
  }
  if (upper.includes('WARNING') || upper.includes('SKIPPED')) {
    return 'border-[var(--color-warning)]';
  }
  return 'border-[var(--color-border)]';
}

function deriveExecutionDetails(intent: IntentRecord): ExecutionDetails {
  let txHash = intent.txHash;
  let blockNumber: number | string | undefined;
  let gasPaidWei: string | undefined;

  for (const event of intent.audit) {
    const metadata = event.metadata;
    if (!metadata) continue;

    if (!txHash && typeof metadata.txHash === 'string') {
      txHash = metadata.txHash;
    }
    if (!blockNumber && (typeof metadata.blockNumber === 'number' || typeof metadata.blockNumber === 'string')) {
      blockNumber = metadata.blockNumber;
    }
    if (!gasPaidWei && typeof metadata.feePaidWei === 'string') {
      gasPaidWei = metadata.feePaidWei;
    }
  }

  return { txHash, blockNumber, gasPaidWei };
}

function formatAuditTime(at: string) {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
