/**
 * A fixture has to be the shape it claims, or it is worse than none.
 *
 * The point of generating one is that a test suite asserts against the
 * contract rather than against whatever happened to be in one captured
 * response. That only holds if the fixture actually conforms to the profile it
 * was built from, so this round-trips it: build a fixture, profile the
 * fixture, and require the result to match.
 *
 * A round trip is a stronger check than compiling the emitted TypeScript would
 * be. Compiling proves the fixture matches the TEXT we emitted; round-tripping
 * proves it matches the RECORD, and the text is derived from the record too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileValue, structuralProfile } from '../packages/core/shape.js';
import { fixtureValue, generateFixture, countFields } from '../packages/generate/index.js';

const obj = (keys) => ({ type: 'object', keys });

/** Every leaf path in a profile, so two profiles can be compared by shape. */
function paths(node, at = '$', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'object') {
    for (const k of Object.keys(node.keys || {})) paths(node.keys[k], `${at}.${k}`, out);
  } else if (node.type === 'array') {
    paths(node.element, `${at}[]`, out);
  } else {
    out.push(`${at}:${node.type}`);
  }
  return out;
}

test('a fixture round-trips to the profile it was built from', () => {
  // `number`, not `integer`. profileValue never emits `integer` for any numeric
  // value, so a test written against `integer` compares the fixture to a
  // vocabulary the record does not use and fails for the wrong reason. The
  // first version of this did exactly that.
  const profile = obj({
    id: { type: 'string' },
    count: { type: 'number' },
    ok: { type: 'boolean' },
    nested: obj({ deep: { type: 'string' } }),
    list: { type: 'array', element: obj({ a: { type: 'number' } }) },
  });

  const round = structuralProfile(profileValue(fixtureValue(profile)));
  assert.deepEqual(paths(round).sort(), paths(profile).sort());
});

test('optional fields are PRESENT in the fixture', () => {
  // A fixture is the shape a consumer must handle. Omitting the optional half
  // lets a test pass against a response the interface is entitled to send,
  // which is the exact failure a generated fixture exists to prevent.
  const profile = obj({
    always: { type: 'string' },
    sometimes: { type: 'string', optional: true },
  });
  const value = fixtureValue(profile);
  assert.ok('sometimes' in value, 'an optional field must still appear');
  assert.equal(typeof value.sometimes, 'string');
});

test('an array gets exactly one element, never zero', () => {
  // Zero elements means a consumer that maps over the array runs its body
  // never, and the test asserts nothing about the element shape.
  const value = fixtureValue({ type: 'array', element: obj({ a: { type: 'string' } }) });
  assert.equal(value.length, 1);
  assert.equal(typeof value[0].a, 'string');
});

test('a data-keyed map gets a real key, not the placeholder', () => {
  // `{key}` is how the profiler records "keyed by data". It is not a key any
  // response carries, and emitting it literally would put a string no server
  // would ever send into a test fixture.
  const value = fixtureValue(obj({ '{key}': obj({ v: { type: 'number' } }) }));
  assert.deepEqual(Object.keys(value), ['key']);
  assert.equal(value.key.v, 0);
});

test('no value in a fixture comes from a real response', () => {
  // The record holds no values, so a fixture cannot leak one. Pinned because
  // the day someone builds a fixture from a captured body instead, a
  // customer's data enters a test suite and nothing here would notice.
  const profile = obj({ email: { type: 'string' }, balance: { type: 'number' } });
  const value = fixtureValue(profile);
  assert.equal(value.email, 'string');
  assert.equal(value.balance, 0);
});

test('the emitted module imports the type and annotates the value', () => {
  const profile = obj({ id: { type: 'string' } });
  const out = generateFixture({
    name: 'github-repo',
    profile,
    source: 'GET https://example.test/x',
    observations: 4,
    observedFrom: '2026-07-24',
    observedTo: '2026-07-27',
    command: 'npx @shiftgraph/generate https://example.test/x',
    typeModule: './github-repo',
  });

  // Annotated on purpose: an untyped fixture drifts from the type beside it in
  // silence, which is this product's own failure mode one level in.
  assert.match(out, /import type \{ GithubRepo \} from '\.\/github-repo';/);
  assert.match(out, /export const githubRepoFixture: GithubRepo = \{/);
  assert.match(out, /observations  : 4/);
  assert.match(out, /Values are placeholders/);
});

test('a deep structure terminates rather than recursing forever', () => {
  let deep = { type: 'string' };
  for (let i = 0; i < 40; i += 1) deep = obj({ n: deep });
  const value = fixtureValue(deep);
  assert.ok(value, 'must produce something rather than blowing the stack');
});

test('every leaf in the profile has a value in the fixture', () => {
  const profile = obj({
    a: { type: 'string' },
    b: obj({ c: { type: 'number' }, d: { type: 'boolean', optional: true } }),
  });
  const value = fixtureValue(profile);
  // Compared leaf by leaf rather than against countFields, which counts
  // containers as fields too. Asserting against a total meant guessing at an
  // off-by-one instead of checking the thing that matters.
  assert.deepEqual(
    paths(structuralProfile(profileValue(value))).sort(),
    paths(profile).sort(),
  );
  void countFields;
});
