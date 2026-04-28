'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { http } from 'viem';
import { sepolia } from 'viem/chains';
import { createConfig, WagmiProvider } from 'wagmi';
import { injected } from 'wagmi/connectors';

const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injected({
      shimDisconnect: true,
    }),
  ],
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
