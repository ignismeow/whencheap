'use client';

import { useRouter } from 'next/navigation';
import { RefObject, useEffect, useRef, useState } from 'react';

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

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
const authStorageKey = 'whencheap-google-identity';

export default function LoginPage() {
  const router = useRouter();
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(authStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ManagedIdentity;
      if (parsed?.email && parsed?.address) {
        router.replace('/');
      }
    } catch {
      window.localStorage.removeItem(authStorageKey);
    }
  }, [router]);

  useEffect(() => {
    if (!googleClientId) {
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
        },
      });

      googleButtonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'filled_black',
        size: 'large',
        width: 340,
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left',
      });
    };

    if (window.google) {
      initialize();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-whencheap-google-auth="true"]',
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
  }, []);

  async function authenticateWithGoogle(credential: string) {
    try {
      setIsAuthenticating(true);
      setAuthError(null);

      const response = await fetch(`${apiUrl}/intents/google-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });

      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (!response.ok || payload.ok !== true) {
        throw new Error(
          typeof payload.message === 'string'
            ? payload.message
            : rawBody || 'Google authentication failed',
        );
      }

      const identity: ManagedIdentity = {
        email: String(payload.email),
        address: String(payload.address) as `0x${string}`,
        created: Boolean(payload.created),
      };
      window.localStorage.setItem(authStorageKey, JSON.stringify(identity));
      router.replace('/');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google authentication failed');
    } finally {
      setIsAuthenticating(false);
    }
  }

  return (
    <main className="console-shell">
      <LoginGate
        authError={authError}
        googleButtonRef={googleButtonRef}
        isAuthenticating={isAuthenticating}
        onBack={() => router.push('/')}
      />
    </main>
  );
}

function LoginGate({
  authError,
  googleButtonRef,
  isAuthenticating,
  onBack,
}: {
  authError: string | null;
  googleButtonRef: RefObject<HTMLDivElement | null>;
  isAuthenticating: boolean;
  onBack: () => void;
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
              <li>No seed phrases required in the browser.</li>
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
                    Verifying identity and allocating wallet...
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-danger)]">
                NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured.
              </p>
            )}

            {authError ? (
              <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-danger)]">
                {authError}
              </p>
            ) : null}

            <button type="button" onClick={onBack} className="console-text-button">
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
