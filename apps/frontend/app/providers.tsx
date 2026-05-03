'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const sepoliaRpc = process.env.NEXT_PUBLIC_RPC_URL
  ?? (alchemyKey ? `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}` : 'https://rpc.sepolia.org');
const mainnetRpc = alchemyKey
  ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
  : undefined;

const wagmiConfig = getDefaultConfig({
  appName: 'WhenCheap',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_ID || '65d52a70398ba52d4f9f60b9bb6a1c97',
  chains: [mainnet, sepolia],
  transports: {
    [mainnet.id]: http(mainnetRpc),
    [sepolia.id]: http(sepoliaRpc),
  },
  ssr: false,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
