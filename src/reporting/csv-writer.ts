import { promises as fs } from 'fs';
import path from 'path';
import type { RewardReport } from './reward-report';

function padNumber(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatReportTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = padNumber(date.getUTCMonth() + 1);
  const day = padNumber(date.getUTCDate());
  const hour = padNumber(date.getUTCHours());
  return `${year}${month}${day}-${hour}`;
}

function escapeCsvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) {
    return '';
  }
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatAmount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return '';
  }
  const fixed = Number(value).toFixed(6);
  return fixed.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1');
}

export async function writeRewardCsvReports(
  reportTime: Date,
  report: RewardReport,
  outputDirectory: string
): Promise<void> {
  const timestamp = formatReportTimestamp(reportTime);
  const directory = path.resolve(outputDirectory);

  await fs.mkdir(directory, { recursive: true });

  const successPath = path.join(directory, `reward-success-${timestamp}.csv`);
  const failurePath = path.join(directory, `reward-fail-${timestamp}.csv`);

  const isoTimestamp = reportTime.toISOString();

  const sortedSuccesses = [...report.successes].sort((a, b) => a.miner_key.localeCompare(b.miner_key));
  const sortedFailures = [...report.failures].sort((a, b) => a.miner_key.localeCompare(b.miner_key));

  const successHeader = 'timestamp,miner_key,amount,reason\n';
  const successRows = sortedSuccesses
    .map((entry) => [
      escapeCsvField(isoTimestamp),
      escapeCsvField(entry.miner_key),
      escapeCsvField(formatAmount(entry.amount)),
      escapeCsvField(entry.reason ?? 'rewarded')
    ].join(','))
    .join('\n');

  const failureHeader = 'timestamp,miner_key,reason\n';
  const failureRows = sortedFailures
    .map((entry) => [
      escapeCsvField(isoTimestamp),
      escapeCsvField(entry.miner_key),
      escapeCsvField(entry.reason ?? 'Unknown error')
    ].join(','))
    .join('\n');

  await fs.writeFile(successPath, successHeader + successRows + (successRows ? '\n' : ''), { encoding: 'utf8' });
  await fs.writeFile(failurePath, failureHeader + failureRows + (failureRows ? '\n' : ''), { encoding: 'utf8' });
}
