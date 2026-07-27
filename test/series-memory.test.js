// Series memory (mechanism 2b): optionality carried forward when a baseline rolls.
//
// Presence within one response cannot see a state-conditioned field, because a
// single-sample object reveals nothing about which of its fields are optional.
// The evidence is spread across time instead of across siblings, and the
// baseline is where time is kept.
//
// Observed live: status.openai.com returns one incident. On Monday it had no
// `monitoring_at`; on Tuesday the incident moved to monitoring and gained one;
// when it resolved the field went away again. Each transition reported a
// contract change, forever, on a field that was always conditional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileValue, structuralProfile, structuralDiff, carryOptionality } from '../packages/core/shape.js';

const prof = (v) => structuralProfile(profileValue(v));

/** Run a series through the production path: diff against baseline, then roll. */
function replay(bodies) {
  let baseline = prof(bodies[0]);
  const events = [];
  for (let i = 1; i < bodies.length; i++) {
    const observed = prof(bodies[i]);
    events.push(structuralDiff(baseline, observed));
    baseline = carryOptionality(baseline, observed);
  }
  return events;
}

const noField = { incidents: [{ id: 'x', status: 'investigating' }] };
const withField = { incidents: [{ id: 'x', status: 'monitoring', monitoring_at: '2026-07-24' }] };

/**
 * The defect, proven before the fix is proven. Without carrying optionality the
 * pair oscillates: added, removed, added, once per transition, indefinitely.
 */
test('WITHOUT series memory the same conditional field reports on every flip', () => {
  const bodies = [noField, withField, noField, withField];
  let baseline = prof(bodies[0]);
  const events = [];
  for (let i = 1; i < bodies.length; i++) {
    const observed = prof(bodies[i]);
    events.push(structuralDiff(baseline, observed));
    baseline = observed; // the old roll: replace, remember nothing
  }
  assert.equal(events.filter((e) => e.length).length, 3, 'three flips, three reports');
});

test('WITH series memory it reports once, on the day it first appeared', () => {
  const events = replay([noField, withField, noField, withField]);
  const reported = events.filter((e) => e.length);
  assert.equal(reported.length, 1, 'the appearance is reported exactly once');
  assert.equal(reported[0][0].type, 'field_added');
  assert.match(reported[0][0].path, /monitoring_at$/);
  assert.equal(reported[0][0].breaking, false, 'an appearing field is additive');
});

test('a vanished field is retained as optional rather than dropped', () => {
  // Dropping it would make its return read as new, and the pair oscillates.
  const rolled = carryOptionality(prof(withField), prof(noField));
  const el = rolled.keys.incidents.element;
  assert.ok(el.keys.monitoring_at, 'the field survives the roll');
  assert.equal(el.keys.monitoring_at.optional, true, 'and is marked conditional');
});

/**
 * The half that must not break: series memory may never hide a real removal the
 * first time it happens. Reporting once is the goal; reporting never is a
 * blinded instrument.
 */
test('a genuine removal is still reported, once', () => {
  const before = { user: { id: 'x', email: 'e', legacy_token: 't' } };
  const after = { user: { id: 'x', email: 'e' } };
  const events = replay([before, after, after, after]);
  const reported = events.filter((e) => e.length);
  assert.equal(reported.length, 1, 'reported on the day it happened');
  assert.equal(reported[0][0].type, 'field_removed');
  assert.equal(reported[0][0].breaking, true, 'a removal is breaking');
  assert.match(reported[0][0].path, /legacy_token$/);
});

test('a stable contract produces nothing at all', () => {
  const body = { a: 1, b: 'x', c: { d: true }, e: [{ f: 1 }] };
  const events = replay([body, body, body, body]);
  assert.equal(events.filter((e) => e.length).length, 0);
});

test('carrying optionality never invents or loses a field', () => {
  const prior = prof({ a: 1, b: 2 });
  const next = prof({ b: 2, c: 3 });
  const rolled = carryOptionality(prior, next);
  assert.deepEqual(Object.keys(rolled.keys).sort(), ['a', 'b', 'c'], 'union of both');
  assert.equal(rolled.keys.a.optional, true, 'seen absent, so conditional');
  assert.equal(rolled.keys.c.optional, true, 'seen absent, so conditional');
  assert.equal(rolled.keys.b.optional, undefined, 'present throughout, claims nothing');
});

test('it recurses through arrays as well as objects', () => {
  const rolled = carryOptionality(prof({ xs: [{ a: 1 }] }), prof({ xs: [{ b: 2 }] }));
  const el = rolled.keys.xs.element;
  assert.equal(el.keys.a.optional, true);
  assert.equal(el.keys.b.optional, true);
});
