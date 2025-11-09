export const LEGACY_FRY_ASSET_ID = '924268058';
export const TFRY_ASSET_ID = '2681521901';

export type TfryDelta = {
  pending?: number;
  claimable?: number;
  aggregated?: number;
  claimed?: number;
};

export function isTfryAsset(assetId: unknown): boolean {
  return typeof assetId === 'string' && assetId === TFRY_ASSET_ID;
}

export function applyTfryDelta(target: Record<string, number>, delta: TfryDelta): void {
  const bump = (field: string, value: number): void => {
    if (!Number.isFinite(value) || value === 0) {
      return;
    }
    target[field] = (target[field] ?? 0) + value;
  };

  let totalDelta = 0;

  if (delta.pending && delta.pending !== 0) {
    bump('tfry_pending', delta.pending);
    bump('total_pending', delta.pending);
    totalDelta += delta.pending;
  }

  if (delta.claimable && delta.claimable !== 0) {
    bump('tfry_claimable', delta.claimable);
    bump('total_claimable', delta.claimable);
    totalDelta += delta.claimable;
  }

  if (delta.aggregated && delta.aggregated !== 0) {
    bump('tfry_aggregated', delta.aggregated);
    totalDelta += delta.aggregated;
  }

  if (delta.claimed && delta.claimed !== 0) {
    bump('tfry_claimed', delta.claimed);
    bump('total_claimed', delta.claimed);
    totalDelta += delta.claimed;
  }

  if (totalDelta !== 0) {
    bump('tfry_total', totalDelta);
  }
}
