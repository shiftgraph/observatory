// Object keys that are identifiers, not contract.
//
// Backlog Issue 4. The engine stored every key verbatim, which is right for a
// record and wrong for an object keyed by data. Two things followed: a
// customer's identifiers were retained in the shape profile, and a map appeared
// to change contract on every request whose key set differed. The second is the
// worse one, because fabricated drift inflates the exact number Phase 0 exists
// to measure, in the optimistic direction.
//
// These tests pin both halves, and equally pin what must NOT be touched: the
// ordinary field names that ARE the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { templateKey, inferPathTemplate } from '../packages/core/url.js';
import { profileValue, structuralProfile } from '../packages/core/shape.js';

const identity = (v) => JSON.stringify(structuralProfile(profileValue(v)));

test('an email is redacted wherever it appears', () => {
  // The SDK docstring named this exact string as one it strips. It did not.
  assert.equal(inferPathTemplate('/customers/alice@example.com'), '/customers/{email}');
  assert.equal(inferPathTemplate('/users/alice.smith@corp.co.uk/orders'), '/users/{email}/orders');
  assert.equal(templateKey('alice@example.com'), '{email}');
});

test('identifier-shaped keys are redacted', () => {
  assert.equal(templateKey('550e8400-e29b-41d4-a716-446655440000'), '{uuid}');
  assert.equal(templateKey('2026-07-26'), '{date}');
  assert.equal(templateKey('cus_A1b2C3d4'), '{token}');
  assert.equal(templateKey('usr_a1b2c3'), '{token}');
  assert.equal(templateKey('deadbeefdeadbeef01'), '{hex}');
});

/**
 * The half that would break the product if it were wrong: a redacted field name
 * erases the contract instead of protecting it.
 *
 * THE LOWER GROUP IS THE IMPORTANT ONE. Every entry there is a real key from a
 * real API that the first version of this rule destroyed, caught by the
 * observatory on the first comparison after the change. The first draft reused
 * the path rules wholesale, so the 24-character opaque-token rule ate
 * `astronomicalTwilightBegin` and the name-then-digits rule ate `address_1` -
 * the same class of defect as the original templating bug, reproduced within an
 * hour of writing the warning against it. Invented examples did not catch it,
 * because the ones I invented were short. Observed ones did.
 */
test('ordinary field names are left exactly alone', () => {
  const invented = [
    'id', 'name', 'email', 'url', 'type', 'data', 'items', 'usd', 'status',
    'user_id', 'created_at', 'first_name', 'is_active', 'response_time',
    '_id', '__typename', 'v1', '2xx', 'sha', 'oauth2',
  ];
  const observed = [
    'astronomicalTwilightBegin',            // api.weather.gov, 25 chars
    'market_cap_change_24h_in_currency',    // api.coingecko.com
    'address_1', 'address_2',               // api.fda.gov
    'psr-4',                                // repo.packagist.org, a PSR standard
    'latest-4',                             // registry.npmjs.org, a dist-tag
    'scheduled_maintenances',               // statuspage v2
  ];
  for (const k of [...invented, ...observed]) {
    assert.equal(templateKey(k), k, `field name ${k} must survive untouched`);
  }
});

/**
 * Deliberately preserved, each because syntax cannot decide. Pinned so that a
 * later pass has to change the test on purpose rather than by accident.
 */
test('the undecidable shapes are left to the observational pass', () => {
  // A status histogram is contract vocabulary.
  assert.equal(templateKey('200'), '200');
  assert.equal(templateKey('0'), '0');
  // `user_12345` is an id and `address_1` is a field; same string shape, and no
  // threshold separates them. Guessing is what broke this the first time.
  assert.equal(templateKey('user_12345'), 'user_12345');
  assert.equal(templateKey('order-42'), 'order-42');
  // A real word in key position.
  assert.equal(templateKey('bitcoin'), 'bitcoin');
});

test('a map keyed by identifiers stops fabricating drift', () => {
  // The same contract, observed twice, with different entities present. Before
  // the fix these produced different shapes and therefore a drift event on
  // every request.
  const monday = { 'usr_a1b2c3': { plan: 'x', seats: 3 }, 'usr_d4e5f6': { plan: 'y', seats: 1 } };
  const tuesday = { 'usr_9z8y7x': { plan: 'z', seats: 9 } };
  assert.equal(identity(monday), identity(tuesday), 'a differing key set is not a contract change');

  const profile = profileValue(monday);
  assert.deepEqual(Object.keys(profile.keys), ['{token}'], 'both entities collapse to one templated key');
  assert.equal(profile.key_count, 2, 'how many entries the map held is still reported honestly');
});

test('colliding keys merge rather than the last one winning', () => {
  // Two entities whose value shapes differ must union, not overwrite, or the
  // profile would describe whichever key happened to sort last.
  const p = profileValue({ 'usr_a1b2c3': { seats: 3 }, 'usr_d4e5f6': { seats: null } });
  const merged = p.keys['{token}'];
  assert.equal(merged.type, 'object');
  assert.ok(merged.keys.seats, 'the merged profile still describes the shared field');
});

test('no identifier survives into the stored profile', () => {
  const leaky = {
    'alice@example.com': { role: 'admin' },
    '550e8400-e29b-41d4-a716-446655440000': { role: 'member' },
    'acct_1H2xKLmnOPqr': { role: 'billing' },
  };
  const serialized = JSON.stringify(profileValue(leaky));
  for (const secret of ['alice@example.com', '550e8400', 'acct_1H2xKLmnOPqr']) {
    assert.ok(!serialized.includes(secret), `${secret} must not reach the profile`);
  }
});

/**
 * A record keeps behaving exactly as before. This is the regression guard: the
 * fix must be invisible to every response that was already profiled correctly.
 */
test('a record profiles identically to before the change', () => {
  const record = { id: 'x', name: 'y', created_at: '2026-07-26', seats: 3, active: true };
  const p = profileValue(record);
  assert.deepEqual(
    Object.keys(p.keys).sort(),
    ['active', 'created_at', 'id', 'name', 'seats'],
    'every field name survives',
  );
  assert.equal(p.key_count, 5);
});

/**
 * A date-keyed series is the clearest map case after identifiers: it churns
 * daily, so before the fix it drifted daily.
 */
test('a date-keyed series is one contract, not one per day', () => {
  const week1 = { '2026-07-01': { hits: 10 }, '2026-07-02': { hits: 20 } };
  const week2 = { '2026-07-08': { hits: 30 } };
  assert.equal(identity(week1), identity(week2));
});
