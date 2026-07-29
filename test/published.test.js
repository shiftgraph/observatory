/**
 * Nothing may be published from across a profiler boundary.
 *
 * `history.ndjson` carries marker rows. A drift row before one was computed by
 * a profiler we have since corrected, or against a baseline built by one, so
 * it is a fact about our arithmetic rather than about a provider. Summing the
 * file end to end mixes the two and the result looks exactly like evidence.
 *
 * This is not hypothetical. Reading this same file by hand produced six drift
 * events where the instrument reports one, because the sum ran straight
 * through the marker. The marker had been there the whole time and was written
 * for a human to notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishable, MIN_SWEEPS_TO_PUBLISH } from '../apps/observatory/published.mjs';

const boundary = (at) =>
  JSON.stringify({ at, marker: 'profiler-boundary', note: 'corrected', drift: [] });

const sweep = (at, { ok = 100, shaped = 90, drift = 0 } = {}) =>
  JSON.stringify({ at, ok, shaped, drift_events: drift, new_ops: 0, drift: [] });

test('drift recorded before the boundary is never counted', () => {
  const record = publishable([
    sweep('2026-07-01T00:00:00Z', { drift: 3 }),
    sweep('2026-07-02T00:00:00Z', { drift: 4 }),
    boundary('2026-07-03T00:00:00Z'),
    sweep('2026-07-04T00:00:00Z', { drift: 1 }),
  ]);
  assert.equal(record.drift_events, 1, 'the seven pre-boundary events must not appear');
  assert.equal(record.sweeps, 1);
  assert.equal(record.since, '2026-07-03T00:00:00Z');
});

test('a naive sum would get it wrong, which is why this exists', () => {
  const lines = [
    sweep('2026-07-01T00:00:00Z', { drift: 3 }),
    boundary('2026-07-02T00:00:00Z'),
    sweep('2026-07-03T00:00:00Z', { drift: 0 }),
  ];
  const naive = lines
    .map((l) => JSON.parse(l))
    .reduce((s, r) => s + (r.drift_events || 0), 0);
  assert.equal(naive, 3);
  assert.equal(publishable(lines).drift_events, 0);
});

test('the LAST boundary wins when the profiler is corrected twice', () => {
  const record = publishable([
    boundary('2026-07-01T00:00:00Z'),
    sweep('2026-07-02T00:00:00Z', { drift: 5 }),
    boundary('2026-07-03T00:00:00Z'),
    sweep('2026-07-04T00:00:00Z', { drift: 2 }),
  ]);
  assert.equal(record.drift_events, 2);
  assert.equal(record.sweeps, 1);
});

test('a failed run is counted as a failure, not as a quiet sweep', () => {
  const record = publishable([
    boundary('2026-07-01T00:00:00Z'),
    sweep('2026-07-02T00:00:00Z'),
    JSON.stringify({ at: '2026-07-03T00:00:00Z', error: 'ENOTFOUND' }),
    sweep('2026-07-04T00:00:00Z'),
  ]);
  assert.equal(record.sweeps, 2, 'a failed run must not inflate the sweep count');
  assert.equal(record.failed_runs, 1);
  assert.equal(record.endpoints_reached, 200, 'and must not contribute zeros to the totals');
});

test('a thin record refuses to be published rather than printing a small number', () => {
  const thin = publishable([boundary('2026-07-01T00:00:00Z'), sweep('2026-07-02T00:00:00Z')]);
  assert.equal(thin.publishable, false);

  const enough = publishable([
    boundary('2026-07-01T00:00:00Z'),
    ...Array.from({ length: MIN_SWEEPS_TO_PUBLISH }, (_, i) =>
      sweep(`2026-07-${String(2 + Math.floor(i / 4)).padStart(2, '0')}T0${i % 4}:00:00Z`),
    ),
  ]);
  assert.equal(enough.publishable, true);
});

test('a record with no boundary at all still reports every sweep', () => {
  // The boundary is a correction marker, not a requirement. A record that has
  // never needed one publishes all of itself.
  const record = publishable([
    sweep('2026-07-01T00:00:00Z', { drift: 1 }),
    sweep('2026-07-02T00:00:00Z', { drift: 0 }),
  ]);
  assert.equal(record.sweeps, 2);
  assert.equal(record.drift_events, 1);
});

test('marker rows never count as sweeps', () => {
  const record = publishable([boundary('2026-07-01T00:00:00Z'), boundary('2026-07-02T00:00:00Z')]);
  assert.equal(record.sweeps, 0);
  assert.equal(record.latest, null);
  assert.equal(record.publishable, false);
});

/**
 * One bad sweep is retracted without discarding the good ones.
 *
 * A profiler-boundary is the right instrument when the profiler itself changed,
 * and far too blunt for a single contaminated sweep: it would throw away every
 * earlier sweep to disown a handful of claims.
 *
 * This happened on 2026-07-29T18:58Z. The sweep ran while rate-limited, six
 * GitHub endpoints answered 403 with a JSON error envelope, and the engine
 * profiled the rate-limit page as the interface - six BREAKING events, into the
 * published record. The sweep itself was sound: 178 endpoints reached. Only its
 * drift claims were wrong.
 *
 * So a retraction names the sweeps whose drift is disowned, appends rather than
 * edits, and leaves the wrong claims visible in the file. Correcting by deletion
 * would leave no evidence the correction happened, which is the failure this
 * record exists to avoid.
 */
const retraction = (at, retracts) =>
  JSON.stringify({ at, marker: 'drift-retraction', retracts, reason: 'rate-limited sweep' });

test('a retracted sweep still counts as a sweep, but its drift does not', () => {
  const lines = [
    boundary('2026-07-01T00:00:00.000Z'),
    sweep('2026-07-01T06:00:00.000Z', { drift: 1 }),
    sweep('2026-07-01T12:00:00.000Z', { drift: 6 }),
    retraction('2026-07-01T13:00:00.000Z', ['2026-07-01T12:00:00.000Z']),
  ];
  const r = publishable(lines);
  assert.equal(r.sweeps, 2, 'the sweep happened and still counts');
  assert.equal(r.drift_events, 1, 'only the retracted sweep’s drift is dropped');
  assert.equal(r.endpoints_reached, 200, 'reach is unaffected by a drift retraction');
});

test('a retraction naming a sweep that does not exist changes nothing', () => {
  const lines = [
    boundary('2026-07-01T00:00:00.000Z'),
    sweep('2026-07-01T06:00:00.000Z', { drift: 2 }),
    retraction('2026-07-01T13:00:00.000Z', ['2026-07-01T99:00:00.000Z']),
  ];
  assert.equal(publishable(lines).drift_events, 2);
});

test('a retraction row is not itself counted as a sweep', () => {
  const lines = [
    boundary('2026-07-01T00:00:00.000Z'),
    sweep('2026-07-01T06:00:00.000Z'),
    retraction('2026-07-01T13:00:00.000Z', []),
  ];
  assert.equal(publishable(lines).sweeps, 1);
});
