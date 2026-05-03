'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { WalletConnect } from '../../components/WalletConnect';

type WalletIdentity = {
  email: string;
  address: `0x${string}`;
  mode: 'external';
  created?: boolean;
};

const authStorageKey = 'whencheap-wallet-identity';
const legacyAuthStorageKey = 'whencheap-google-identity';
const walletAddressStorageKey = 'walletAddress';
const walletModeStorageKey = 'walletMode';

function persistIdentity(identity: WalletIdentity) {
  window.localStorage.setItem(authStorageKey, JSON.stringify(identity));
  window.localStorage.removeItem(legacyAuthStorageKey);
  window.localStorage.setItem(walletAddressStorageKey, identity.address);
  window.localStorage.setItem(walletModeStorageKey, identity.mode);
}

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    try {
      const raw =
        window.localStorage.getItem(authStorageKey) ??
        window.localStorage.getItem(legacyAuthStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<WalletIdentity>;
      if (parsed?.address) {
        persistIdentity({
          email: parsed.email ?? parsed.address,
          address: parsed.address as `0x${string}`,
          mode: 'external',
          created: parsed.created,
        });
        router.replace('/app');
      }
    } catch {
      window.localStorage.removeItem(authStorageKey);
      window.localStorage.removeItem(legacyAuthStorageKey);
      window.localStorage.removeItem(walletAddressStorageKey);
      window.localStorage.removeItem(walletModeStorageKey);
    }
  }, [router]);

  const handleWalletAuthorized = (address: string) => {
    persistIdentity({
      email: address,
      address: address as `0x${string}`,
      mode: 'external',
      created: true,
    });
    router.replace('/app');
  };

  return (
    <main className="console-shell">
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-[760px] border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          <div className="space-y-3 border-b border-[var(--color-border)] pb-6">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              Wallet Access Required
            </p>
            <h1 className="text-xl font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
              Connect MetaMask
            </h1>
            <p className="max-w-2xl text-sm uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Connect your wallet, deposit ETH, authorize a session, and let WhenCheap execute when gas is right.
            </p>
          </div>

          <div className="mt-6 border border-[var(--color-border)] p-4">
            <p className="mb-3 text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
              MetaMask Wallet
            </p>
            <ul className="mb-4 space-y-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text)]">
              <li>✓ You control the wallet</li>
              <li>✓ No private keys stored on the server</li>
              <li>✓ Session-backed autonomous execution</li>
            </ul>
            <WalletConnect onAuthorized={handleWalletAuthorized} mode="status-only" />
          </div>

          <button type="button" onClick={() => router.push('/')} className="console-text-button mt-6">
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
