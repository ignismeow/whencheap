export type UiError = {
  title: string;
  message: string;
  details?: string;
};

function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toWalletUiError(error: unknown, fallbackTitle = 'Transaction Failed'): UiError {
  const details = extractErrorText(error).trim();
  const lower = details.toLowerCase();

  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('denied transaction signature') ||
    lower.includes('rejected the request')
  ) {
    return {
      title: 'Request Canceled',
      message: 'You canceled the request in MetaMask. No funds moved and nothing changed on-chain.',
      details,
    };
  }

  if (
    lower.includes('insufficient funds') ||
    lower.includes('exceeds balance') ||
    lower.includes('not enough funds')
  ) {
    return {
      title: 'Insufficient Balance',
      message: 'Your wallet does not have enough ETH to complete this transaction and pay gas.',
      details,
    };
  }

  if (
    lower.includes('wrong network') ||
    lower.includes('chain mismatch') ||
    lower.includes('switch metamask') ||
    lower.includes('unsupported chain')
  ) {
    return {
      title: 'Wrong Network',
      message: 'Switch MetaMask to the selected network, then try again.',
      details,
    };
  }

  if (
    lower.includes('http request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('rpc.sepolia.org') ||
    lower.includes('eth_call')
  ) {
    return {
      title: 'RPC Unavailable',
      message: 'The frontend could not reach the selected network RPC. Add a working Sepolia RPC to the frontend environment and try again.',
      details,
    };
  }

  if (
    lower.includes('internal server error') ||
    lower.includes('request failed: 500') ||
    lower.includes('unexpected token')
  ) {
    return {
      title: 'Backend Unavailable',
      message: 'The app could not finish the request because the backend returned an unexpected response.',
      details,
    };
  }

  if (lower.includes('reverted')) {
    return {
      title: 'Transaction Reverted',
      message: 'The contract rejected this transaction. Double-check your balance, session state, and selected network.',
      details,
    };
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      title: 'Confirmation Delayed',
      message: 'The transaction took too long to confirm. Check MetaMask or a block explorer, then refresh the panel.',
      details,
    };
  }

  if (lower.includes('no public client') || lower.includes('wallet not connected')) {
    return {
      title: 'Wallet Not Ready',
      message: 'Reconnect your wallet and try again.',
      details,
    };
  }

  return {
    title: fallbackTitle,
    message: 'Something went wrong while talking to your wallet. Please try again.',
    details,
  };
}
