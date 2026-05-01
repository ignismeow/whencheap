'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface GasSnapshot {
  id?: number;
  baseFeeGwei: number;
  priorityFeeGwei: number;
  safeLowGwei: number;
  standardGwei: number;
  fastGwei: number;
  ethPriceUsd: number;
  timestamp?: number;
  capturedAt?: string;
  chain: string;
}

interface Analytics {
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
  snapshots: GasSnapshot[];
}

interface Suggestion {
  currentCosts: { sendUsd: number; swapUsd: number };
  recommendedMaxFeeGwei: number;
  recommendedMaxFeeUsd: number;
  bestWindowMinutes: number;
  estimatedSavingsPct: number;
  estimatedSavingsUsd: number;
  urgency: 'high' | 'medium' | 'low';
  trend: 'rising' | 'falling' | 'stable';
  trendPct: number;
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
}

const apiFetch = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
};

export default function GasPage() {
  const [current, setCurrent] = useState<GasSnapshot | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [chain, setChain] = useState<'sepolia' | 'mainnet'>('sepolia');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [cur, ana, sug] = await Promise.all([
        apiFetch<GasSnapshot>(`/api/gas/current?chain=${chain}`),
        apiFetch<Analytics>(`/api/gas/analytics?chain=${chain}`),
        apiFetch<Suggestion>(`/api/gas/suggestion?type=swap&chain=${chain}`),
      ]);
      setCurrent(cur);
      setAnalytics(ana);
      setSuggestion(sug);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gas analytics');
    }
  }, [chain]);

  useEffect(() => {
    void fetchData();
    const interval = window.setInterval(() => {
      void fetchData();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [fetchData]);

  const trendTone = useMemo(() => {
    if (!suggestion) return 'text-[var(--color-muted)]';
    if (suggestion.trend === 'rising') return 'text-[var(--color-danger)]';
    if (suggestion.trend === 'falling') return 'text-[#4dffa3]';
    return 'text-[var(--color-muted)]';
  }, [suggestion]);

  return (
    <main className="console-shell">
      <GasNav />

      <div className="gas-page-scroll mx-auto flex h-screen max-w-[1600px] flex-col gap-4 overflow-y-auto px-4 pb-8 pt-24 sm:px-6 lg:px-8">
        <header className="console-panel">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <div>
                <p className="text-[10px] text-[var(--color-label)]">
                  Network Telemetry
                </p>
                <h1 className="mt-2 text-lg font-medium uppercase tracking-[0.11em] text-[var(--color-text)]">
                  Gas Analytics
                </h1>
                <p className="mt-2 max-w-2xl text-sm  text-[var(--color-muted)]">
                  Real-time gas intelligence from Alchemy, Etherscan, and market pricing, rendered in the WhenCheap execution console style.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setChain((value) => (value === 'sepolia' ? 'mainnet' : 'sepolia'))}
                className="console-chip hover:bg-[var(--color-accent)] hover:text-black"
              >
                <span className="h-2 w-2 bg-[var(--color-accent)]" />
                <span>{chain === 'mainnet' ? 'Mainnet' : 'Sepolia'}</span>
              </button>
              <button
                type="button"
                onClick={() => void fetchData()}
                className="console-chip hover:bg-[var(--color-accent)] hover:text-black"
              >
                Refresh
              </button>
              {lastUpdated ? (
                <span className="console-chip">
                  <span className="h-2 w-2 bg-[#4dffa3]" />
                  <span>{lastUpdated.toLocaleTimeString()}</span>
                </span>
              ) : null}
            </div>
          </div>
        </header>

        {error ? (
          <div className="console-alert console-alert-danger">
            <span className="console-alert-label">Error</span>
            <p>{error}</p>
          </div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricPanel
            label="Base Fee"
            value={current ? `${current.baseFeeGwei.toFixed(4)} GWEI` : '...'}
            tone={current ? gasValueTone(current.baseFeeGwei) : 'text-[var(--color-muted)]'}
            meta={suggestion ? `${trendArrow(suggestion.trend)} ${suggestion.trend}` : 'Waiting for telemetry'}
          />
          <MetricPanel
            label="Send Cost"
            value={suggestion ? `$${suggestion.currentCosts.sendUsd.toFixed(6)}` : '...'}
            meta="21,000 gas units"
          />
          <MetricPanel
            label="Swap Cost"
            value={suggestion ? `$${suggestion.currentCosts.swapUsd.toFixed(6)}` : '...'}
            meta="150,000 gas units"
          />
          <MetricPanel
            label="ETH Price"
            value={current ? `$${current.ethPriceUsd.toLocaleString()}` : '...'}
            meta="CoinGecko"
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <div className="console-panel min-h-0">
            <div className="mb-4 border-b border-[var(--color-border)] pb-3">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                Trendline
              </p>
              <h2 className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
                Base Fee History
              </h2>
            </div>
            <div className="space-y-4">
              <Sparkline snapshots={analytics?.snapshots ?? []} />
              <div className="grid gap-[1px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
                <SummaryCell label="Min 1H" value={analytics ? analytics.min1h.toFixed(4) : '...'} />
                <SummaryCell label="Avg 1H" value={analytics ? analytics.avg1h.toFixed(4) : '...'} />
                <SummaryCell label="Max 1H" value={analytics ? analytics.max1h.toFixed(4) : '...'} />
              </div>
              <div className="grid gap-[1px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
                <SummaryCell label="Min 24H" value={analytics ? analytics.min24h.toFixed(4) : '...'} />
                <SummaryCell label="Avg 24H" value={analytics ? analytics.avg24h.toFixed(4) : '...'} />
                <SummaryCell label="Avg 7D" value={analytics ? analytics.avg7d.toFixed(4) : '...'} />
              </div>
              {analytics?.hourlyPattern.length ? (
                <div className="border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                    Cheapest Hours (UTC, 7D)
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[...(analytics?.hourlyPattern ?? [])]
                      .sort((a, b) => a.avgGwei - b.avgGwei)
                      .slice(0, 6)
                      .map((hour) => (
                        <span
                          key={hour.hour}
                          className="border border-[#4dffa3] bg-[#4dffa31a] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[#4dffa3]"
                        >
                          {String(hour.hour).padStart(2, '0')}:00
                        </span>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="console-panel min-h-0">
            <div className="mb-4 border-b border-[var(--color-border)] pb-3">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                Execution Tiers
              </p>
              <h2 className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
                Gas Price Bands
              </h2>
            </div>
            {current ? (
              <div className="space-y-3">
                <TierRow label="Safe Low" gwei={current.safeLowGwei} usd={tierSwapUsd(current.safeLowGwei, current.ethPriceUsd)} note="Longer confirmation window" />
                <TierRow label="Standard" gwei={current.standardGwei} usd={tierSwapUsd(current.standardGwei, current.ethPriceUsd)} note="Balanced execution profile" />
                <TierRow label="Fast" gwei={current.fastGwei} usd={tierSwapUsd(current.fastGwei, current.ethPriceUsd)} note="Next-block priority" />
              </div>
            ) : (
              <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">Collecting live gas data...</p>
            )}
          </div>
        </section>

        {suggestion ? (
          <section className="console-panel gas-section-panel gas-intelligence-panel">
            <div className="relative z-[1] flex flex-col gap-5">
            <div className="flex flex-col gap-3 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                  WhenCheap Intelligence
                </p>
                <h2 className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
                  Recommended Execution Window
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={`console-chip ${urgencyChipClass(suggestion.urgency)}`}>
                  {suggestion.urgency} urgency
                </span>
                <span className="console-chip">
                  Confidence {suggestion.confidence}
                </span>
              </div>
            </div>

            <div className="gas-card-grid">
              <MetricPanel
                label="Recommended Max Fee"
                value={`$${suggestion.recommendedMaxFeeUsd.toFixed(6)}`}
                tone="text-[var(--color-accent)]"
                meta={`${suggestion.recommendedMaxFeeGwei.toFixed(4)} GWEI`}
              />
              <MetricPanel
                label="Potential Saving"
                value={`${suggestion.estimatedSavingsPct.toFixed(1)}%`}
                tone="text-[#4dffa3]"
                meta={`~$${suggestion.estimatedSavingsUsd.toFixed(6)}`}
              />
              <MetricPanel
                label="Best Window"
                value={suggestion.bestWindowMinutes > 0 ? `${suggestion.bestWindowMinutes} MIN` : 'NOW'}
                tone={trendTone}
                meta={`${trendArrow(suggestion.trend)} ${suggestion.trend} (${suggestion.trendPct.toFixed(1)}%)`}
              />
            </div>

            <div className="border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                Recommendation
              </p>
              <p className="mt-2 break-words text-xs uppercase tracking-[0.12em] leading-relaxed text-[var(--color-text)]">
                {suggestion.recommendation}
              </p>
            </div>
            </div>
          </section>
        ) : null}

        {analytics ? (
          <section className="console-panel gas-section-panel gas-comparison-panel">
            {(() => {
              const oneHourDelta = analytics.currentVsAvg1h;
              const twentyFourHourDelta = analytics.currentVsAvg24h;
              return (
                <div className="relative z-[1] flex flex-col gap-5">
            <div className="border-b border-[var(--color-border)] pb-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">
                Comparison
              </p>
              <h2 className="mt-1 text-sm font-medium uppercase tracking-[0.18em] text-[var(--color-text)]">
                Current vs Baselines
              </h2>
            </div>
            <div className="gas-comparison-grid">
              <div className="gas-stat-card border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">Vs 1H Avg</p>
                <div className={`mt-2 text-2xl font-bold uppercase tracking-[0.08em] leading-tight ${comparisonTone(oneHourDelta)}`}>
                  {oneHourDelta > 0 ? '+' : ''}
                  {oneHourDelta.toFixed(1)}%
                </div>
              </div>
              <div className="gas-stat-card border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">Vs 24H Avg</p>
                <div className={`mt-2 text-2xl font-bold uppercase tracking-[0.08em] leading-tight ${comparisonTone(twentyFourHourDelta)}`}>
                  {twentyFourHourDelta > 0 ? '+' : ''}
                  {twentyFourHourDelta.toFixed(1)}%
                </div>
              </div>
              <div className="gas-status-card border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
              <p className="max-w-3xl break-words text-xs uppercase tracking-[0.12em] leading-relaxed text-[var(--color-muted)]">
                {oneHourDelta > 20
                  ? 'Gas is elevated against the trailing hour average. Queueing intents may unlock better execution prices.'
                  : oneHourDelta < -20
                    ? 'Gas is meaningfully below the trailing hour average. This is a strong execution window.'
                    : 'Gas is hovering near the trailing hour average. Current pricing is balanced.'}
              </p>
              </div>
            </div>
                </div>
              );
            })()}
          </section>
        ) : null}
      </div>
    </main>
  );
}

function GasNav() {
  return (
    <header className="console-header">
      <nav className="mx-auto flex min-h-[64px] w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <a href="/" className="flex min-w-0 items-center gap-3">
          <img
            src="/logo.svg"
            alt="WhenCheap logo"
            className="h-6 w-6 shrink-0"
          />
          <span className="truncate text-base font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
            WhenCheap
          </span>
        </a>

        <div className="flex items-center gap-2">
          <a
            href="/"
            className="console-chip hover:bg-[var(--color-accent)] hover:text-black focus-visible:bg-[var(--color-accent)] focus-visible:text-black focus-visible:outline-none"
          >
            Console
          </a>
          <a
            href="/gas"
            aria-current="page"
            className="console-chip border-[var(--color-accent)] text-[var(--color-accent)]"
          >
            Gas Analytics
          </a>
        </div>
      </nav>
    </header>
  );
}

function MetricPanel({
  label,
  value,
  meta,
  tone = 'text-[var(--color-text)]',
}: {
  label: string;
  value: string;
  meta: string;
  tone?: string;
}) {
  return (
    <div className="console-panel gas-metric-panel">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">{label}</p>
      <div className={`mt-2 break-words text-xl font-bold uppercase tracking-[0.08em] leading-tight ${tone}`}>{value}</div>
      <p className="mt-2 break-words text-[10px] uppercase tracking-[0.14em] leading-relaxed text-[var(--color-muted)]">{meta}</p>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-label)]">{label}</p>
      <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-[var(--color-text)]">
        {value}
      </div>
    </div>
  );
}

function TierRow({
  label,
  gwei,
  usd,
  note,
}: {
  label: string;
  gwei: number;
  usd: number;
  note: string;
}) {
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--color-text)]">{label}</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">{note}</p>
        </div>
        <div className="text-right">
          <p className={`text-sm font-bold uppercase tracking-[0.08em] ${gasValueTone(gwei)}`}>{gwei.toFixed(4)} GWEI</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">${usd.toFixed(6)} SWAP</p>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ snapshots }: { snapshots: GasSnapshot[] }) {
  if (!snapshots.length) {
    return (
      <div className="flex h-24 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
        Collecting data...
      </div>
    );
  }

  const fees = snapshots.map((snapshot) => snapshot.baseFeeGwei);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  const range = max - min || 1;
  const width = 640;
  const height = 96;
  const points = fees
    .map((fee, index) => {
      const x = fees.length === 1 ? width / 2 : (index / (fees.length - 1)) * width;
      const y = height - ((fee - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full">
        <polyline points={points} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
      </svg>
      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
        <span>1H AGO</span>
        <span>NOW</span>
      </div>
    </div>
  );
}

function gasValueTone(gwei: number) {
  if (gwei < 0.01) return 'text-[#4dffa3]';
  if (gwei < 0.1) return 'text-[var(--color-warning)]';
  return 'text-[var(--color-danger)]';
}

function tierSwapUsd(gwei: number, ethPriceUsd: number) {
  return gwei * 150_000 * 1e-9 * ethPriceUsd;
}

function trendArrow(trend: string) {
  if (trend === 'rising') return 'UP';
  if (trend === 'falling') return 'DOWN';
  return 'FLAT';
}

function urgencyChipClass(urgency: string) {
  if (urgency === 'high') return 'border-[var(--color-danger)] text-[var(--color-danger)]';
  if (urgency === 'medium') return 'border-[var(--color-warning)] text-[var(--color-warning)]';
  return 'border-[#4dffa3] text-[#4dffa3]';
}

function comparisonTone(value: number) {
  if (value > 20) return 'text-[var(--color-danger)]';
  if (value < -20) return 'text-[#4dffa3]';
  return 'text-[var(--color-warning)]';
}
