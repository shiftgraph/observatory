// The published package vendors a copy of the profiler, and a copy can rot.
//
// `@shiftgraph/generate` has to be dependency-free and installable by a
// stranger, so it carries `core/{utils,url,shape}.js` rather than importing
// them from this repository. That is the same trade the SDK makes against the
// engine, and the SDK's mirror test is the only reason its copy has stayed
// correct through three identity changes this week.
//
// The failure this prevents is quiet: the vendored profiler drifts, the
// published tool starts emitting types that disagree with our own record, and
// nothing anywhere fails. Someone finds out when a generated type is wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const canonical = (f) => path.resolve(import.meta.dirname, '../packages/core', f);
const vendored = (f) => path.resolve(import.meta.dirname, '../packages/generate/core', f);

for (const file of ['utils.js', 'url.js', 'shape.js']) {
  test(`the vendored ${file} is identical to the canonical one`, () => {
    const a = readFileSync(canonical(file), 'utf8');
    const b = readFileSync(vendored(file), 'utf8');
    assert.equal(
      b,
      a,
      `packages/generate/core/${file} has drifted from packages/core/${file}. ` +
        `Re-copy it rather than editing the vendored copy: the published tool must ` +
        `profile exactly the way our own record does, or its types describe a ` +
        `contract nobody observed.`,
    );
  });
}

/**
 * Byte equality is the strong check, but it fails uninformatively if someone
 * reformats. This pins the mechanisms by name so a failure says WHICH one went
 * missing, which is what the SDK mirror test learned to do.
 */
test('the vendored profiler carries every mechanism the canonical one does', () => {
  const b = readFileSync(vendored('shape.js'), 'utf8');
  const mechanisms = [
    ['wildcard absorption', 'const informative = profiles.filter'],
    ['presence tiers', 'childProfiles.length < informative.length'],
    ['optional carry-through', 'optional: true'],
    ['map detection', "'{key}': profiled[names[0]]"],
    ['numeric-key exclusion', 'test(n) && !/^\\d+$/.test(n)'],
    ['series memory', 'export function carryOptionality'],
    ['map-vs-record guard', "('{key}' in bk) !== ('{key}' in ak)"],
  ];
  for (const [name, needle] of mechanisms) {
    assert.ok(b.includes(needle), `the vendored profiler is missing: ${name}`);
  }
});

/** The package must stay installable by someone who has nothing else. */
test('the vendored profiler pulls in no third-party dependency', () => {
  for (const file of ['utils.js', 'url.js', 'shape.js']) {
    const src = readFileSync(vendored(file), 'utf8');
    const imports = [...src.matchAll(/^import .*? from ['"](.+?)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('./') || spec.startsWith('node:'),
        `${file} imports "${spec}", which a published package cannot resolve`,
      );
    }
  }
});
