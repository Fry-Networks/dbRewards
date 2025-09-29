import "dotenv/config";

// Time control utilities to support accelerated simulation (e.g., 7 days in 7 hours)

// When SIMULATION_ENABLED=true and TIME_ACCEL is set (e.g., 24), the system
// treats time as accelerated by TIME_ACCEL. All time checks use getSimNow(), and
// scheduler intervals can be scaled via scaledIntervalMs().

const SIMULATION_ENABLED = process.env.SIMULATION_ENABLED === 'true';
const TIME_ACCEL = Math.max(1, Number(process.env.TIME_ACCEL || '1'));

// Anchor the real and simulated clocks to ensure a stable mapping
const REAL_ANCHOR = Date.now();
// Optional simulation start anchor (ISO string or epoch ms); defaults to REAL_ANCHOR
const SIM_START_AT_ENV = process.env.SIM_START_AT;
const SIM_ANCHOR = (() => {
  if (!SIM_START_AT_ENV) return REAL_ANCHOR;
  const parsed = Date.parse(SIM_START_AT_ENV);
  return Number.isFinite(parsed) ? parsed : REAL_ANCHOR;
})();

/**
 * Returns the current time. If simulation is enabled, it maps real time to a
 * simulated timeline using the configured acceleration factor.
 */
export function getSimNow(): Date {
  if (!SIMULATION_ENABLED || TIME_ACCEL === 1) {
    return new Date();
  }
  const realElapsed = Date.now() - REAL_ANCHOR;
  const simElapsed = realElapsed * TIME_ACCEL;
  return new Date(SIM_ANCHOR + simElapsed);
}

/** Returns the active acceleration factor (>= 1). */
export function getTimeAcceleration(): number {
  return SIMULATION_ENABLED ? TIME_ACCEL : 1;
}

/** Scales an interval (ms) so that polling frequency tracks simulated time. */
export function scaledIntervalMs(originalMs: number): number {
  const accel = getTimeAcceleration();
  if (accel <= 1) return originalMs;
  // Ensure we don't create extremely small intervals
  return Math.max(250, Math.floor(originalMs / accel));
}

/** Human-friendly banner describing the current time configuration. */
export function getTimeConfigSummary(): string {
  if (!SIMULATION_ENABLED || TIME_ACCEL === 1) {
    return 'Clock: real-time (no acceleration)';
  }
  return `Clock: SIMULATED x${TIME_ACCEL} (7d→7h set via TIME_ACCEL=24)`;
}

