// The go/no-go arithmetic, pinned.
//
// Phase 0 produces exactly one number and that number decides whether the paid
// layer gets built. Everything else in the observatory can be re-run; this
// cannot be un-decided. So the branch that prints "the paid layer has a basis"
// is tested here rather than waited for, since in normal operation it first
// executes three weeks after anyone last looked at it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLedger, MIN_WINDOW_DAYS, RATE_THRESHOLD } from '../apps/observatory/ledger-rate.mjs';

const TOOLS = 72;

/** A sweep row. `changes: null` is a baseline row, which has nothing to compare against yet. */
function sweep(day, time, changes, newTools = 0) {
  return {
    day,
    at: `${day}T${time}Z`,
    servers_reachable: 8,
    servers_unreachable: 12,
    tools_observed: TOOLS,
    contract_changes: changes,
    new_tools: changes === null ? null : newTools,
    changes: [],
  };
}

const ledgerOf = (...days) => ({ schema_version: 'test', started_on: days[0]?.day, days });

test('a rate is withheld until the window can support one', () => {
  const s = summarizeLedger(
    ledgerOf(sweep('2026-07-26', '04:42:09.588', null), sweep('2026-07-26', '04:51:00.916', 0)),
    { tools: TOOLS, serversOk: 8, now: '2026-07-26T04:51:00.916Z' },
  );
  assert.equal(s.reading, 'withheld');
  assert.equal(s.rate, null);
  assert.match(s.lines.join('\n'), /withheld\. 0\.0 of 7 days/);
});

test('no rate is computed from zero tools, however many changes were recorded', () => {
  const s = summarizeLedger(
    ledgerOf(sweep('2026-06-01', '00:00:00.000', null), sweep('2026-07-01', '00:00:00.000', 5)),
    { tools: 0, serversOk: 0, now: '2026-07-01T00:00:00.000Z' },
  );
  assert.equal(s.reading, 'withheld');
  assert.equal(s.rate, null);
});

/**
 * The regression. Sweeping more than once a day is ordinary (a manual re-run, a
 * scheduler catching up), and the old arithmetic counted every row as a day, so
 * three sweeps in one afternoon read as three days of calm and divided the rate
 * by three. Elapsed time is what a rate is per.
 */
test('several sweeps in one day are one day, not several', () => {
  const morning = ledgerOf(
    sweep('2026-06-01', '01:00:00.000', null),
    sweep('2026-07-01', '00:00:00.000', 9),
  );
  const busy = ledgerOf(
    sweep('2026-06-01', '01:00:00.000', null),
    sweep('2026-06-01', '02:00:00.000', 0),
    sweep('2026-06-01', '03:00:00.000', 0),
    sweep('2026-07-01', '00:00:00.000', 9),
  );
  const ctx = { tools: TOOLS, serversOk: 8, now: '2026-07-01T00:00:00.000Z' };

  const a = summarizeLedger(morning, ctx);
  const b = summarizeLedger(busy, ctx);

  assert.equal(a.rate, b.rate, 'extra sweeps inside a day must not move the rate');
  assert.equal(b.daysSwept, 2, 'three sweeps on 06-01 plus one on 07-01 is two days swept');
  assert.equal(b.sweeps, 4, 'the raw record still keeps every sweep');
});

/**
 * The direction that would have done real damage. Two sweeps a month apart with
 * ten changes between them: dividing by rows gives 6.25 changes per tool per
 * quarter and prints "the paid layer has a basis", when the honest figure is
 * 0.42 and says keep sweeping. The old bug did not blur the decision, it
 * inverted it, using our own downtime as the evidence.
 */
test('missed sweeps do not inflate the rate into a false go', () => {
  const gappy = ledgerOf(
    sweep('2026-06-01', '00:00:00.000', null),
    sweep('2026-07-01', '00:00:00.000', 10),
  );
  const s = summarizeLedger(gappy, { tools: TOOLS, serversOk: 8, now: '2026-07-01T00:00:00.000Z' });

  const byRowCount = (10 / TOOLS / 2) * 90; // what the old code computed
  assert.ok(byRowCount >= RATE_THRESHOLD, 'the old arithmetic cleared the threshold');
  assert.ok(s.rate < RATE_THRESHOLD, 'the honest arithmetic does not');
  assert.equal(s.reading, 'below');
  assert.equal(s.spanDays, 30);
});

test('an incomplete record says so, and calls its own count a floor', () => {
  const s = summarizeLedger(
    ledgerOf(sweep('2026-06-01', '00:00:00.000', null), sweep('2026-07-01', '00:00:00.000', 1)),
    { tools: TOOLS, serversOk: 8, now: '2026-07-01T00:00:00.000Z' },
  );
  assert.equal(s.daysSwept, 2);
  assert.equal(s.daysElapsed, 31, 'June 1 through July 1 inclusive');
  assert.equal(s.gapDays, 29);
  assert.match(s.lines.join('\n'), /GAPS\s+: 29 day\(s\) went unswept/);
  assert.match(s.lines.join('\n'), /floor/);
});

test('a swept-every-day record reports no gaps', () => {
  const days = [];
  for (let d = 1; d <= 10; d++) {
    const day = `2026-06-${String(d).padStart(2, '0')}`;
    days.push(sweep(day, '00:00:00.000', d === 1 ? null : 0));
  }
  const s = summarizeLedger(ledgerOf(...days), {
    tools: TOOLS,
    serversOk: 8,
    now: '2026-06-10T00:00:00.000Z',
  });
  assert.equal(s.gapDays, 0);
  assert.ok(!s.lines.join('\n').includes('GAPS'));
});

/** Contracts moving weekly is the reading the plan pre-committed to as a go. */
test('a genuinely busy corpus clears the threshold', () => {
  const days = [sweep('2026-06-01', '00:00:00.000', null)];
  for (let d = 2; d <= 30; d++) {
    days.push(sweep(`2026-06-${String(d).padStart(2, '0')}`, '00:00:00.000', 1));
  }
  const s = summarizeLedger(ledgerOf(...days), {
    tools: 10,
    serversOk: 8,
    now: '2026-06-30T00:00:00.000Z',
  });
  // 29 changes over 10 tools in 29 days -> 9 per tool per quarter.
  assert.equal(s.reading, 'at-or-above');
  assert.ok(s.rate >= RATE_THRESHOLD);
  assert.match(s.lines.join('\n'), /The paid layer has a basis/);
});

test('the first sweep only establishes a baseline', () => {
  const s = summarizeLedger(ledgerOf(sweep('2026-06-01', '00:00:00.000', null)), {
    tools: TOOLS,
    serversOk: 8,
    now: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(s.reading, 'baseline');
  assert.equal(s.rate, null);
  assert.match(s.lines.join('\n'), /Comparison starts on the next sweep/);
});

test('an empty ledger reports nothing rather than dividing by it', () => {
  const s = summarizeLedger({ days: [] }, { tools: TOOLS, serversOk: 8, now: '2026-06-01T00:00:00.000Z' });
  assert.equal(s.reading, 'empty');
  assert.equal(s.rate, null);
  assert.equal(s.daysElapsed, 0);
});

test('the withholding window is the one the plan named', () => {
  assert.equal(MIN_WINDOW_DAYS, 7);
  assert.equal(RATE_THRESHOLD, 1);
});
