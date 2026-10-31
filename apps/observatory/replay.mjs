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
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileValue, structuralProfile, structuralDiff, carryOptionality } from '../../packages/core/shape.js';
import { readStoredSync, CAPTURE_FILE, contractBearingSpan } from './capture-io.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(REPO_ROOT, 'data', 'observatory');

/**
 * The profiler boundary, read from the same place `published.mjs` reads it.
 *
 * That file's header says: "I did exactly that while reading this file and got
 * six drift events where the instrument reports one. The marker was there and
 * the sum ignored it, which is what a marker read only by humans is worth."
 * This file was the other reader that ignored it. It filtered on filename and
 * size and nothing else, so it replayed captures from before the profiler was
 * corrected - comparing a post-correction observation against a baseline built
 * by the old code, which is our own arithmetic rather than a provider's change,
 * and is exactly what the standing rule "rebuild the baseline after any
 * profiler change" exists to prevent.
 *
 * The visible cost: this printed a `status-openai` event dated inside the last
 * pre-boundary capture while `published.json` reported one drift event that was
 * a different provider entirely. Two numbers, both called one, describing two
 * different things.
 */
function boundaryFilenamePrefix() {
  const historyPath = path.join(DIR, 'history.ndjson');
  if (!existsSync(historyPath)) return '';
  const rows = readFileSync(historyPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let at = null;
  for (const r of rows) if (r.marker === 'profiler-boundary') at = r.at;
  // Capture filenames replace `:` and `.` with `-`, so an ISO instant converts
  // directly and string order stays chronological (both are zero-padded).
  return at ? at.replace(/[:.]/g, '-') : '';
}

const BOUNDARY = boundaryFilenamePrefix();

const files = readdirSync(DIR)
  .filter((f) => f.startsWith('capture-') && CAPTURE_FILE.test(f))
  .filter((f) => statSync(path.join(DIR, f)).size > 1000)
  .filter((f) => f.slice('capture-'.length) >= BOUNDARY)
  .sort();

// endpoint -> its replay so far, advanced one observation at a time.
//
// This used to collect every observed body of every endpoint before replaying
// any of them, which kept the whole retained record resident at once and grew
// with every sweep; the contracts index, which walks the same files the same
// way, ran out of the runner's 4 GB on 2026-10-31 and this was next in line.
// Each body is now compared and rolled into its endpoint's baseline as it is
// read, in the same order as before, so every comparison, event and line of
// output is the one the buffered replay produced. An endpoint's first body
// waits, unprofiled, for a second one: the buffered replay never profiled an
// endpoint observed only once, and neither does this.
let comparisons = 0;
let events = 0;
const runs = new Map();
for (const f of files) {
  for (const line of readStoredSync(path.join(DIR, f)).trim().split('\n')) {
    const span = JSON.parse(line);
    const id = span.resource?.endpoint_id;
    const raw = span.attributes?.['shiftgraph.response.body'];
    // A failure is not a contract (capture-io: contractBearingSpan).
    if (!id || !raw || !contractBearingSpan(span)) continue;
    const body = JSON.parse(raw);
    const run = runs.get(id);
    if (!run) {
      // Day one establishes the baseline; nothing to compare against yet.
      runs.set(id, { observations: 1, first: body, baseline: null, found: [] });
      continue;
    }
    if (run.observations === 1) {
      run.baseline = structuralProfile(profileValue(run.first));
      run.first = null;
    }
    run.observations += 1;
    const observed = structuralProfile(profileValue(body));
    comparisons++;
    const diffs = structuralDiff(run.baseline, observed);
    if (diffs.length) {
      events++;
      run.found.push({ id, day: f.slice(8, 27), diffs });
    }
    // Roll forward exactly as production does.
    run.baseline = carryOptionality(run.baseline, observed);
  }
}

// Grouped by endpoint in the order each was first seen, oldest first within
// one, which is the order the buffered replay printed them in.
const found = [...runs.values()].flatMap((run) => run.found);

console.log('='.repeat(72));
console.log('  REPLAY THROUGH THE REAL PIPELINE (rolled baseline + series memory)');
console.log('='.repeat(72));
console.log();
console.log(`  captures replayed   : ${files.length}  (after the profiler boundary)`);
console.log(`  endpoints with >1   : ${[...runs.values()].filter((run) => run.observations > 1).length}`);
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
