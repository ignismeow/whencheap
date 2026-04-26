'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { http } from 'viem';
import { sepolia } from 'viem/chains';
import { createConfig, WagmiProvider } from 'wagmi';
import { injected } from 'wagmi/connectors';

type InjectedProvider = {
  isRabby?: boolean;
  rabby?: { ethereum?: unknown };
  ethereum?: InjectedProvider & { providers?: InjectedProvider[] };
  providers?: InjectedProvider[];
};

const rabbyConnector = injected({
  target: {
    id: 'rabby',
    name: 'Rabby',
    provider(window?: Window) {
      const w = window as unknown as InjectedProvider;
      if (w.rabby?.ethereum) return w.rabby.ethereum;

      const ethereum = w.ethereum;
      if (ethereum?.providers) {
        return ethereum.providers.find((provider) => provider.isRabby);
      }
      if (ethereum?.isRabby) return ethereum;
      return undefined;
    }
  } as never
});

const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [rabbyConnector, injected({ target: 'metaMask' }), injected()],
  transports: {
    [sepolia.id]: http()
  },
  multiInjectedProviderDiscovery: true,
  ssr: false
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
