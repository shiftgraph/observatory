// The arithmetic that reads the contract ledger, kept apart from the sweep that
// writes it.
//
// This is the smallest and most consequential code in Phase 0. Everything else
// observes; this decides. The plan pre-committed to a reading before any data
// existed, so that the number could not be argued with afterwards:
//
//   tool contracts moving weekly            -> the paid layer is real
//   roughly one change per tool per quarter -> the frequency argument has now
//                                              failed twice, and we stop
//
// It lives in its own module because a decision that size has to be testable
// without spawning twenty servers, and because the first version of it was
// wrong in a way no sweep would ever have surfaced.
//
// THE DEFECT THIS MODULE EXISTS TO PREVENT. The rate divided total changes by
// the NUMBER OF LEDGER ROWS and printed the result as a per-day figure. A row
// is a sweep, not a day. Sweeping three times in one afternoon of development
// therefore read as three days of quiet and cut the rate to a third, while a
// month of downtime broken by two sweeps read as two days and multiplied it
// fifteenfold.
//
// The inflating direction is the dangerous one. A rate driven up by the sweeps
// we MISSED prints "the paid layer has a basis" and sends us to build on a
// measurement of our own downtime. An instrument that is confident because it
// went blind is the precise failure this product sells itself as catching, so
// it is not one we get to ship.

/**
 * Under a week, a rate carries no information: a single change against a
 * two-day window annualizes into nonsense. A withheld number is recoverable,
 * whereas a confident wrong one gets quoted.
 */
export const MIN_WINDOW_DAYS = 7;

/** Changes per tool per quarter at or above this means the paid layer has a basis. */
export const RATE_THRESHOLD = 1;

const MS_PER_DAY = 86_400_000;

/** Inclusive count of calendar days from one YYYY-MM-DD to another. */
function calendarDaysBetween(fromDay, toDay) {
  const ms = Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`);
  return Math.round(ms / MS_PER_DAY) + 1;
}

/**
 * Read the ledger. Pure: no clock of its own, no filesystem, so the caller
 * supplies `now` and the tests supply any history they like.
 *
 * @param {{days: Array<object>}} ledger
 * @param {{tools: number, serversOk: number, now: string}} ctx
 */
export function summarizeLedger(ledger, { tools = 0, serversOk = 0, now }) {
  const days = ledger?.days ?? [];
  const nowMs = Date.parse(now);

  if (days.length === 0) {
    return {
      reading: 'empty',
      sweeps: 0,
      daysSwept: 0,
      daysElapsed: 0,
      gapDays: 0,
      spanDays: 0,
      totalChanges: 0,
      totalNew: 0,
      rate: null,
      lines: ['  no sweep has been recorded yet.'],
    };
  }

  const comparable = days.filter((d) => d.contract_changes !== null && d.contract_changes !== undefined);
  const totalChanges = comparable.reduce((n, d) => n + d.contract_changes, 0);
  const totalNew = comparable.reduce((n, d) => n + (d.new_tools ?? 0), 0);

  // Elapsed time, from the first observation to this one. Not the row count.
  const spanDays = Math.max(0, (nowMs - Date.parse(days[0].at)) / MS_PER_DAY);
  const daysSwept = new Set(days.map((d) => d.day)).size;
  const daysElapsed = Math.max(daysSwept, calendarDaysBetween(days[0].day, now.slice(0, 10)));
  const gapDays = daysElapsed - daysSwept;

  const lines = [];
  lines.push(`  tools under observation : ${tools} across ${serversOk} servers`);

  if (comparable.length === 0) {
    lines.push('  baseline established. Comparison starts on the next sweep.');
    return {
      reading: 'baseline',
      sweeps: days.length,
      daysSwept,
      daysElapsed,
      gapDays,
      spanDays,
      totalChanges: 0,
      totalNew: 0,
      rate: null,
      lines,
    };
  }

  lines.push(`  window observed         : ${daysSwept} day(s) swept across ${daysElapsed} elapsed`);
  lines.push(`  contract changes seen   : ${totalChanges}`);
  lines.push(`  new tools appeared      : ${totalNew}`);

  // A change that appeared and reverted inside a gap was never observed, so the
  // count is a floor and has to say so out loud.
  if (gapDays > 0) {
    lines.push(
      `  GAPS                    : ${gapDays} day(s) went unswept. A change that landed and ` +
        `reverted inside a gap was never seen, so the count above is a floor.`,
    );
  }

  let rate = null;
  let reading;
  if (tools <= 0) {
    reading = 'withheld';
    lines.push('  implied rate            : withheld. No tools were under observation.');
  } else if (spanDays < MIN_WINDOW_DAYS) {
    reading = 'withheld';
    lines.push(
      `  implied rate            : withheld. ${spanDays.toFixed(1)} of ${MIN_WINDOW_DAYS} days ` +
        `needed before a rate means anything.`,
    );
  } else {
    rate = (totalChanges / tools / spanDays) * 90;
    reading = rate >= RATE_THRESHOLD ? 'at-or-above' : 'below';
    lines.push(`  implied rate            : ${rate.toFixed(2)} changes per tool per quarter`);
    lines.push(
      reading === 'at-or-above'
        ? '  reading                 : at or above the threshold the plan set. The paid layer has a basis.'
        : '  reading                 : below the threshold so far. Keep sweeping; decide at three weeks.',
    );
  }

  return {
    reading,
    sweeps: days.length,
    daysSwept,
    daysElapsed,
    gapDays,
    spanDays,
    totalChanges,
    totalNew,
    rate,
    lines,
  };
}
