import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ethers } from 'ethers';

const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;
const ETH_PRICE_TTL_MS = 30_000;

@Injectable()
export class GasOracleService {
  private readonly logger = new Logger(GasOracleService.name);
  private readonly provider: ethers.JsonRpcProvider;
  private cachedEthUsd = 0;
  private cacheExpiry = 0;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>('RPC_URL') ?? 'https://eth-sepolia.g.alchemy.com/v2/demo';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async estimateTxCostUsd(type: 'send' | 'swap'): Promise<{ costUsd: number; baseFeeGwei: number; ethUsd: number }> {
    const [baseFeeGwei, ethUsd] = await Promise.all([this.fetchBaseFeeGwei(), this.fetchEthUsd()]);
    const gasUnits = GAS_UNITS[type] ?? GAS_UNITS.swap;
    const costUsd = (baseFeeGwei * gasUnits * ethUsd) / 1e9;
    return { costUsd, baseFeeGwei, ethUsd };
  }

  private async fetchBaseFeeGwei(): Promise<number> {
    const history = await this.provider.send('eth_feeHistory', ['0x4', 'latest', [25]]) as {
      baseFeePerGas: string[];
    };
    const nextBaseFeeWei = parseInt(history.baseFeePerGas.at(-1) ?? '0x0', 16);
    return nextBaseFeeWei / 1e9;
  }

  private async fetchEthUsd(): Promise<number> {
    if (Date.now() < this.cacheExpiry && this.cachedEthUsd > 0) {
      return this.cachedEthUsd;
    }
    try {
      const { data } = await axios.get<{ ethereum: { usd: number } }>(
        'https://api.coingecko.com/api/v3/simple/price',
        { params: { ids: 'ethereum', vs_currencies: 'usd' }, timeout: 5_000 }
      );
      this.cachedEthUsd = data.ethereum.usd;
      this.cacheExpiry = Date.now() + ETH_PRICE_TTL_MS;
      return this.cachedEthUsd;
    } catch {
      this.logger.warn('ETH/USD price fetch failed; using cached or fallback value');
      return this.cachedEthUsd > 0 ? this.cachedEthUsd : 3_000;
    }
  }
}
