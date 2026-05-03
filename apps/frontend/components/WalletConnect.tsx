'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { formatEther, parseEther } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import {
  whenCheapSessionAbi,
  sessionContractAddress,
  mainnetSessionContractAddress,
} from '../lib/session-contract';
import { UiError, toWalletUiError } from '../lib/ui-errors';

type TxStep = 'idle' | 'checking' | 'signing' | 'confirming' | 'registering';
type SessionFlowState = 'DISCONNECTED' | 'CHECKING' | 'READY' | 'NEEDS_DEPOSIT' | 'NEEDS_AUTH' | 'WRONG_NETWORK';
type PendingOutcome =
  | { kind: 'deposit'; expectedDepositWei: bigint }
  | { kind: 'authorize' };

type SessionStatusResponse = {
  active: boolean;
  maxFeePerTxEth: string;
  maxTotalSpendEth: string;
  spentEth: string;
  remainingEth: string;
  expiresAt: string | null;
  expiresInMinutes: number;
  canExecute: boolean;
  estimatedFeeEth: string;
  message?: string;
};

const Spinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      border: '1.5px solid rgba(0,0,0,0.3)',
      borderTopColor: '#000',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }}
  />
);

function fmtEth(wei?: bigint | null): string {
  if (wei === undefined || wei === null) return '...';
  return parseFloat(formatEther(wei)).toFixed(6);
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return 'Expired';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

async function readJsonSafely<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(raw);
  }
}

export function WalletConnect({
  onAuthorized,
  mode = 'setup',
}: {
  onAuthorized: (address: string) => void;
  mode?: 'setup' | 'status-only';
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [depositAmount, setDepositAmount] = useState('0.01');
  const [maxFeePerTxEth, setMaxFeePerTxEth] = useState('0.01');
  const [maxTotalSpendEth, setMaxTotalSpendEth] = useState('0.5');
  const [expiryHours, setExpiryHours] = useState('24');
  const [txStep, setTxStep] = useState<TxStep>('idle');
  const [statusError, setStatusError] = useState<UiError | null>(null);
  const [actionError, setActionError] = useState<UiError | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusResponse | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  const [pendingOutcome, setPendingOutcome] = useState<PendingOutcome | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | null>(null);
  const hasAutoContinuedRef = useRef(false);

  const hasMetaMask =
    typeof window !== 'undefined' &&
    typeof (window as Window & { ethereum?: unknown }).ethereum !== 'undefined';
  const isSupportedChain = chainId === sepolia.id || chainId === mainnet.id;
  const activeChain = chainId === mainnet.id ? 'mainnet' : 'sepolia';
  const sessionContract = chainId === mainnet.id ? mainnetSessionContractAddress : sessionContractAddress;
  const isBusy = txStep !== 'idle';
  const isStatusOnly = mode === 'status-only';

  useEffect(() => {
    if (!isStatusOnly || !address || !isConnected || !isSupportedChain || hasAutoContinuedRef.current) {
      return;
    }

    hasAutoContinuedRef.current = true;
    onAuthorized(address);
  }, [address, isConnected, isStatusOnly, isSupportedChain, onAuthorized]);

  const {
    data: depositWei,
    refetch: refetchDeposit,
    isLoading: isDepositLoading,
    isFetched: hasFetchedDeposit,
  } = useReadContract({
    address: sessionContract,
    abi: whenCheapSessionAbi,
    functionName: 'deposits',
    args: address ? [address] : undefined,
    chainId,
    query: {
      enabled: Boolean(!isStatusOnly && isConnected && address && sessionContract && isSupportedChain),
      refetchInterval: 10_000,
    },
  });

  const {
    data: onChainSession,
    refetch: refetchSession,
    isLoading: isSessionLoading,
    isFetched: hasFetchedSession,
  } = useReadContract({
    address: sessionContract,
    abi: whenCheapSessionAbi,
    functionName: 'sessions',
    args: address ? [address] : undefined,
    chainId,
    query: {
      enabled: Boolean(!isStatusOnly && isConnected && address && sessionContract && isSupportedChain),
      refetchInterval: 10_000,
    },
  });

  useEffect(() => {
    if (!successMessage) return;
    const timeout = window.setTimeout(() => setSuccessMessage(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [successMessage]);

  useEffect(() => {
    if (!sessionStatus) return;
    if (parseFloat(sessionStatus.maxFeePerTxEth) > 0) {
      setMaxFeePerTxEth(sessionStatus.maxFeePerTxEth);
    }
    if (parseFloat(sessionStatus.maxTotalSpendEth) > 0) {
      setMaxTotalSpendEth(sessionStatus.maxTotalSpendEth);
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (isStatusOnly) return undefined;
    if (!isConnected || !address || !sessionContract || !isSupportedChain) return undefined;

    const interval = window.setInterval(() => {
      setStatusTick((current) => current + 1);
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [address, isConnected, isStatusOnly, isSupportedChain, sessionContract]);

  useEffect(() => {
    if (isStatusOnly) {
      setSessionStatus(null);
      setStatusError(null);
      setIsLoadingSession(false);
      return;
    }

    if (!isConnected || !address || !sessionContract || !isSupportedChain) {
      setSessionStatus(null);
      setStatusError(null);
      setIsLoadingSession(false);
      return;
    }

    let cancelled = false;

    const loadSessionStatus = async () => {
      setIsLoadingSession(true);
      setStatusError(null);

      try {
        const response = await fetch(
          `/api/intents/session/status/${address}?chain=${activeChain}&type=send`,
          { cache: 'no-store' },
        );
        const payload = await readJsonSafely<SessionStatusResponse>(response);
        if (!response.ok) {
          throw new Error(payload.message ?? 'Failed to load session status.');
        }
        if (!cancelled) {
          setSessionStatus(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError(toWalletUiError(err, 'Session Check Failed'));
          if (!hasFetchedDeposit && !hasFetchedSession) {
            setSessionStatus(null);
          }
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSession(false);
        }
      }
    };

    void loadSessionStatus();

    return () => {
      cancelled = true;
    };
  }, [activeChain, address, hasFetchedDeposit, hasFetchedSession, isConnected, isStatusOnly, isSupportedChain, sessionContract, statusTick]);

  const chainSnapshot = useMemo<SessionStatusResponse | null>(() => {
    if (depositWei === undefined || !onChainSession) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = Number(onChainSession[3]);
    const remainingBudgetWei = onChainSession[1] > onChainSession[2]
      ? onChainSession[1] - onChainSession[2]
      : 0n;

    return {
      active: expiresAtSeconds > nowSeconds,
      maxFeePerTxEth: formatEther(onChainSession[0]),
      maxTotalSpendEth: formatEther(onChainSession[1]),
      spentEth: formatEther(onChainSession[2]),
      remainingEth: formatEther(remainingBudgetWei),
      expiresAt: expiresAtSeconds > 0 ? new Date(expiresAtSeconds * 1000).toISOString() : null,
      expiresInMinutes: expiresAtSeconds > nowSeconds
        ? Math.max(0, Math.ceil((expiresAtSeconds - nowSeconds) / 60))
        : 0,
      canExecute: depositWei > 0n && expiresAtSeconds > nowSeconds,
      estimatedFeeEth: '0',
    };
  }, [depositWei, onChainSession]);

  const effectiveSessionStatus = sessionStatus ?? chainSnapshot;
  const contractDataLoading = isDepositLoading || isSessionLoading || (!hasFetchedDeposit && !hasFetchedSession);

  const sessionMetrics = useMemo(() => {
    const hasDeposit = depositWei !== undefined && depositWei > 0n;
    const depositEth = fmtEth(depositWei);
    const onChainActive = onChainSession ? Number(onChainSession[3]) * 1000 > Date.now() : false;
    const expiresInMinutes = effectiveSessionStatus?.expiresInMinutes ?? (
      onChainSession ? Math.max(0, Math.ceil((Number(onChainSession[3]) * 1000 - Date.now()) / 60_000)) : 0
    );

    return {
      hasDeposit,
      depositEth,
      active: effectiveSessionStatus?.active ?? onChainActive,
      expiresInMinutes,
      remainingEth: effectiveSessionStatus?.remainingEth ?? (onChainSession ? formatEther(onChainSession[1] > onChainSession[2] ? onChainSession[1] - onChainSession[2] : 0n) : '0'),
      spentEth: effectiveSessionStatus?.spentEth ?? (onChainSession ? formatEther(onChainSession[2]) : '0'),
      maxFeePerTxEth: effectiveSessionStatus?.maxFeePerTxEth ?? (onChainSession ? formatEther(onChainSession[0]) : maxFeePerTxEth),
    };
  }, [depositWei, effectiveSessionStatus, maxFeePerTxEth, onChainSession]);

  const flowState: SessionFlowState = useMemo(() => {
    if (!isConnected || !address) return 'DISCONNECTED';
    if (!isSupportedChain || !sessionContract) return 'WRONG_NETWORK';
    if (isLoadingSession || contractDataLoading) return 'CHECKING';
    if (sessionMetrics.hasDeposit && sessionMetrics.active) return 'READY';
    if (sessionMetrics.hasDeposit) return 'NEEDS_AUTH';
    return 'NEEDS_DEPOSIT';
  }, [address, contractDataLoading, isConnected, isLoadingSession, isSupportedChain, sessionContract, sessionMetrics]);

  const refreshAll = async () => {
    await Promise.all([refetchDeposit(), refetchSession()]);
    setStatusTick((current) => current + 1);
  };

  const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const hasConfirmationTimedOut = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|wait for transaction receipt/i.test(message);
  };

  const verifyPendingOutcome = async (outcome: PendingOutcome) => {
    if (!address || !publicClient || !sessionContract) return false;

    if (outcome.kind === 'deposit') {
      const latestDeposit = await publicClient.readContract({
        address: sessionContract,
        abi: whenCheapSessionAbi,
        functionName: 'deposits',
        args: [address],
      });
      return latestDeposit >= outcome.expectedDepositWei;
    }

    const latestSession = await publicClient.readContract({
      address: sessionContract,
      abi: whenCheapSessionAbi,
      functionName: 'sessions',
      args: [address],
    });
    return Number(latestSession[3]) * 1000 > Date.now();
  };

  const resolvePendingOutcome = async (hash: `0x${string}`, outcome: PendingOutcome) => {
    if (!publicClient) throw new Error('No public client');

    setTxStep('confirming');
    setPendingOutcome(outcome);
    setPendingTxHash(hash);

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 2_000,
        timeout: 30_000,
      });
      if (receipt.status !== 'success') {
        throw new Error(`Transaction reverted (tx: ${hash})`);
      }
      return;
    } catch (error) {
      if (!hasConfirmationTimedOut(error)) {
        throw error;
      }

      for (let attempt = 0; attempt < 15; attempt += 1) {
        await sleep(2_000);
        const resolved = await verifyPendingOutcome(outcome).catch(() => false);
        if (resolved) {
          return;
        }
      }

      throw new Error(
        'Confirmation is taking longer than expected. We could not verify the latest contract state yet. Please check MetaMask or Etherscan if this persists.',
      );
    } finally {
      setPendingOutcome(null);
    }
  };

  const explorerBaseUrl = activeChain === 'mainnet'
    ? 'https://etherscan.io'
    : 'https://sepolia.etherscan.io';

  const registerSessionMarker = async () => {
    if (!address) throw new Error('Wallet not connected.');

    setTxStep('registering');
    const res = await fetch('/api/intents/authorize-wallet-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress: address,
        maxFeePerTxEth,
        maxTotalSpendEth,
        expiryHours,
        chain: activeChain,
      }),
    });

    const result = await readJsonSafely<{ ok?: boolean; message?: string }>(res);
    if (!res.ok || !result.ok) {
      throw new Error(result.message ?? 'Failed to register session.');
    }
  };

  const handleAuthorize = async () => {
    if (!address || !publicClient || !sessionContract) {
      setActionError({
        title: 'Wallet Not Ready',
        message: !sessionContract ? 'Session contract is not configured for this network.' : 'Connect your wallet before authorizing.',
      });
      return;
    }

    setActionError(null);
    setSuccessMessage(null);
    setPendingTxHash(null);

    try {
      setTxStep('signing');
      const hash = await writeContractAsync({
        address: sessionContract,
        abi: whenCheapSessionAbi,
        functionName: 'authorize',
        args: [
          parseEther(maxFeePerTxEth),
          parseEther(maxTotalSpendEth),
          BigInt(Math.max(1, Number(expiryHours || '0'))) * 3600n,
        ],
        gas: 100_000n,
      });
      await resolvePendingOutcome(hash, { kind: 'authorize' });
      await registerSessionMarker();
      await refreshAll();
      setSuccessMessage(sessionMetrics.hasDeposit ? 'Session extended. You are ready to create intents.' : 'Session authorized. Next: deposit ETH.');
    } catch (err) {
      setActionError(toWalletUiError(err, 'Authorization Failed'));
    } finally {
      setTxStep('idle');
      setPendingTxHash(null);
    }
  };

  const handleDeposit = async () => {
    if (!address || !publicClient || !sessionContract) {
      setActionError({
        title: 'Wallet Not Ready',
        message: !sessionContract ? 'Session contract is not configured for this network.' : 'Connect your wallet before depositing.',
      });
      return;
    }

    setActionError(null);
    setSuccessMessage(null);
    setPendingTxHash(null);
    const parsed = parseFloat(depositAmount);
    if (!depositAmount || Number.isNaN(parsed) || parsed <= 0) {
      setActionError({ title: 'Invalid Amount', message: 'Enter a valid deposit amount before continuing.' });
      return;
    }

    try {
      const amountWei = parseEther(depositAmount);
      setTxStep('signing');
      const hash = await writeContractAsync({
        address: sessionContract,
        abi: whenCheapSessionAbi,
        functionName: 'deposit',
        value: amountWei,
        gas: 60_000n,
      });
      await resolvePendingOutcome(hash, {
        kind: 'deposit',
        expectedDepositWei: (depositWei ?? 0n) + amountWei,
      });
      await refreshAll();
      setSuccessMessage(sessionMetrics.active ? `Deposit received. Balance is now funded.` : 'Deposit received. Next: authorize your session.');
      setDepositAmount('0.01');
    } catch (err) {
      setActionError(toWalletUiError(err, 'Deposit Failed'));
    } finally {
      setTxStep('idle');
      setPendingTxHash(null);
    }
  };

  const statusCard = (() => {
    if (flowState === 'READY') {
      return {
        tone: 'var(--color-accent)',
        label: 'Ready to Create Intents',
        body: "Your wallet is funded and the session is active.",
      };
    }
    if (flowState === 'NEEDS_AUTH') {
      return {
        tone: 'var(--color-warning)',
        label: 'Session Setup Required',
        body: 'Deposit found. Re-authorize this wallet to resume automated execution.',
      };
    }
    if (flowState === 'NEEDS_DEPOSIT') {
      return {
        tone: 'var(--color-warning)',
        label: 'Session Setup Required',
        body: 'No deposit found on the current session contract. Add ETH to continue.',
      };
    }
    if (flowState === 'WRONG_NETWORK') {
      return {
        tone: 'var(--color-danger)',
        label: 'Wrong Network',
        body: 'Switch MetaMask to Sepolia or Mainnet to continue.',
      };
    }
    if (flowState === 'CHECKING') {
      return {
        tone: 'var(--color-label)',
        label: 'Checking Session',
        body: 'Loading wallet and session details...',
      };
    }
    return {
      tone: 'var(--color-label)',
      label: 'Connect Wallet',
      body: 'Connect MetaMask to check your session status.',
    };
  })();

  return (
    <div className="flex flex-col gap-4">
      <ConnectButton.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          const connected = mounted && !!account && !!chain;
          const wrongNetwork = connected && !isSupportedChain;

          return (
            <>
              {!connected ? (
                <div className="space-y-3">
                  <button type="button" onClick={openConnectModal} className="console-button w-full">
                    Connect Wallet
                  </button>
                  {!hasMetaMask ? (
                    <a
                      href="https://metamask.io/download/"
                      target="_blank"
                      rel="noreferrer"
                      className="console-text-button"
                    >
                      Install MetaMask
                    </a>
                  ) : null}
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={wrongNetwork ? openChainModal : openAccountModal}
                    className="console-button"
                    style={{ fontSize: '10px', padding: '8px 12px', flexShrink: 0 }}
                  >
                    {chain.hasIcon && chain.iconUrl ? (
                      <img
                        src={chain.iconUrl}
                        alt={chain.name ?? 'chain'}
                        style={{ width: 12, height: 12, borderRadius: 0 }}
                      />
                    ) : null}
                    {wrongNetwork ? 'Switch Network' : chain.name ?? 'Unknown'}
                  </button>
                  <button
                    type="button"
                    onClick={openAccountModal}
                    className="console-button flex-1"
                    style={{ fontSize: '10px', padding: '8px 12px' }}
                  >
                    {account.displayName}
                  </button>
                </div>
              )}
            </>
          );
        }}
      </ConnectButton.Custom>

      {!isStatusOnly ? (
        <div
          style={{
            border: '1px solid var(--color-border)',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            background: 'rgba(255,255,255,0.01)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusCard.tone,
                boxShadow: `0 0 10px ${statusCard.tone}`,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: statusCard.tone }}>
              {flowState === 'READY' ? '✓ ' : flowState === 'NEEDS_AUTH' || flowState === 'NEEDS_DEPOSIT' ? '⚠ ' : flowState === 'WRONG_NETWORK' ? '✗ ' : ''}
              {statusCard.label}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {statusCard.body}
          </p>
          {address ? (
            <p style={{ margin: 0, fontSize: 10, color: 'var(--color-muted)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              Connected: {`${address.slice(0, 6)}...${address.slice(-4)}`}
            </p>
          ) : null}
        </div>
      ) : null}

      {!isStatusOnly && statusError && !effectiveSessionStatus && !contractDataLoading ? (
        <div className="console-alert console-alert-danger">
          <span className="console-alert-label">{statusError.title}</span>
          <p>{statusError.message}</p>
          {statusError.details ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
                Technical details
              </summary>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: 'var(--color-muted)' }}>
                {statusError.details}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}

      {!isStatusOnly && isConnected && isSupportedChain ? (
        <div className="grid gap-3 border border-[var(--color-border)] p-4">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            <Metric label="Deposit Balance" value={flowState === 'CHECKING' ? 'Loading...' : `${sessionMetrics.depositEth} ETH`} />
            <Metric label="Budget Remaining" value={flowState === 'CHECKING' ? 'Loading...' : `${sessionMetrics.remainingEth} ETH`} />
            <Metric label="Expires" value={flowState === 'CHECKING' ? 'Loading...' : formatDuration(sessionMetrics.expiresInMinutes)} />
            <Metric label="Max Fee / Tx" value={flowState === 'CHECKING' ? 'Loading...' : `${sessionMetrics.maxFeePerTxEth} ETH`} />
          </div>

          {isStatusOnly ? (
            <div className="grid gap-2">
              <p style={{ margin: 0, fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                {address && isSupportedChain
                  ? 'Wallet connected. Opening console...'
                  : address && !isSupportedChain
                    ? 'Switch to Sepolia or Mainnet to continue.'
                    : 'Connect MetaMask to continue.'}
              </p>
            </div>
          ) : flowState === 'READY' ? (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => address && onAuthorized(address)}
                  className="console-button console-button-primary"
                >
                  Create Intent
                </button>
                <button
                  type="button"
                  onClick={handleDeposit}
                  disabled={isBusy}
                  className="console-button"
                  title="Add more ETH to cover additional executions."
                >
                  {txStep === 'signing' || txStep === 'confirming' ? <><Spinner /> {txStep === 'signing' ? 'Sign...' : 'Pending...'}</> : 'Top Up Deposit'}
                </button>
                <button
                  type="button"
                  onClick={handleAuthorize}
                  disabled={isBusy}
                  className="console-button"
                  title="Refresh the session duration and limits on the current contract."
                >
                  {txStep === 'registering' ? <><Spinner /> Registering...</> : 'Extend Session'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(event) => setDepositAmount(event.target.value)}
                  min="0.001"
                  step="0.001"
                  className="console-input flex-1"
                  style={{ fontSize: 12 }}
                />
                <span style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  ETH
                </span>
              </div>
            </>
          ) : null}

          {!isStatusOnly && flowState === 'NEEDS_DEPOSIT' ? (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <label style={{ fontSize: 10, color: 'var(--color-label)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
                  Deposit ETH
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={(event) => setDepositAmount(event.target.value)}
                    min="0.001"
                    step="0.001"
                    className="console-input flex-1"
                    style={{ fontSize: 12 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    ETH
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Deposit covers intent execution costs. You can top up anytime.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDeposit}
                disabled={isBusy}
                className="console-button console-button-primary w-full"
                title="Fund the current session contract before authorizing automation."
              >
                {txStep === 'signing' || txStep === 'confirming' ? <><Spinner /> {txStep === 'signing' ? 'Sign in MetaMask...' : 'Waiting for confirmation...'}</> : 'Deposit ETH'}
              </button>
            </div>
          ) : null}

          {!isStatusOnly && flowState === 'NEEDS_AUTH' ? (
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <LabeledInput label="Max Fee / Tx" value={maxFeePerTxEth} onChange={setMaxFeePerTxEth} />
                <LabeledInput label="Budget" value={maxTotalSpendEth} onChange={setMaxTotalSpendEth} />
                <LabeledInput label="Expiry Hours" value={expiryHours} onChange={setExpiryHours} inputMode="numeric" />
              </div>
              <button
                type="button"
                onClick={handleAuthorize}
                disabled={isBusy}
                className="console-button console-button-primary w-full"
                title="Authorize the current contract to execute within these limits."
              >
                {txStep === 'signing' || txStep === 'confirming' || txStep === 'registering'
                  ? <><Spinner /> {txStep === 'signing' ? 'Sign in MetaMask...' : txStep === 'confirming' ? 'Waiting for confirmation...' : 'Registering session...'}</>
                  : sessionMetrics.hasDeposit ? 'Re-authorize Session' : 'Authorize Session'}
              </button>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Next: authorize your session so the agent can execute within your on-chain limits.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isStatusOnly && successMessage ? (
        <div className="console-alert console-alert-success">
          <span className="console-alert-label">Success</span>
          <p>{successMessage}</p>
        </div>
      ) : null}

      {!isStatusOnly && txStep === 'confirming' && pendingOutcome ? (
        <div className="console-alert">
          <span className="console-alert-label">Waiting for Confirmation</span>
          <p>
            {pendingOutcome.kind === 'deposit'
              ? 'MetaMask has submitted your deposit. We are waiting for the chain to confirm it.'
              : 'MetaMask has submitted your authorization. We are waiting for the chain to confirm it.'}
          </p>
          {pendingTxHash ? (
            <a
              href={`${explorerBaseUrl}/tx/${pendingTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="console-text-button"
              style={{ alignSelf: 'flex-start' }}
            >
              View transaction on Etherscan
            </a>
          ) : null}
        </div>
      ) : null}

      {!isStatusOnly && actionError ? (
        <div className="console-alert console-alert-danger">
          <span className="console-alert-label">{actionError.title}</span>
          <p>{actionError.message}</p>
          {actionError.details ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
                Technical details
              </summary>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: 'var(--color-muted)' }}>
                {actionError.details}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}

      {!isStatusOnly && isConnected ? (
        <p
          style={{
            fontSize: 10,
            letterSpacing: '0.12em',
            color: 'var(--color-muted)',
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          Session status is checked automatically when your wallet connects.
        </p>
      ) : null}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-label)' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: 'var(--color-text)', letterSpacing: '0.04em' }}>
        {value}
      </span>
    </>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  inputMode = 'decimal',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'decimal' | 'numeric';
}) {
  return (
    <label className="grid gap-1">
      <span style={{ fontSize: 10, color: 'var(--color-label)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        className="console-input"
        style={{ fontSize: 12 }}
      />
    </label>
  );
}
