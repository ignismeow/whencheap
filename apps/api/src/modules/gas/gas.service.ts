import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { GasSnapshotEntity } from './gas-snapshot.entity';

export interface GasSnapshot {
  baseFeeGwei: number;
  priorityFeeGwei: number;
  safeLowGwei: number;
  standardGwei: number;
  fastGwei: number;
  ethPriceUsd: number;
  timestamp: number;
  chain: string;
}

export interface GasCosts {
  sendUsd: number;
  swapUsd: number;
  sendGwei: number;
  swapGwei: number;
}

export interface GasSuggestion {
  currentCosts: GasCosts;
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
}

const GAS_UNITS = {
  send: 21_000,
  swap: 150_000,
  erc20Transfer: 65_000,
} as const;

type AnalyticsResult = {
  avg1h: number;
  min1h: number;
  max1h: number;
  avg24h: number;
  min24h: number;
  max24h: number;
  avg7d: number;
  currentVsAvg1h: number;
  currentVsAvg24h: number;
  hourlyPattern: Array<{ hour: number; avgGwei: number }>;
  snapshots: Array<{
    id: number;
    chain: string;
    baseFeeGwei: number;
    priorityFeeGwei: number;
    safeLowGwei: number;
    standardGwei: number;
    fastGwei: number;
    ethPriceUsd: number;
    capturedAt: string;
  }>;
};

@Injectable()
export class GasService {
  private readonly logger = new Logger(GasService.name);
  private readonly historyMap = new Map<string, GasSnapshot[]>();
  private readonly maxHistory = 240;
  private ethPriceCache: { price: number; timestamp: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(GasSnapshotEntity)
    private readonly snapshotRepo: Repository<GasSnapshotEntity>,
  ) {}

  async getCurrentGas(chain = 'sepolia'): Promise<GasSnapshot> {
    const normalizedChain = this.normalizeChain(chain);
    const [alchemyData, etherscanData, ethPrice] = await Promise.all([
      this.getAlchemyGas(normalizedChain),
      this.getEtherscanGas(normalizedChain),
      this.getEthPrice(),
    ]);

    const snapshot: GasSnapshot = {
      baseFeeGwei: alchemyData.baseFeeGwei,
      priorityFeeGwei: alchemyData.priorityFeeGwei,
      safeLowGwei: etherscanData.safeLow,
      standardGwei: etherscanData.standard,
      fastGwei: etherscanData.fast,
      ethPriceUsd: ethPrice,
      timestamp: Date.now(),
      chain: normalizedChain,
    };

    const history = this.historyMap.get(normalizedChain) ?? [];
    history.push(snapshot);
    if (history.length > this.maxHistory) {
      history.shift();
    }
    this.historyMap.set(normalizedChain, history);

    return snapshot;
  }

  async getGasCosts(chain = 'sepolia'): Promise<GasCosts> {
    const gas = await this.getCurrentGas(chain);
    const gweiToUsd = (gwei: number, units: number) =>
      gwei * units * 1e-9 * gas.ethPriceUsd;

    return {
      sendGwei: gas.baseFeeGwei,
      swapGwei: gas.baseFeeGwei,
      sendUsd: gweiToUsd(gas.baseFeeGwei, GAS_UNITS.send),
      swapUsd: gweiToUsd(gas.baseFeeGwei, GAS_UNITS.swap),
    };
  }

  async getGasSuggestion(
    type: 'send' | 'swap',
    deadlineMinutes: number | null,
    chain = 'sepolia',
  ): Promise<GasSuggestion> {
    const current = await this.getCurrentGas(chain);
    const history = this.historyMap.get(current.chain) ?? [];
    const gweiToUsd = (gwei: number, units: number) =>
      gwei * units * 1e-9 * current.ethPriceUsd;

    const gasUnits = GAS_UNITS[type];
    const currentCostUsd = gweiToUsd(current.baseFeeGwei, gasUnits);
    const currentCosts: GasCosts = {
      sendUsd: gweiToUsd(current.baseFeeGwei, GAS_UNITS.send),
      swapUsd: gweiToUsd(current.baseFeeGwei, GAS_UNITS.swap),
      sendGwei: current.baseFeeGwei,
      swapGwei: current.baseFeeGwei,
    };

    const { trend, trendPct } = this.calculateTrend(history);
    const { dipGwei, minutesFromNow, confidence } = await this.predictNextDip(
      current.chain,
      history,
      trend,
    );
    const dipCostUsd = gweiToUsd(dipGwei, gasUnits);
    const estimatedSavingsUsd = Math.max(0, currentCostUsd - dipCostUsd);
    const estimatedSavingsPct =
      currentCostUsd > 0 ? (estimatedSavingsUsd / currentCostUsd) * 100 : 0;

    const urgency: 'high' | 'medium' | 'low' = !deadlineMinutes
      ? 'low'
      : deadlineMinutes <= 15
        ? 'high'
        : deadlineMinutes <= 60
          ? 'medium'
          : 'low';

    let recommendedMaxFeeGwei: number;
    if (urgency === 'high') {
      recommendedMaxFeeGwei = current.fastGwei * 1.1;
    } else if (urgency === 'medium') {
      recommendedMaxFeeGwei = current.standardGwei * 1.2;
    } else {
      recommendedMaxFeeGwei = Math.max(dipGwei * 1.15, current.safeLowGwei);
    }

    const recommendedMaxFeeUsd = gweiToUsd(recommendedMaxFeeGwei, gasUnits);

    let recommendation: string;
    if (urgency === 'high') {
      recommendation = 'Deadline is tight; execute at a fast gas price now.';
    } else if (estimatedSavingsPct > 30 && minutesFromNow < 60) {
      recommendation = `Gas is trending ${trend}. Wait about ${minutesFromNow} min to save roughly ${estimatedSavingsPct.toFixed(0)}% ($${estimatedSavingsUsd.toFixed(4)}).`;
    } else if (estimatedSavingsPct > 15) {
      recommendation = `A moderate saving may appear in about ${minutesFromNow} min. Current gas is still reasonable.`;
    } else {
      recommendation =
        trend === 'stable'
          ? 'Gas is stable and at a healthy level. Safe to execute now.'
          : `Gas is ${trend}. Current levels are still acceptable for execution.`;
    }

    return {
      currentCosts,
      recommendedMaxFeeGwei,
      recommendedMaxFeeUsd,
      bestWindowMinutes: minutesFromNow,
      estimatedSavingsUsd,
      estimatedSavingsPct,
      urgency,
      trend,
      trendPct,
      recommendation,
      confidence,
    };
  }

  async getHistory(chain = 'sepolia'): Promise<AnalyticsResult['snapshots']> {
    const normalizedChain = this.normalizeChain(chain);
    const rows = await this.snapshotRepo.query(
      `
        SELECT *
        FROM gas_snapshots
        WHERE chain = $1
        ORDER BY "capturedAt" DESC
        LIMIT 240
      `,
      [normalizedChain],
    );

    return rows
      .reverse()
      .map((row: Record<string, string | number | Date>) =>
        this.mapSnapshotRow(row),
      );
  }

  async getAnalytics(chain = 'sepolia'): Promise<AnalyticsResult> {
    const normalizedChain = this.normalizeChain(chain);
    const [stats1h, stats24h, stats7d, hourlyPatternRows, snapshotRows] =
      await Promise.all([
        this.snapshotRepo.query(
          `
            SELECT
              AVG("baseFeeGwei"::float) AS avg,
              MIN("baseFeeGwei"::float) AS min,
              MAX("baseFeeGwei"::float) AS max
            FROM gas_snapshots
            WHERE chain = $1
              AND "capturedAt" > NOW() - INTERVAL '1 hour'
          `,
          [normalizedChain],
        ),
        this.snapshotRepo.query(
          `
            SELECT
              AVG("baseFeeGwei"::float) AS avg,
              MIN("baseFeeGwei"::float) AS min,
              MAX("baseFeeGwei"::float) AS max
            FROM gas_snapshots
            WHERE chain = $1
              AND "capturedAt" > NOW() - INTERVAL '24 hours'
          `,
          [normalizedChain],
        ),
        this.snapshotRepo.query(
          `
            SELECT
              AVG("baseFeeGwei"::float) AS avg
            FROM gas_snapshots
            WHERE chain = $1
              AND "capturedAt" > NOW() - INTERVAL '7 days'
          `,
          [normalizedChain],
        ),
        this.snapshotRepo.query(
          `
            SELECT
              EXTRACT(hour FROM "capturedAt") AS hour,
              AVG("baseFeeGwei"::float) AS "avgGwei"
            FROM gas_snapshots
            WHERE chain = $1
              AND "capturedAt" > NOW() - INTERVAL '7 days'
            GROUP BY EXTRACT(hour FROM "capturedAt")
            ORDER BY hour ASC
          `,
          [normalizedChain],
        ),
        this.snapshotRepo.query(
          `
            SELECT *
            FROM gas_snapshots
            WHERE chain = $1
              AND "capturedAt" > NOW() - INTERVAL '1 hour'
            ORDER BY "capturedAt" ASC
          `,
          [normalizedChain],
        ),
      ]);

    const currentHistory = this.historyMap.get(normalizedChain) ?? [];
    const currentGwei = currentHistory.length
      ? currentHistory[currentHistory.length - 1].baseFeeGwei
      : parseFloat(stats1h[0]?.avg ?? stats24h[0]?.avg ?? '0');

    const avg1h = parseFloat(stats1h[0]?.avg ?? '0');
    const avg24h = parseFloat(stats24h[0]?.avg ?? '0');

    return {
      avg1h,
      min1h: parseFloat(stats1h[0]?.min ?? '0'),
      max1h: parseFloat(stats1h[0]?.max ?? '0'),
      avg24h,
      min24h: parseFloat(stats24h[0]?.min ?? '0'),
      max24h: parseFloat(stats24h[0]?.max ?? '0'),
      avg7d: parseFloat(stats7d[0]?.avg ?? '0'),
      currentVsAvg1h: avg1h > 0 ? ((currentGwei - avg1h) / avg1h) * 100 : 0,
      currentVsAvg24h: avg24h > 0 ? ((currentGwei - avg24h) / avg24h) * 100 : 0,
      hourlyPattern: hourlyPatternRows.map(
        (row: { hour: string; avgGwei: string }) => ({
          hour: parseInt(String(row.hour), 10),
          avgGwei: parseFloat(row.avgGwei),
        }),
      ),
      snapshots: snapshotRows.map((row: Record<string, string | number | Date>) =>
        this.mapSnapshotRow(row),
      ),
    };
  }

  private calculateTrend(history: GasSnapshot[]): {
    trend: 'rising' | 'falling' | 'stable';
    trendPct: number;
  } {
    if (history.length < 5) {
      return { trend: 'stable', trendPct: 0 };
    }

    const recent = history.slice(-10);
    const old = recent[0]?.baseFeeGwei ?? 0;
    const current = recent[recent.length - 1]?.baseFeeGwei ?? old;
    const trendPct = old > 0 ? ((current - old) / old) * 100 : 0;
    const trend = trendPct > 8 ? 'rising' : trendPct < -8 ? 'falling' : 'stable';
    return { trend, trendPct };
  }

  private async predictNextDip(
    chain: string,
    history: GasSnapshot[],
    trend: 'rising' | 'falling' | 'stable',
  ): Promise<{
    dipGwei: number;
    minutesFromNow: number;
    confidence: 'high' | 'medium' | 'low';
  }> {
    const cheapestHours = await this.getCheapestHours(chain);
    const currentUtcHour = new Date().getUTCHours();
    const nextCheapHourDelta = cheapestHours.length
      ? Math.min(
          ...cheapestHours.map((hour) =>
            hour >= currentUtcHour
              ? (hour - currentUtcHour) * 60
              : (24 - currentUtcHour + hour) * 60,
          ),
        )
      : 0;

    if (history.length < 10) {
      const latest = history[history.length - 1]?.baseFeeGwei ?? 0.001;
      return {
        dipGwei: latest,
        minutesFromNow: nextCheapHourDelta,
        confidence: 'low',
      };
    }

    const recent = history.slice(-20);
    const fees = recent.map((snapshot) => snapshot.baseFeeGwei);
    const minFee = Math.min(...fees);
    const current = fees[fees.length - 1] ?? minFee;

    if (current <= minFee * 1.1) {
      return { dipGwei: current, minutesFromNow: 0, confidence: 'high' };
    }
    if (trend === 'falling') {
      return {
        dipGwei: minFee * 0.95,
        minutesFromNow: Math.min(nextCheapHourDelta || 5, 30),
        confidence: 'high',
      };
    }
    if (trend === 'stable') {
      return {
        dipGwei: minFee,
        minutesFromNow: nextCheapHourDelta || 10,
        confidence: 'medium',
      };
    }

    return {
      dipGwei: minFee,
      minutesFromNow: nextCheapHourDelta || 20,
      confidence: 'low',
    };
  }

  private async getCheapestHours(chain: string): Promise<number[]> {
    try {
      const result = await this.snapshotRepo.query(
        `
          SELECT
            EXTRACT(hour FROM "capturedAt") AS hour,
            AVG("baseFeeGwei"::float) AS "avgGwei"
          FROM gas_snapshots
          WHERE chain = $1
            AND "capturedAt" > NOW() - INTERVAL '7 days'
          GROUP BY EXTRACT(hour FROM "capturedAt")
          ORDER BY "avgGwei" ASC
          LIMIT 6
        `,
        [chain],
      );

      return result.map((row: { hour: string }) => parseInt(row.hour, 10));
    } catch {
      return [2, 3, 4, 5, 6, 14];
    }
  }

  private async getAlchemyGas(chain: string): Promise<{
    baseFeeGwei: number;
    priorityFeeGwei: number;
  }> {
    const rpcUrl =
      chain === 'mainnet'
        ? this.config.get<string>('MAINNET_RPC_URL')
        : this.config.get<string>('RPC_URL');

    if (!rpcUrl) {
      throw new Error(`Missing RPC URL for ${chain}`);
    }

    const [feeHistoryRes, maxPriorityRes] = await Promise.all([
      axios.post(rpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_feeHistory',
        params: ['0xa', 'latest', [25, 50]],
        id: 1,
      }),
      axios.post(rpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_maxPriorityFeePerGas',
        params: [],
        id: 2,
      }),
    ]);

    const baseFees = feeHistoryRes.data.result.baseFeePerGas as string[];
    const latestBaseFee = parseInt(baseFees[baseFees.length - 1] ?? '0x0', 16) / 1e9;
    const priorityFeeGwei = parseInt(maxPriorityRes.data.result, 16) / 1e9;

    return {
      baseFeeGwei: latestBaseFee,
      priorityFeeGwei,
    };
  }

  private async getEtherscanGas(chain: string): Promise<{
    safeLow: number;
    standard: number;
    fast: number;
  }> {
    try {
      const apiKey = this.config.get<string>('ETHERSCAN_API_KEY');
      if (chain !== 'mainnet' || !apiKey) {
        const alchemy = await this.getAlchemyGas(chain);
        return {
          safeLow: alchemy.baseFeeGwei,
          standard: alchemy.baseFeeGwei * 1.2,
          fast: alchemy.baseFeeGwei * 1.5,
        };
      }

      const response = await axios.get(
        `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${apiKey}`,
        { timeout: 5000 },
      );

      const result = response.data.result;
      return {
        safeLow: parseFloat(result.SafeGasPrice),
        standard: parseFloat(result.ProposeGasPrice),
        fast: parseFloat(result.FastGasPrice),
      };
    } catch (err) {
      this.logger.warn(`Etherscan gas oracle failed: ${String(err)}`);
      const alchemy = await this.getAlchemyGas(chain);
      return {
        safeLow: alchemy.baseFeeGwei,
        standard: alchemy.baseFeeGwei * 1.2,
        fast: alchemy.baseFeeGwei * 1.5,
      };
    }
  }

  private async getEthPrice(): Promise<number> {
    if (this.ethPriceCache && Date.now() - this.ethPriceCache.timestamp < 60_000) {
      return this.ethPriceCache.price;
    }

    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        { timeout: 5000 },
      );
      const price = response.data?.ethereum?.usd ?? 2500;
      this.ethPriceCache = { price, timestamp: Date.now() };
      return price;
    } catch {
      return this.ethPriceCache?.price ?? 2500;
    }
  }

  private normalizeChain(chain: string): string {
    return ['mainnet', 'ethereum', 'eth'].includes(chain.toLowerCase())
      ? 'mainnet'
      : 'sepolia';
  }

  private mapSnapshotRow(row: Record<string, string | number | Date>) {
    return {
      id: Number(row.id),
      chain: String(row.chain),
      baseFeeGwei: parseFloat(String(row.baseFeeGwei)),
      priorityFeeGwei: parseFloat(String(row.priorityFeeGwei)),
      safeLowGwei: parseFloat(String(row.safeLowGwei)),
      standardGwei: parseFloat(String(row.standardGwei)),
      fastGwei: parseFloat(String(row.fastGwei)),
      ethPriceUsd: parseFloat(String(row.ethPriceUsd)),
      capturedAt:
        row.capturedAt instanceof Date
          ? row.capturedAt.toISOString()
          : String(row.capturedAt),
    };
  }
}
