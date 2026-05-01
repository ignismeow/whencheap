'use client';

import {
  Copy,
  LogOut,
  RefreshCcw,
  Send,
  ShieldCheck,
  XCircle
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther, parseEther } from 'viem';
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

type ParsedIntentPayload = {
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

type IntentRecord = {
  id: string;
  wallet: string;
  rawInput: string;
  status: string;
  txHash?: string;
  blockNumber?: number | null;
  lastError?: string | null;
  parsed: ParsedIntentPayload;
  createdAt: string;
  updatedAt: string;
  audit: AuditEvent[];
};

type ExecutionDetails = {
  txHash?: string;
  blockNumber?: number | string;
  gasPaidWei?: string;
};

type FeeDetails = {
  feeWei: string;
  feeBps: number;
  feeTxHash?: string | null;
};

type DraftIntentEstimate = {
  type: 'send' | 'swap';
  amount: string;
  fromToken: string;
  chain: 'sepolia' | 'mainnet';
  amountWei: bigint;
  gasEstimateWei: bigint;
  feeWei: bigint;
  totalWei: bigint;
};

type ManagedIdentity = {
  email: string;
  address: `0x${string}`;
  created?: boolean;
};

type ChatMessage = {
  id: string;
  role: 'agent' | 'user';
  content: string;
  timestamp: Date;
  intentId?: string;
};

type IntentPreviewResponse = {
  parsed: ParsedIntentPayload;
  providerUsed: string;
  deadlineMinutes: number | null;
};

type GasSuggestion = {
  currentCosts: {
    sendUsd: number;
    swapUsd: number;
    sendGwei: number;
    swapGwei: number;
  };
  recommendedMaxFeeGwei: number;
  recommendedMaxFeeUsd: number;
  bestWindowMinutes: number;
  estimatedSavingsUsd: number;
  estimatedSavingsPct: number;
  urgency: 'high' | 'medium' | 'low';
  trend: 'rising' | 'falling' | 'stable';
  trendPct: number;
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
};

type PendingIntentPreview = {
  normalizedInput: string;
  preview: IntentPreviewResponse;
};

type SessionStatus = {
  active: boolean;
  maxFeePerTxEth: string;
  maxTotalSpendEth: string;
  spentEth: string;
  remainingEth: string;
  expiresAt: string | null;
  expiresInMinutes: number;
  canExecute: boolean;
  estimatedFeeEth: string;
};

type SessionHealthLevel = 'green' | 'yellow' | 'red' | 'loading';

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
          prompt: () => void;
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

const apiUrl = '/api';
const fetcher = (url: string) => fetch(url).then((res) => res.json());
const sessionStatusFetcher = async (url: string) => {
  const response = await fetch(url);
  const payload = (await response.json()) as SessionStatus & { message?: string };

  if (!response.ok) {
    throw new Error(payload.message ?? 'Failed to load session status');
  }

  return payload;
};

async function fetchGasSuggestion(preview: IntentPreviewResponse): Promise<GasSuggestion | null> {
  const parsed = preview.parsed;
  const params = new URLSearchParams({
    type: parsed.type === 'swap' ? 'swap' : 'send',
    chain: normalizeIntentChain(parsed.chain),
  });

  if (preview.deadlineMinutes) {
    params.set('deadline', String(preview.deadlineMinutes));
  }

  const response = await fetch(`${apiUrl}/gas/suggestion?${params.toString()}`);
  if (!response.ok) return null;

  return (await response.json()) as GasSuggestion;
}

const authStorageKey = 'whencheap-google-identity';
const chainStorageKey = 'whencheap-selected-chain';
const EXECUTION_FEE_BPS = 30n;
const GAS_UNITS = { send: 21_000n, swap: 150_000n } as const;
const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? '';

export default function Home() {
  const router = useRouter();
  const [input, setInput] = useState('Send 0.001 ETH to 0x9dD40426fe0dbaF3d28B4fe7f499231e6FFd3873 when gas is under $1 in next 30 minutes'
);
  const [selectedChain, setSelectedChain] = useState<'sepolia' | 'mainnet'>('sepolia');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingIntentId, setCancellingIntentId] = useState<string | null>(null);
  const [managedIdentity, setManagedIdentity] = useState<ManagedIdentity | null>(null);
  const [isSessionCardOpen, setIsSessionCardOpen] = useState(false);
  const [ensCandidate, setEnsCandidate] = useState<string | null>(null);
  const [resolvedEnsAddress, setResolvedEnsAddress] = useState<string | null>(null);
  const [ensResolutionError, setEnsResolutionError] = useState<string | null>(null);
  const [isResolvingEns, setIsResolvingEns] = useState(false);
  const [liveGasPriceWei, setLiveGasPriceWei] = useState<bigint | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [pendingIntentPreview, setPendingIntentPreview] = useState<PendingIntentPreview | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'agent',
      content:
        "Hey! I'm WhenCheap.\n\nTell me what you want to swap or send. Try:\n\n\"Swap 0.001 ETH to USDC when gas is under $2 on Sepolia\"",
      timestamp: new Date(),
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const pollingIntervalsRef = useRef<Record<string, number>>({});

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
  const draftIntentEstimate = useMemo(
    () => deriveDraftIntentEstimate(input, selectedChain, liveGasPriceWei),
    [input, selectedChain, liveGasPriceWei],
  );
  const sessionStatusUrl = effectiveAddress
    ? `${apiUrl}/intents/session/status/${effectiveAddress}?chain=${selectedChain}&type=${draftIntentEstimate?.type ?? 'send'}`
    : null;
  const { data: sessionStatus, mutate: mutateSessionStatus } = useSWR<SessionStatus>(
    sessionStatusUrl,
    sessionStatusFetcher,
    {
      refreshInterval: 30000,
      keepPreviousData: true,
      revalidateOnFocus: false,
    },
  );
  const sessionHealth = useMemo(
    () => deriveSessionHealth(sessionStatus),
    [sessionStatus],
  );

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSubmitting]);

  useEffect(() => {
    return () => {
      Object.values(pollingIntervalsRef.current).forEach((intervalId) => window.clearInterval(intervalId));
      pollingIntervalsRef.current = {};
    };
  }, []);

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
    const rpcUrl = getRpcUrlForChain(selectedChain);
    if (!rpcUrl) {
      setLiveGasPriceWei(null);
      return;
    }

    let active = true;

    const fetchGasPrice = async () => {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_gasPrice',
            params: [],
          }),
        });
        const payload = (await response.json()) as { result?: string };
        if (active && payload.result) {
          setLiveGasPriceWei(BigInt(payload.result));
        }
      } catch {
        if (active) {
          setLiveGasPriceWei(null);
        }
      }
    };

    void fetchGasPrice();
    const interval = window.setInterval(() => void fetchGasPrice(), 30000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedChain]);

  function signOutManagedIdentity() {
    setManagedIdentity(null);
    setSelectedId(null);
    window.localStorage.removeItem(authStorageKey);
    window.google?.accounts.id.disableAutoSelect();
  }

  function addAgentMessage(content: string, intentId?: string) {
    setMessages((prev) => [
      ...prev,
      {
        id: `${intentId ?? 'agent'}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role: 'agent',
        content,
        timestamp: new Date(),
        intentId,
      },
    ]);
  }

  function describePreview(preview: IntentPreviewResponse, gas: GasSuggestion | null) {
    const { parsed, deadlineMinutes } = preview;
    const costKey = parsed.type === 'swap' ? 'swapUsd' : 'sendUsd';
    const currentCostUsd = gas?.currentCosts?.[costKey] ?? 0;
    const gasCostLine = gas
      ? `⛽ Gas now: $${currentCostUsd.toFixed(8)} (${gas.trend})`
      : '';
    const recLine = gas
      ? `💡 Rec. max fee: $${gas.recommendedMaxFeeUsd.toFixed(8)} (${gas.recommendedMaxFeeGwei.toFixed(6)} Gwei)`
      : '';
    const savingsLine =
      gas && gas.estimatedSavingsPct > 10
        ? `💰 Savings: Wait ~${gas.bestWindowMinutes}min -> save ~${gas.estimatedSavingsPct.toFixed(0)}% on gas`
        : '';
    const vsAvgLine = gas
      ? gas.trend === 'falling'
        ? '📉 Signal: Gas is falling - good time to execute'
        : gas.trend === 'rising'
          ? '📈 Signal: Gas is rising - consider executing now'
          : '📊 Signal: Gas is stable near average'
      : '';
    const recTextLine = gas?.recommendation ? `\n🧠 Recommendation: ${gas.recommendation}` : '';
    const gasSection = [gasCostLine, recLine, savingsLine, vsAvgLine].filter(Boolean).join('\n');

    return (
      `Here's what I understood:\n\n` +
      `📤 Type: ${parsed.type}\n` +
      `💰 Amount: ${parsed.amount} ${parsed.fromToken}\n` +
      `${parsed.toToken ? `🔄 To: ${parsed.toToken}\n` : ''}` +
      `${parsed.recipient ? `📬 Recipient: ${truncateAddress(parsed.recipient)}\n` : ''}` +
      `⛽ Max fee: $${parsed.maxFeeUsd}\n` +
      `🔗 Chain: ${normalizeIntentChain(parsed.chain) === 'mainnet' ? 'Mainnet' : 'Sepolia'}\n` +
      `${deadlineMinutes ? `⏰ Deadline: ${deadlineMinutes} min\n` : ''}` +
      `${gasSection ? `\n─────────────────\n${gasSection}${recTextLine}\n─────────────────` : ''}` +
      `\n\nConfirm to execute or cancel to start over.`
    );
  }

  function startPolling(intentId: string) {
    if (pollingIntervalsRef.current[intentId]) {
      window.clearInterval(pollingIntervalsRef.current[intentId]);
    }

    let lastStatus = '';
    const statusMessages: Record<string, (intent: IntentRecord) => string> = {
      PENDING_INTENT: () => '⏳ Monitoring gas prices...',
      GAS_CHECK_PASSED: () => '⛽ Gas is under your limit - executing now...',
      SWAP_EXECUTING: (intent) =>
        `🔄 Broadcasting your swap to ${normalizeIntentChain(intent.parsed.chain) === 'mainnet' ? 'Mainnet' : 'Sepolia'}...`,
      SUBMITTED: (intent) =>
        intent.parsed.type === 'swap'
          ? `🔄 Broadcasting your swap to ${normalizeIntentChain(intent.parsed.chain) === 'mainnet' ? 'Mainnet' : 'Sepolia'}...\n${intent.parsed.amount} ${intent.parsed.fromToken} -> ${intent.parsed.toToken ?? 'USDC'}`
          : '📡 Broadcast accepted. Waiting for confirmations...',
      CONFIRMING: () => '📡 Transaction seen onchain. Confirming now...',
      CONFIRMED: (intent) => {
        const details = deriveExecutionDetails(intent);
        const txHash = details.txHash ?? intent.txHash;
        const destination = intent.parsed.toToken ?? intent.parsed.recipient ?? 'destination';
        const explorerLine = txHash ? `View on Etherscan -> ${explorerUrlForIntent(intent, txHash)}` : 'View on Etherscan ->';
        return (
          `🎉 Done! ${intent.parsed.type === 'swap' ? 'Swap' : 'Transaction'} confirmed.\n\n` +
          `${intent.parsed.amount} ${intent.parsed.fromToken} -> ${destination}\n` +
          `Block: ${details.blockNumber ?? intent.blockNumber ?? 'N/A'}\n` +
          `⛽ Gas paid: ${details.gasPaidWei ? formatWeiAsGwei(details.gasPaidWei) : 'N/A'} Gwei\n` +
          `${txHash ? `Tx: ${txHash.slice(0, 10)}...${txHash.slice(-6)}\n\n` : '\n'}` +
          explorerLine
        );
      },
      FINALIZED: (intent) =>
        `Execution complete.\n\n${intent.parsed.amount} ${intent.parsed.fromToken} -> ${intent.parsed.toToken ?? intent.parsed.recipient ?? 'destination'}\n${
          intent.txHash ? `View: ${explorerUrlForIntent(intent, intent.txHash)}` : ''
        }`.trim(),
      EXECUTION_FAILED: () => '⚠️ Execution failed - retrying on next gas check.',
      FAILED: (intent) =>
        `❌ Intent failed.\n\n${intent.lastError ?? 'Could not complete this transaction.'}\n\nCreate a new intent to try again.`,
      NEEDS_REAUTHORIZATION: () => '🔐 Session expired. Please re-authorize your wallet to continue.',
      NEEDS_REAUTH: () => '🔐 Session expired. Please re-authorize your wallet to continue.',
      INSUFFICIENT_BALANCE: () => '💸 Insufficient balance to cover this command.',
      CANCELLED: () => '🚫 Intent cancelled.',
      STUCK: () => '⚠️ Intent is stuck. Try cancelling and creating a new one.',
      DEADLINE_EXCEEDED: () => '⏰ The intent deadline passed before execution.',
    };

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiUrl}/intents/${intentId}`);
        if (!response.ok) return;

        const intent = (await response.json()) as IntentRecord;
        if (intent.status === lastStatus) return;
        lastStatus = intent.status;

        const buildMessage = statusMessages[intent.status];
        if (buildMessage) {
          addAgentMessage(buildMessage(intent), intentId);
        }

        if (
          [
            'FINALIZED',
            'CONFIRMED',
            'CANCELLED',
            'STUCK',
            'FAILED',
            'DEADLINE_EXCEEDED',
            'INSUFFICIENT_BALANCE',
          ].includes(intent.status)
        ) {
          window.clearInterval(intervalId);
          delete pollingIntervalsRef.current[intentId];
          void mutate();
        }
      } catch {
        // Keep polling quietly during transient frontend/network failures.
      }
    }, 4000);

    pollingIntervalsRef.current[intentId] = intervalId;
  }

  async function submitConfirmedIntent(previewToSubmit: PendingIntentPreview) {
    if (!effectiveAddress) {
      throw new Error('Verify with Google first.');
    }

    const response = await fetch(`${apiUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: effectiveAddress,
        input: previewToSubmit.normalizedInput,
        parsed: previewToSubmit.preview.parsed,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || 'Intent creation failed');
    }

    return (await response.json()) as IntentRecord;
  }

  async function handleQuickReply(action: 'confirm' | 'cancel') {
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content: action,
        timestamp: new Date(),
      },
    ]);
    setInput('');

    if (action === 'cancel') {
      setAwaitingConfirmation(false);
      setPendingIntentPreview(null);
      addAgentMessage('Cancelled. What would you like to do instead?');
      return;
    }

    if (!pendingIntentPreview) {
      addAgentMessage('There is no pending intent to confirm. Start with a new message.');
      setAwaitingConfirmation(false);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const created = await submitConfirmedIntent(pendingIntentPreview);
      setSelectedId(created.id);
      await mutate();
      addAgentMessage(
        `Intent #${created.id.slice(0, 8).toUpperCase()} created.\n\n` +
          `${created.parsed.amount} ${created.parsed.fromToken} -> ${created.parsed.toToken ?? created.parsed.recipient ?? 'destination'}\n` +
          `Max fee: $${created.parsed.maxFeeUsd ?? 1}\n` +
          `Chain: ${normalizeIntentChain(created.parsed.chain) === 'mainnet' ? 'Mainnet' : 'Sepolia'}\n\n` +
          'Monitoring gas now...',
        created.id,
      );
      startPolling(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Intent creation failed';
      setError(message);
      addAgentMessage(`I couldn't create that intent.\n\n${message}`);
    } finally {
      setAwaitingConfirmation(false);
      setPendingIntentPreview(null);
      setIsSubmitting(false);
    }
  }

  async function handleSend() {
    if (!effectiveAddress) {
      setError('Verify with Google first.');
      addAgentMessage('Verify with Google first so I can create intents from your managed wallet.');
      return;
    }
    if (!input.trim() || isSubmitting) return;

    const userText = input.trim();
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content: userText,
        timestamp: new Date(),
      },
    ]);

    setInput('');

    if (awaitingConfirmation) {
      const command = userText.toLowerCase();
      if (command === 'confirm') {
        await handleQuickReply('confirm');
      } else if (command === 'cancel') {
        await handleQuickReply('cancel');
      } else {
        addAgentMessage('Type "confirm" to proceed or "cancel" to start over.');
      }
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const normalizedInput = enforceChainSelection(userText, selectedChain);
      const previewPromise = fetch(`${apiUrl}/intents/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: effectiveAddress, input: normalizedInput })
      }).then(async (response) => {
        if (!response.ok) {
          const body = await response.text();
          throw new Error(body || 'Intent creation failed');
        }

        return (await response.json()) as IntentPreviewResponse;
      });

      const [preview, gasSuggestion] = await Promise.all([
        previewPromise,
        previewPromise.then(fetchGasSuggestion).catch(() => null),
      ]);
      setPendingIntentPreview({ normalizedInput, preview });
      setAwaitingConfirmation(true);
      addAgentMessage(describePreview(preview, gasSuggestion));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Intent preview failed';
      setError(message);
      addAgentMessage(
        `I couldn't parse that intent.\n\n${message}\n\nTry: "Swap 0.001 ETH to USDC when gas is under $2 on Sepolia"`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function createIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleSend();
  }

  function submitIntentOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
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
        <LandingHero onLaunch={() => router.push('/login')} />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <HeaderBar
        address={effectiveAddress}
        email={managedIdentity.email}
        selectedChain={selectedChain}
        sessionHealth={sessionHealth}
        onToggleChain={() =>
          setSelectedChain((current) => (current === 'sepolia' ? 'mainnet' : 'sepolia'))
        }
        onOpenSessionCard={() => setIsSessionCardOpen(true)}
      />

      <div className="console-root">
        <aside className="console-sidebar">
          <ConsolePanel title="Intent Input" eyebrow="Translate Natural Language" className="console-intent-panel">
            <form onSubmit={createIntent} className="flex h-full min-h-0 flex-col space-y-4">
              <div className="console-scroll flex min-h-[220px] flex-1 flex-col gap-3 px-4 py-3 xl:min-h-[320px]">
                {messages.map((msg) => (
                  <ChatMessageBubble key={msg.id} message={msg} />
                ))}

                {isSubmitting ? (
                  <div className="flex items-start gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] font-bold text-black">
                      W
                    </div>
                    <div className="flex gap-1 rounded-[18px] rounded-tl-[4px] border border-[var(--color-border)] bg-zinc-900 px-3 py-3">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: '0ms' }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: '150ms' }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>

              <div className="px-4 pb-2">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={submitIntentOnEnter}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-[var(--color-accent)] focus:outline-none"
                  placeholder="Swap 0.001 ETH to USDC when gas < $2..."
                />
                <p className="mt-1 text-[10px] normal-case tracking-normal text-[var(--color-muted)]">
                  Press Enter to send · Shift+Enter for new line
                </p>
              </div>

              {awaitingConfirmation ? (
                <div className="flex gap-2 px-4 pb-2">
                  <button
                    type="button"
                    onClick={() => void handleQuickReply('confirm')}
                    className="flex-1 rounded-lg bg-[var(--color-accent)] py-2 text-xs font-medium text-black"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleQuickReply('cancel')}
                    className="flex-1 rounded-lg bg-zinc-700 py-2 text-xs text-white"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}

              <div className="space-y-2 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
                <div className="console-subpanel">
                  <span className="block text-[10px] text-[var(--color-label)]">Managed wallet</span>
                  <span className="mt-1 block text-[var(--color-text)]">{truncateAddress(effectiveAddress ?? '')}</span>
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
              </div>

              <div className="space-y-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="console-button console-button-primary w-full"
                >
                  <Send size={15} />
                  {isSubmitting ? 'Creating Command...' : 'Create Intent'}
                </button>
                <p className="text-[10px] normal-case tracking-normal text-[var(--color-muted)]">
                  0.3% execution fee applies on confirmed transactions.
                </p>
                {/\bswap\b/i.test(input) && selectedChain === 'sepolia' ? (
                  <p className="text-[10px] normal-case tracking-normal text-[var(--color-warning)]">
                    Demo note: Sepolia currently supports ETH -&gt; token swaps only. Try ETH -&gt; USDC or ETH -&gt; DAI.
                  </p>
                ) : null}
              </div>
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
            draftIntentEstimate={draftIntentEstimate}
            sessionStatus={sessionStatus ?? null}
            sessionHealth={sessionHealth}
            refreshSessionStatus={() => mutateSessionStatus()}
            onSessionChainChange={setSelectedChain}
            onLogout={signOutManagedIdentity}
            onClose={() => setIsSessionCardOpen(false)}
          />
        </SessionCardModal>
      ) : null}
    </main>
  );
}

function LandingHero({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="hero-gateway">
      <div className="hero-grid" />
      <div className="hero-scanline" />
      <header className="hero-header">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="WhenCheap logo" className="h-7 w-7 shrink-0" />
          <span className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
            WhenCheap
          </span>
        </div>
        {/* <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
          v1.0.4-beta
        </span> */}
      </header>

      <div className="hero-core">
        <div className="hero-pulse" />
      </div>

      <div className="hero-content">
        
        <h1 className="hero-title">
          Defi Intent-based automation
        </h1>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          Reliable execution. Managed gas. No seed phrases required.
        </p>
       

        <div className="mt-8 flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={onLaunch}
            className="hero-launch-button"
          >
            [ Launch App ]
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatMessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="chat-bubble chat-bubble-user">
          <ChatMessageContent content={message.content} role="user" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="chat-avatar">W</div>
      <div className="chat-bubble chat-bubble-agent">
        <ChatMessageContent content={message.content} role="agent" />
      </div>
    </div>
  );
}

function ChatMessageContent({
  content,
  role,
}: {
  content: string;
  role: 'agent' | 'user';
}) {
  const lines = content.split('\n').map((line) => line.trimEnd());
  const structuredLinePattern =
    /^(?:\S+\s+)?(Type|Amount|To|Recipient|Max gas fee|Max fee|Chain|Deadline|Gas now|Rec\. max fee|Savings|Signal|Recommendation|Gas paid|Tx|View):/i;
  const structuredLines = lines.filter(
    (line) => structuredLinePattern.test(line),
  );
  const hasStructuredContent = role === 'agent' && structuredLines.length >= 2;
  const header = lines[0] ?? '';
  const trailingNote =
    role === 'agent' &&
    /^(Type "confirm" to execute or "cancel" to start over\.|Confirm to execute or cancel to start over\.)$/i.test(
      lines.at(-1) ?? '',
    )
      ? (lines.at(-1) ?? '')
      : null;

  if (hasStructuredContent) {
    const introLines = lines.filter(
      (line) =>
        line &&
        !structuredLinePattern.test(line) &&
        line !== '─────────────────' &&
        line !== trailingNote,
    );

    return (
      <div className="space-y-3">
        {introLines.length > 0 ? (
          <div className="space-y-2">
            {introLines.map((line, index) => (
              <p
                key={`${line}-${index}`}
                className={`chat-message-line ${index === 0 ? 'chat-message-title' : ''}`}
              >
                {renderInlineContent(line, role)}
              </p>
            ))}
          </div>
        ) : null}

        <div className="chat-structured-card">
          {structuredLines.map((line, index) => {
            const [rawLabel, ...rest] = line.split(':');
            const value = rest.join(':').trim();
            return (
              <div key={`${line}-${index}`} className="chat-structured-row">
                <span className="chat-structured-label">{rawLabel}</span>
                <span className="chat-structured-value">{renderInlineContent(value, role)}</span>
              </div>
            );
          })}
        </div>

        {trailingNote ? <p className="chat-message-note">{trailingNote}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {lines.map((line, index) =>
        line ? (
          <p
            key={`${line}-${index}`}
            className={`chat-message-line ${index === 0 && role === 'agent' ? 'chat-message-title' : ''}`}
          >
            {renderInlineContent(line, role)}
          </p>
        ) : (
          <div key={`spacer-${index}`} className="h-1.5" />
        ),
      )}
    </div>
  );
}

function HeaderBar({
  address,
  email,
  selectedChain,
  sessionHealth,
  onToggleChain,
  onOpenSessionCard
}: {
  address?: `0x${string}`;
  email?: string;
  selectedChain: 'sepolia' | 'mainnet';
  sessionHealth: { level: SessionHealthLevel; label: string };
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
        </div>

        <div className="flex items-center gap-2">
          <a
            href="/gas"
            className="console-chip hidden md:flex hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
          >
            <span>Gas Analytics</span>
          </a>
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
              <span className={`h-2 w-2 ${healthDotClassName(sessionHealth.level)}`} />
              <span>{email}</span>
            </button>
          ) : null}
          {address ? (
            <button
              type="button"
              onClick={onOpenSessionCard}
              className="console-chip hidden sm:flex hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
            >
              <span className={`h-2 w-2 ${healthDotClassName(sessionHealth.level)}`} />
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
  draftIntentEstimate,
  sessionStatus,
  sessionHealth,
  refreshSessionStatus,
  onSessionChainChange,
  onLogout,
  onClose
}: {
  address?: `0x${string}`;
  email: string;
  sessionChain: 'sepolia' | 'mainnet';
  draftIntentEstimate: DraftIntentEstimate | null;
  sessionStatus: SessionStatus | null;
  sessionHealth: { level: SessionHealthLevel; label: string };
  refreshSessionStatus: () => Promise<SessionStatus | undefined>;
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
  const { data: feeBpsData } = useReadContract({
    address: sessionContractForChain,
    abi: whenCheapSessionAbi,
    functionName: 'feeBps',
    chainId: sessionChainId,
    query: {
      enabled: Boolean(sessionContractForChain)
    }
  });
  const { data: treasuryData } = useReadContract({
    address: sessionContractForChain,
    abi: whenCheapSessionAbi,
    functionName: 'treasury',
    chainId: sessionChainId,
    query: {
      enabled: Boolean(sessionContractForChain)
    }
  });
  const { data: feeForAmountData } = useReadContract({
    address: sessionContractForChain,
    abi: whenCheapSessionAbi,
    functionName: 'feeForAmount',
    args: draftIntentEstimate ? [draftIntentEstimate.amountWei] : undefined,
    chainId: sessionChainId,
    query: {
      enabled: Boolean(sessionContractForChain && draftIntentEstimate)
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
      await refreshSessionStatus();
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
      await refreshSessionStatus();
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

  const onChainFeeBps = typeof feeBpsData === 'bigint' ? Number(feeBpsData) : Number(EXECUTION_FEE_BPS);
  const onChainFeeWei =
    draftIntentEstimate?.type === 'swap'
      ? (draftIntentEstimate?.feeWei ?? 0n)
      : typeof feeForAmountData === 'bigint'
        ? feeForAmountData
        : draftIntentEstimate?.feeWei ?? 0n;
  const draftTotalWei = draftIntentEstimate
    ? draftIntentEstimate.amountWei + onChainFeeWei + draftIntentEstimate.gasEstimateWei
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
            <span className="text-[10px] text-[var(--color-label)]">Session health</span>
            <div className="mt-2 flex items-center gap-2 text-[var(--color-text)]">
              <span className={`h-2.5 w-2.5 ${healthDotClassName(sessionHealth.level)}`} />
              <span>{sessionHealth.label}</span>
            </div>
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
            <InfoRow
              label="ACTIVE"
              value={
                <span
                  className={
                    !sessionStatus
                      ? 'text-zinc-400'
                      : sessionStatus.active
                        ? 'text-emerald-400'
                        : 'text-red-500'
                  }
                >
                  {!sessionStatus ? 'CHECKING...' : sessionStatus.active ? 'YES' : 'NO'}
                </span>
              }
            />
            <InfoRow label="CHAIN" value={sessionChain === 'mainnet' ? 'Mainnet' : 'Sepolia'} />
            <InfoRow label="BUDGET REMAINING" value={`${sessionStatus?.remainingEth ?? '0'} ETH`} />
            <InfoRow label="SPENT" value={`${sessionStatus?.spentEth ?? '0'} ETH`} />
            <InfoRow
              label="EXPIRES"
              value={
                !sessionStatus
                  ? 'Checking...'
                  : sessionStatus.active && sessionStatus.expiresAt
                  ? `in ${sessionStatus.expiresInMinutes} minutes (${new Date(sessionStatus.expiresAt).toLocaleString()})`
                  : 'Not Set'
              }
            />
            <InfoRow label="MAX FEE/TX" value={`${sessionStatus?.maxFeePerTxEth ?? '0'} ETH`} />
            <InfoRow
              label="CAN EXECUTE"
              value={
                <span
                  className={
                    !sessionStatus
                      ? 'text-zinc-400'
                      : sessionStatus.canExecute
                        ? 'text-emerald-400'
                        : 'text-red-500'
                  }
                >
                  {!sessionStatus ? 'CHECKING...' : sessionStatus.canExecute ? 'YES' : 'NO'}
                </span>
              }
            />
          </div>

          {sessionHealth.level === 'yellow' && sessionStatus ? (
            <div className="console-alert border-[var(--color-warning)] text-[var(--color-warning)]">
              <span className="console-alert-label">Warning</span>
              <p>
                Current estimated fee is above 80% of the per-tx session limit. Raise the limit if you want more headroom during gas spikes.
              </p>
            </div>
          ) : null}

          {sessionHealth.level === 'red' ? (
            <div className="console-alert border-[var(--color-danger)] text-[var(--color-danger)]">
              <span className="console-alert-label">Status</span>
              <p>
                Session is expired, unavailable, or cannot execute with the current estimated fee.
              </p>
            </div>
          ) : null}

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
              Minimum balance required
            </p>
            {draftIntentEstimate ? (
              <>
                <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                  For {draftIntentEstimate.amount} {draftIntentEstimate.fromToken} {draftIntentEstimate.type} intent:
                </p>
                <div className="mt-3 grid gap-[1px] bg-[var(--color-border)]">
                  <InfoRow
                    label={draftIntentEstimate.type === 'swap' ? 'Swap amount' : 'Amount'}
                    value={`${formatEthFixed(draftIntentEstimate.amountWei)} ETH`}
                  />
                  <InfoRow label="Gas est" value={`${formatEthFixed(draftIntentEstimate.gasEstimateWei)} ETH`} />
                  <InfoRow
                    label={`Platform fee (${(onChainFeeBps / 100).toFixed(1)}%)`}
                    value={`${formatEthFixed(onChainFeeWei)} ETH`}
                  />
                  <InfoRow
                    label={draftIntentEstimate.type === 'swap' ? 'Total charged' : 'Total'}
                    value={`${formatEthFixed(draftTotalWei)} ETH`}
                  />
                </div>
                {draftIntentEstimate.type === 'swap' ? (
                  <p className="mt-3 text-[11px] normal-case tracking-normal text-[var(--color-muted)]">
                    You will receive the output for exactly {draftIntentEstimate.amount} {draftIntentEstimate.fromToken} swapped, plus gas is charged separately.
                  </p>
                ) : null}
                {draftIntentEstimate.type === 'swap' && draftIntentEstimate.chain === 'sepolia' ? (
                  <p className="mt-2 text-[11px] normal-case tracking-normal text-[var(--color-warning)]">
                    Demo supports ETH -&gt; USDC and ETH -&gt; DAI on Sepolia. Token -&gt; ETH routes are intentionally blocked for now.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                Enter an ETH send or ETH -&gt; token swap intent to calculate the minimum wallet funding requirement.
              </p>
            )}
          </div>

          <div className="border border-[var(--color-border)] p-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Managed wallet policy
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              This wallet was generated for your verified Gmail. Session authorization and revocation are executed from the server using the encrypted managed key.
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Platform fee: {(onChainFeeBps / 100).toFixed(1)}% (enforced on-chain)
            </p>
            <p className="mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Treasury: {typeof treasuryData === 'string' ? truncateAddress(treasuryData) : 'Loading...'}
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

function getUniswapEndpointForIntent(intent: IntentRecord): 'swap_7702' | 'swap' {
  const endpoint = intent.audit.find((event) => {
    const value = event.metadata?.uniswapEndpoint;
    return value === 'swap' || value === 'swap_7702';
  })?.metadata?.uniswapEndpoint;
  return endpoint === 'swap' ? 'swap' : 'swap_7702';
}

function renderInlineContent(value: string, role: 'agent' | 'user') {
  const urlMatch = value.match(/https?:\/\/\S+/i);
  if (!urlMatch) {
    return value;
  }

  const url = urlMatch[0];
  const before = value.slice(0, urlMatch.index ?? 0);
  const after = value.slice((urlMatch.index ?? 0) + url.length);

  return (
    <>
      {before}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={role === 'user' ? 'underline' : 'text-[var(--color-accent)] underline'}
      >
        {url}
      </a>
      {after}
    </>
  );
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
  const feeDetails = deriveFeeDetails(intent);
  const summaryRecipient = intent.parsed.resolvedRecipient
    ? `${intent.parsed.recipient ?? 'ENS'} -> ${intent.parsed.resolvedRecipient}`
    : intent.parsed.recipient ?? intent.parsed.toToken ?? 'Not set';
  const canCancel = isCancellableIntentStatus(intent.status);

  return (
    <ConsolePanel title="Command Center" eyebrow="Execution State" className="min-h-0">
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
          {intent.status === 'FINALIZED' && feeDetails ? (
            <SummaryField
              label="Fee Collected"
              value={`${formatEther(BigInt(feeDetails.feeWei))} ETH (${feeDetails.feeBps / 100}%)`}
            />
          ) : null}
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

        {/* <div className="console-subpanel flex-1">
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
        </div> */}
      </div>
    </ConsolePanel>
  );
}

function AuditTrail({ intent }: { intent: IntentRecord }) {
  return (
    <ConsolePanel title="Audit Trail" eyebrow="Live Terminal" className="min-h-0">
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
    <ConsolePanel title="Command Center" eyebrow="Execution State" className="min-h-0">
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
    <ConsolePanel title="Audit Trail" eyebrow="Live Terminal" className="min-h-0">
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
      eyebrow="Queue"
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
            <p className="text-[10px] capitalize tracking-[0.18em] text-[var(--color-label)]">{eyebrow}</p>
          ) : null}
          <h2 className="mt-1 text-sm font-medium capitalize tracking-[0.18em] text-[var(--color-text)]">
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
      <span className="bg-[var(--color-surface)] px-3 py-2 text-[10px] capitalize tracking-[0.18em] text-[var(--color-label)]">
        {label}
      </span>
      <span className="bg-[var(--color-surface)] px-3 py-2 text-right text-xs capitalize tracking-[0.12em] text-[var(--color-text)]">
        {value}
      </span>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-4">
      <dt className="text-[10px] font-medium capitalize tracking-[0.18em] text-[var(--color-label)]">{label}</dt>
      <dd className="mt-2 break-words text-[13px] font-bold capitalize tracking-[0.08em] text-[var(--color-text)]">
        {value}
      </dd>
    </div>
  );
}

function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  const { bg, text, border } = statusTone(status);
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-medium capitalize tracking-[0.18em] ${bg} ${text} ${border} ${
        compact ? 'text-[10px]' : 'text-[11px]'
      }`}
    >
      {normalizeStatusLabel(status)}
    </span>
  );
}

function deriveSessionHealth(
  sessionStatus?: SessionStatus | null,
): { level: SessionHealthLevel; label: string } {
  if (!sessionStatus) {
    return { level: 'loading', label: 'Checking...' };
  }

  if (!sessionStatus.active) {
    return { level: 'red', label: 'Red' };
  }

  const estimatedFee = Number(sessionStatus.estimatedFeeEth);
  const maxFeePerTx = Number(sessionStatus.maxFeePerTxEth);

  if (!sessionStatus.canExecute) {
    return { level: 'yellow', label: 'Warning' };
  }

  if (maxFeePerTx > 0 && estimatedFee / maxFeePerTx > 0.8) {
    return { level: 'yellow', label: 'Warning' };
  }

  return { level: 'green', label: 'Green' };
}

function healthDotClassName(level: SessionHealthLevel) {
  if (level === 'loading') {
    return 'rounded-full bg-zinc-500 shadow-[0_0_10px_rgba(113,113,122,0.45)]';
  }

  if (level === 'green') {
    return 'rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]';
  }

  if (level === 'yellow') {
    return 'rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]';
  }

  return 'rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.65)]';
}

function formatEthFixed(value: bigint): string {
  return Number.parseFloat(formatEther(value)).toFixed(6);
}

function formatWeiAsGwei(value: string): string {
  try {
    const wei = BigInt(value);
    const whole = wei / 1_000_000_000n;
    const fractional = (wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return fractional ? `${whole}.${fractional}` : whole.toString();
  } catch {
    return 'N/A';
  }
}

function ChainBadge({ chain, compact = false }: { chain: string; compact?: boolean }) {
  const mainnet = isMainnetChain(chain);
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-medium capitalize tracking-[0.18em] ${
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

function explorerUrlForIntent(intent: IntentRecord, hash: string) {
  return explorerTxUrl(intent.parsed.chain, hash);
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
  if (
    upper.includes('PASSED') ||
    upper.includes('CONFIRMED') ||
    upper.includes('FINALIZED') ||
    upper.includes('COLLECTED')
  ) {
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

function deriveFeeDetails(intent: IntentRecord): FeeDetails | null {
  const event = intent.audit.find((item) => item.type === 'FEE_COLLECTED');
  if (!event?.metadata) return null;

  const feeWei = event.metadata.feeWei;
  const feeBps = event.metadata.feeBps;
  const feeTxHash = event.metadata.feeTxHash;

  if (typeof feeWei !== 'string' || typeof feeBps !== 'number') {
    return null;
  }

  return {
    feeWei,
    feeBps,
    feeTxHash: typeof feeTxHash === 'string' ? feeTxHash : null,
  };
}

function deriveDraftIntentEstimate(
  input: string,
  selectedChain: 'sepolia' | 'mainnet',
  liveGasPriceWei: bigint | null,
): DraftIntentEstimate | null {
  const type = /\bswap\b/i.test(input) ? 'swap' : /\bsend\b/i.test(input) ? 'send' : null;
  const amountMatch = input.match(/(?:send|swap)\s+([0-9]*\.?[0-9]+)/i);
  const tokenMatch = input.match(/(?:send|swap)\s+[0-9]*\.?[0-9]+\s+([a-zA-Z]+)/i);
  const amount = amountMatch?.[1] ?? '0.001';
  const fromToken = tokenMatch?.[1]?.toUpperCase() ?? 'ETH';

  if (!type) return null;

  try {
    const amountWei = fromToken === 'ETH' || fromToken === 'WETH' ? parseEther(amount) : 0n;
    const gasPriceWei = liveGasPriceWei ?? 0n;
    const gasEstimateWei = (gasPriceWei * 12n * GAS_UNITS[type]) / 10n;
    const feeWei = (amountWei * EXECUTION_FEE_BPS) / 10000n;
    const totalWei = amountWei + gasEstimateWei + feeWei;

    return {
      type,
      amount,
      fromToken,
      chain: selectedChain,
      amountWei,
      gasEstimateWei,
      feeWei,
      totalWei,
    };
  } catch {
    return null;
  }
}

function getRpcUrlForChain(chain: 'sepolia' | 'mainnet') {
  if (!alchemyKey) return null;
  return chain === 'mainnet'
    ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
    : `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`;
}

function formatAuditTime(at: string) {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
