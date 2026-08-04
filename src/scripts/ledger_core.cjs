// CANON FFG accrual ledger — pure functions (no I/O). Denominator = 2000 passes (all, minted or not).
const DENOM = 2000;

// Accrue one holderCut inflow (micro) for an ASA into ledger state, bucketed by its UTC month.
// state per ASA: { cumPerSlot, dustCarry, monthCum: {"YYYY-MM": cumThroughEndOfMonth}, processed: Set }
function accrue(state, asaId, inflowMicro, confirmMonth /* "YYYY-MM" */) {
  const s = state[asaId] || (state[asaId] = { cumPerSlot: 0, dustCarry: 0, monthCum: {} });
  const pool = inflowMicro + s.dustCarry;
  const perSlot = Math.floor(pool / DENOM);
  s.cumPerSlot += perSlot;
  s.dustCarry = pool - perSlot * DENOM;
  // monotonic month record: this month (and any later already-seen) hold cumThroughEnd = current cumPerSlot
  s.monthCum[confirmMonth] = s.cumPerSlot;
  return s;
}

// cumulative-per-slot eligible through end of the last COMPLETED month before cutoffMonth (exclusive).
// cutoffMonth = current month "YYYY-MM"; we pay everything from months strictly earlier.
function eligibleCumThroughCompleted(state, asaId, cutoffMonth) {
  const s = state[asaId];
  if (!s) return 0;
  let elig = 0;
  for (const [m, cum] of Object.entries(s.monthCum)) {
    if (m < cutoffMonth) elig = Math.max(elig, cum); // months are lexicographically ordered for YYYY-MM
  }
  return elig;
}

// pending for a pass given its paid watermark; clamp >= 0.
const pending = (cum, paid) => Math.max(0, cum - paid);

module.exports = { DENOM, accrue, eligibleCumThroughCompleted, pending };

// ---- UNIT PROOFS ----
if (require.main === module) {
  const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('PASS:', m); };
  let st = {};
  // dust carry: inflow 999999 -> perSlot 499, dust 1999 (999999/2000=499.9995)
  accrue(st, 'A', 999999, '2026-07');
  assert(st['A'].cumPerSlot === 499 && st['A'].dustCarry === 1999, `dust: cumPerSlot=${st['A'].cumPerSlot} dust=${st['A'].dustCarry} (want 499/1999)`);
  // next inflow consumes carry: +1 (pool=1+1999=2000 -> perSlot 1, dust 0)
  accrue(st, 'A', 1, '2026-07');
  assert(st['A'].cumPerSlot === 500 && st['A'].dustCarry === 0, `carry-consumed: cumPerSlot=${st['A'].cumPerSlot} dust=${st['A'].dustCarry} (want 500/0)`);
  // month cutoff: July inflows eligible when cutoff=2026-08; NOT when cutoff=2026-07
  assert(eligibleCumThroughCompleted(st, 'A', '2026-08') === 500, 'July fully eligible on Aug-1 cutoff');
  assert(eligibleCumThroughCompleted(st, 'A', '2026-07') === 0, 'July NOT eligible on Jul-1 cutoff (current month excluded)');
  // Aug inflow belongs to Aug, not paid on Aug-1 (cutoff 2026-08)
  accrue(st, 'A', 4000, '2026-08'); // +2 per slot
  assert(st['A'].cumPerSlot === 502, `aug accrued: ${st['A'].cumPerSlot} (want 502)`);
  assert(eligibleCumThroughCompleted(st, 'A', '2026-08') === 500, 'Aug inflow NOT eligible on Aug-1 (pays Sep-1)');
  assert(eligibleCumThroughCompleted(st, 'A', '2026-09') === 502, 'Aug eligible on Sep-1 cutoff');
  // mint mid-July gets cumPerSlot-to-date (full pending); pass paid=0 -> pending=500 after; monthly Aug-1 pays only remainder
  const mintPending = pending(st['A'].cumPerSlot, 0); // 502 (all to date incl current)
  assert(mintPending === 502, `mint full backlog: ${mintPending} (want 502 = all-to-date)`);
  // after mint paid=502 (cumPerSlot at mint). Aug-1 monthly: eligibleCum(Aug cutoff)=500 <= paid 502 -> pay max(0,500-502)=0
  assert(pending(500, 502) === 0, 'post-mint Aug-1 pays 0 (clamp >=0; already paid past completed-month cum)');
  // idempotency: re-accrue a processed txid is caller-guarded via processed set (structural); dry-run advances nothing (caller).
  console.log('LEDGER UNIT PROOFS COMPLETE');
}
