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
