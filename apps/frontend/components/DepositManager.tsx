'use client';

import { useEffect, useState } from 'react';
import { useAccount, useWriteContract, usePublicClient, useReadContract } from 'wagmi';
import { formatEther, parseEther } from 'viem';
import { whenCheapSessionAbi, sessionContractAddress, mainnetSessionContractAddress } from '../lib/session-contract';
import { UiError, toWalletUiError } from '../lib/ui-errors';

const Spinner = () => (
  <span style={{
    display: 'inline-block', width: 9, height: 9,
    border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'currentColor',
    borderRadius: '50%', animation: 'dm-spin 0.7s linear infinite',
  }} />
);

function fmt(wei: bigint | undefined): string {
  if (wei === undefined) return '...';
  return parseFloat(formatEther(wei)).toFixed(6);
}

function secondsToHms(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type Props = {
  walletAddress: `0x${string}`;
  selectedChain: 'sepolia' | 'mainnet';
  className?: string;
  sessionStatus?: {
    active: boolean;
    maxFeePerTxEth: string;
    spentEth: string;
    remainingEth: string;
    expiresInMinutes: number;
    depositEth?: string;
    hasDeposit?: boolean;
  } | null;
}

export function DepositManager({ walletAddress, selectedChain, sessionStatus, className = '' }: Props) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [topUpAmount, setTopUpAmount] = useState('0.01');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [busy, setBusy] = useState<'topup' | 'withdraw' | 'revoke' | null>(null);
  const [txError, setTxError] = useState<UiError | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const resolvedChainId = selectedChain === 'mainnet' ? 1 : 11155111;
  const contract = selectedChain === 'mainnet' ? mainnetSessionContractAddress : sessionContractAddress;

  const { data: depositWei, refetch: refetchDeposit } = useReadContract({
    address: contract,
    abi: whenCheapSessionAbi,
    functionName: 'deposits',
    args: [walletAddress],
    chainId: resolvedChainId,
    query: { refetchInterval: 10_000, enabled: Boolean(contract && walletAddress) },
  });

  const { data: session, refetch: refetchSession } = useReadContract({
    address: contract,
    abi: whenCheapSessionAbi,
    functionName: 'sessions',
    args: [walletAddress],
    chainId: resolvedChainId,
    query: { refetchInterval: 10_000, enabled: Boolean(contract && walletAddress) },
  });

  const refetchAll = () => { void refetchDeposit(); void refetchSession(); };
  const canWithdraw = Boolean(withdrawAmount) && !Number.isNaN(parseFloat(withdrawAmount)) && parseFloat(withdrawAmount) > 0;
  const canDeposit = Boolean(topUpAmount) && !Number.isNaN(parseFloat(topUpAmount)) && parseFloat(topUpAmount) > 0;

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = session ? Number(session[3]) : 0;
  const onChainSessionActive = expiresAt > now;
  const secondsLeft = expiresAt - now;
  const onChainHasDeposit = depositWei !== undefined && depositWei > 0n;
  const remainingBudgetWei = session && session[1] > session[2] ? session[1] - session[2] : 0n;
  const sessionActive = sessionStatus?.active ?? onChainSessionActive;
  const hasDeposit = sessionStatus?.hasDeposit ?? onChainHasDeposit;
  const displayDeposit = sessionStatus?.depositEth !== undefined
    ? Number(sessionStatus.depositEth).toFixed(6)
    : fmt(depositWei);
  const displaySpent = sessionStatus?.spentEth !== undefined
    ? `${Number(sessionStatus.spentEth).toFixed(6)} ETH`
    : `${fmt(session?.[2])} ETH`;
  const displayRemaining = sessionStatus?.remainingEth !== undefined
    ? `${Number(sessionStatus.remainingEth).toFixed(6)} ETH`
    : `${fmt(remainingBudgetWei)} ETH`;
  const displayMaxFee = sessionStatus?.maxFeePerTxEth !== undefined
    ? `${Number(sessionStatus.maxFeePerTxEth).toFixed(6)} ETH`
    : `${fmt(session?.[0])} ETH`;
  const displaySession = sessionStatus
    ? sessionStatus.active
      ? `${Math.max(0, sessionStatus.expiresInMinutes)}m left`
      : 'Not set / Expired'
    : sessionActive
      ? `${secondsToHms(secondsLeft)} left`
      : 'Not set / Expired';
  const hasOnChainSessionRecord = Boolean(
    session && (session[0] > 0n || session[1] > 0n || session[2] > 0n || session[3] > 0n),
  );
  const hasSessionStatusRecord = Boolean(
    sessionStatus && (
      Number(sessionStatus.maxFeePerTxEth) > 0
      || Number(sessionStatus.remainingEth) > 0
      || Number(sessionStatus.spentEth) > 0
      || sessionStatus.active
    ),
  );
  const canRevokeSession = hasDeposit || hasOnChainSessionRecord || hasSessionStatusRecord;
  const healthLabel = sessionActive && hasDeposit
    ? 'Session Ready'
    : sessionActive
      ? 'No Deposit'
      : 'Session Expired';
  const healthColor = sessionActive && hasDeposit
    ? 'var(--color-accent)'
    : 'var(--color-danger)';

  const waitFor = async (hash: `0x${string}`) => {
    if (!publicClient) throw new Error('No public client');
    const receipt = await publicClient.waitForTransactionReceipt({
      hash, pollingInterval: 2_000, timeout: 120_000,
    });
    if (receipt.status !== 'success') throw new Error(`Transaction reverted (${hash})`);
  };

  const handleTopUp = async () => {
    if (!contract || !address) return;
    const parsed = parseFloat(topUpAmount);
    if (!topUpAmount || isNaN(parsed) || parsed <= 0) {
      setTxError({ title: 'Invalid Amount', message: 'Enter a valid amount before continuing.' });
      return;
    }
    setBusy('topup'); setTxError(null); setTxSuccess(null);
    try {
      const hash = await writeContractAsync({
        address: contract,
        abi: whenCheapSessionAbi,
        functionName: 'deposit',
        value: parseEther(topUpAmount),
        gas: 60_000n,
      });
      await waitFor(hash);
      refetchAll();
      setTxSuccess(`Deposited ${topUpAmount} ETH.`);
      setTopUpAmount('0.01');
    } catch (err) {
      setTxError(toWalletUiError(err, 'Deposit Failed'));
    } finally {
      setBusy(null);
    }
  };

  const handleMaxDeposit = async () => {
    if (!publicClient || !address) return;

    try {
      const balance = await publicClient.getBalance({ address });
      const gasReserveWei = parseEther('0.001');
      const maxDepositWei = balance > gasReserveWei ? balance - gasReserveWei : 0n;
      setTopUpAmount(maxDepositWei > 0n ? formatEther(maxDepositWei) : '0');
      setTxError(null);
    } catch (err) {
      setTxError(toWalletUiError(err, 'Balance Unavailable'));
    }
  };

  const handleWithdraw = async () => {
    if (!contract || !address || !withdrawAmount) return;
    const parsed = parseFloat(withdrawAmount);
    if (isNaN(parsed) || parsed <= 0) {
      setTxError({ title: 'Invalid Amount', message: 'Enter a valid amount before continuing.' });
      return;
    }
    const amountWei = parseEther(withdrawAmount);
    if (depositWei !== undefined && amountWei > depositWei) {
      setTxError({
        title: 'Amount Too High',
        message: `You cannot withdraw more than your current deposit (${fmt(depositWei)} ETH).`,
      });
      return;
    }
    setBusy('withdraw'); setTxError(null); setTxSuccess(null);
    try {
      const hash = await writeContractAsync({
        address: contract,
        abi: whenCheapSessionAbi,
        functionName: 'withdraw',
        args: [amountWei],
        gas: 60_000n,
      });
      await waitFor(hash);
      refetchAll();
      setTxSuccess(`Withdrew ${withdrawAmount} ETH.`);
      setWithdrawAmount('');
    } catch (err) {
      setTxError(toWalletUiError(err, 'Withdraw Failed'));
    } finally {
      setBusy(null);
    }
  };

  const handleMaxWithdraw = () => {
    if (!depositWei || depositWei <= 0n) return;
    setWithdrawAmount(formatEther(depositWei));
    setTxError(null);
  };

  const handleRevoke = async () => {
    if (!contract || !address) return;
    setBusy('revoke'); setTxError(null); setTxSuccess(null); setConfirmRevoke(false);
    try {
      const hash = await writeContractAsync({
        address: contract,
        abi: whenCheapSessionAbi,
        functionName: 'revokeSession',
        gas: 80_000n,
      });
      await waitFor(hash);
      refetchAll();
      setTxSuccess('Session revoked and deposit refunded.');
    } catch (err) {
      setTxError(toWalletUiError(err, 'Revoke Failed'));
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  useEffect(() => {
    if (confirmRevoke && !canRevokeSession) {
      setConfirmRevoke(false);
    }
  }, [canRevokeSession, confirmRevoke]);

  return (
    <div className={`console-panel ${className}`} style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
      <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-label)' }}>
        Deposit &amp; Session
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: healthColor,
            boxShadow: `0 0 12px ${healthColor}`,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: healthColor }}>
          {healthLabel}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
        <Row
          label="Deposit"
          value={`${displayDeposit} ETH`}
          tone={hasDeposit ? 'success' : 'danger'}
        />
        <Row
          label="Session"
          value={displaySession}
          tone={sessionActive ? 'success' : 'danger'}
        />
        {(session || sessionStatus) && (
          <>
            <Row label="Spent" value={displaySpent} />
            <Row label="Budget Left" value={displayRemaining} />
            <Row label="Max Fee / Tx" value={displayMaxFee} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-label)' }}>
          Contract
        </p>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text)', wordBreak: 'break-all' }}>
          {contract ?? 'Not configured'}
        </p>
      </div>

      {(!hasDeposit || !sessionActive) && (
        <div className="console-alert console-alert-danger">
          <span className="console-alert-label">Action Needed</span>
          <p>
            {!sessionActive && !hasDeposit
              ? 'Re-authorize this wallet on the current contract, then deposit ETH.'
              : !sessionActive
                ? 'Re-authorize this wallet on the current contract before execution.'
                : 'Deposit ETH into the current session contract before execution.'}
          </p>
        </div>
      )}

      {/* Top-up */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
          Top Up Deposit
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number" value={topUpAmount}
            onChange={e => setTopUpAmount(e.target.value)}
            min="0.001" step="0.001" placeholder="0.01"
            disabled={isBusy}
            className="console-input flex-1"
            style={{ fontSize: 12 }}
          />
          <button
            type="button"
            onClick={() => void handleMaxDeposit()}
            disabled={isBusy || !address}
            className="console-button"
            style={{ flexShrink: 0 }}
          >
            MAX
          </button>
          <span style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', alignSelf: 'flex-end', paddingBottom: 12 }}>ETH</span>
          <button
            type="button" onClick={handleTopUp}
            disabled={isBusy || !canDeposit}
            className="console-button console-button-primary"
            style={{ flexShrink: 0 }}
          >
            {busy === 'topup' ? <Spinner /> : 'Deposit'}
          </button>
        </div>
      </div>

      {/* Withdraw */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
          Withdraw
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number" value={withdrawAmount}
            onChange={e => setWithdrawAmount(e.target.value)}
            min="0" step="0.001"
            placeholder={fmt(depositWei)}
            disabled={isBusy}
            className="console-input flex-1"
            style={{ fontSize: 12 }}
          />
          <button
            type="button"
            onClick={handleMaxWithdraw}
            disabled={isBusy || !depositWei || depositWei <= 0n}
            className="console-button"
            style={{ flexShrink: 0 }}
          >
            MAX
          </button>
          <span style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', alignSelf: 'flex-end', paddingBottom: 12 }}>ETH</span>
          <button
            type="button" onClick={handleWithdraw}
            disabled={isBusy || !canWithdraw}
            className="console-button"
            style={{ flexShrink: 0 }}
          >
            {busy === 'withdraw' ? <Spinner /> : 'Withdraw'}
          </button>
        </div>
      </div>

      {/* Revoke */}
      {canRevokeSession && !confirmRevoke ? (
        <button
          type="button"
          onClick={() => setConfirmRevoke(true)}
          disabled={isBusy}
          className="console-text-button"
          style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--color-danger)', textTransform: 'uppercase' }}
        >
          Revoke Session &amp; Refund All
        </button>
      ) : canRevokeSession ? (
        <div className="console-alert console-alert-danger" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="console-alert-label">Confirm Revoke</span>
          <p>This will stop all pending intents and refund your full deposit. Continue?</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button" onClick={handleRevoke} disabled={isBusy}
              className="console-button"
              style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
            >
              {busy === 'revoke' ? <Spinner /> : 'Yes, Revoke'}
            </button>
            <button
              type="button" onClick={() => setConfirmRevoke(false)} disabled={isBusy}
              className="console-text-button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!canRevokeSession ? (
        <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
          No active session or refundable deposit on this contract.
        </p>
      ) : null}

      {/* Feedback */}
      {txSuccess && (
        <div className="console-alert console-alert-success">
          <span className="console-alert-label">Done</span>
          <p>{txSuccess}</p>
        </div>
      )}
      {txError && (
        <div className="console-alert console-alert-danger">
          <span className="console-alert-label">{txError.title}</span>
          <p>{txError.message}</p>
          {txError.details ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
                Technical details
              </summary>
              <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: 'var(--color-muted)' }}>
                {txError.details}
              </p>
            </details>
          ) : null}
        </div>
      )}

      <style>{`@keyframes dm-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const color =
    tone === 'success'
      ? 'var(--color-accent)'
      : tone === 'danger'
        ? 'var(--color-danger)'
        : 'var(--color-text)';

  return (
    <>
      <span style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-label)' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color, letterSpacing: '0.04em' }}>
        {value}
      </span>
    </>
  );
}
