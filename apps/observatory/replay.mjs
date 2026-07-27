#!/usr/bin/env node
// Replay the retained captures through the REAL pipeline and count what the
// instrument would have reported.
//
// The earlier throwaway replay compared consecutive captures directly, which is
// not what production does and overstated the count sixfold: production rolls a
// baseline forward, and a rolled baseline carries optionality (mechanism 2b).
// Measuring against a path the product does not take produces a number nobody
// can act on, so this simulates the actual sequence:
//
//   day 1  -> baseline
//   day N  -> structuralDiff(baseline, observation), then roll the baseline
//             forward THROUGH carryOptionality
//
// Definition of done for Lane A is that this reports zero ARTIFACTS. Not zero
// events: a true observation is allowed to appear, and the difference is
// adjudicated by reading each one rather than by netting them out.
//
//   node apps/observatory/replay.mjs
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileValue, structuralProfile, structuralDiff, carryOptionality } from '../../packages/core/shape.js';
import { readStoredSync, CAPTURE_FILE } from './capture-io.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(REPO_ROOT, 'data', 'observatory');

const files = readdirSync(DIR)
  .filter((f) => f.startsWith('capture-') && CAPTURE_FILE.test(f))
  .filter((f) => statSync(path.join(DIR, f)).size > 1000)
  .sort();

// endpoint -> ordered list of observed bodies
const series = new Map();
for (const f of files) {
  for (const line of readStoredSync(path.join(DIR, f)).trim().split('\n')) {
    const span = JSON.parse(line);
    const id = span.resource?.endpoint_id;
    const raw = span.attributes?.['shiftgraph.response.body'];
    if (!id || !raw) continue;
    if (!series.has(id)) series.set(id, []);
    series.get(id).push({ day: f.slice(8, 27), body: JSON.parse(raw) });
  }
}

let comparisons = 0;
let events = 0;
const found = [];

for (const [id, seq] of series) {
  if (seq.length < 2) continue;
  // Day one establishes the baseline; nothing to compare against yet.
  let baseline = structuralProfile(profileValue(seq[0].body));
  for (let i = 1; i < seq.length; i++) {
    const observed = structuralProfile(profileValue(seq[i].body));
    comparisons++;
    const diffs = structuralDiff(baseline, observed);
    if (diffs.length) {
      events++;
      found.push({ id, day: seq[i].day, diffs });
    }
    // Roll forward exactly as production does.
    baseline = carryOptionality(baseline, observed);
  }
}

console.log('='.repeat(72));
console.log('  REPLAY THROUGH THE REAL PIPELINE (rolled baseline + series memory)');
console.log('='.repeat(72));
console.log();
console.log(`  captures replayed   : ${files.length}`);
console.log(`  endpoints with >1   : ${[...series.values()].filter((s) => s.length > 1).length}`);
console.log(`  comparisons made    : ${comparisons}`);
console.log(`  events reported     : ${events}`);
console.log();

if (!found.length) {
  console.log('  Zero events. Every remaining difference across the retained window is');
  console.log('  classified as data rather than contract.');
} else {
  console.log('  EVERY EVENT, FOR INDIVIDUAL ADJUDICATION:');
  console.log();
  for (const e of found) {
    console.log(`  ${e.id}  (${e.day})`);
    for (const d of e.diffs.slice(0, 6)) {
      console.log(`      ${d.breaking ? 'BREAKING' : 'additive'}  ${d.type}  ${d.path}`);
    }
    if (e.diffs.length > 6) console.log(`      ... and ${e.diffs.length - 6} more`);
    console.log();
  }
  console.log('  These are not netted against anything. An event here is either a real');
  console.log('  catch or an artifact, and which one it is comes from reading it.');
}
console.log();
