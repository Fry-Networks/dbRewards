export interface RewardReportEntry {
  miner_key: string;
  amount?: number;
  reason?: string;
}

export interface RewardReport {
  successes: RewardReportEntry[];
  failures: RewardReportEntry[];
}

type AggregatedStatus = 'success' | 'failure';

interface AggregatedEntry {
  status: AggregatedStatus;
  amount: number;
  reasons: Set<string>;
}

function sanitizeAmount(value: number | undefined): number {
  if (typeof value !== 'number') {
    return 0;
  }
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    return 0;
  }
  return value;
}

function sanitizeReason(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function combineReasons(reasons: Set<string>): string | undefined {
  if (reasons.size === 0) {
    return undefined;
  }
  return Array.from(reasons).join(' | ');
}

export class RewardReportAggregator {
  private readonly entries = new Map<string, AggregatedEntry>();

  addReport(report: RewardReport): void {
    report.failures.forEach((entry) => this.addFailure(entry));
    report.successes.forEach((entry) => this.addSuccess(entry));
  }

  toReport(): RewardReport {
    const successes: RewardReportEntry[] = [];
    const failures: RewardReportEntry[] = [];

    this.entries.forEach((entry, minerKey) => {
      const reason = combineReasons(entry.reasons);
      if (entry.status === 'success') {
        successes.push({ miner_key: minerKey, amount: entry.amount, reason });
      } else {
        failures.push({ miner_key: minerKey, reason });
      }
    });

    return { successes, failures };
  }

  private addSuccess(entry: RewardReportEntry): void {
    if (!entry?.miner_key) {
      return;
    }

    const amount = sanitizeAmount(entry.amount);
    const reason = sanitizeReason(entry.reason, 'rewarded');
    const existing = this.entries.get(entry.miner_key);

    if (existing) {
      existing.status = 'success';
      existing.amount += amount;
      existing.reasons = new Set([reason]);
      return;
    }

    this.entries.set(entry.miner_key, {
      status: 'success',
      amount,
      reasons: new Set([reason])
    });
  }

  private addFailure(entry: RewardReportEntry): void {
    if (!entry?.miner_key) {
      return;
    }

    const reason = sanitizeReason(entry.reason, 'Unknown error');
    const existing = this.entries.get(entry.miner_key);

    if (existing) {
      if (existing.status === 'success') {
        return;
      }
      existing.reasons.add(reason);
      return;
    }

    this.entries.set(entry.miner_key, {
      status: 'failure',
      amount: 0,
      reasons: new Set([reason])
    });
  }
}
