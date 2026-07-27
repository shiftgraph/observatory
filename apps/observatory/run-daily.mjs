#!/usr/bin/env node
// Unattended daily observatory run, for Windows Task Scheduler (or cron).
// Self-healing: seeds the baseline on first run, then polls + compares each run and
// appends a one-line summary to data/observatory/history.ndjson. Resolves all paths
// from its own location, so it works regardless of the launcher's working directory.
//
// DRIFT MODEL (honest crack-rig): each run compares TODAY against the PRIOR run's
// baseline, then rolls the baseline FORWARD to today. So a real contract change is
// detected once, on the day it happens (that is the lead time), counted once in the
// history, and then becomes the new normal - never re-flagged every run forever. A
// frozen day-0 baseline would re-report every persistent change daily and inflate the
// number; day-over-day comparison is what an early-warning network actually does.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINTS } from './registry.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const node = process.execPath;
const rel = (...p) => path.join('data', 'observatory', ...p);
const abs = (...p) => path.join(repo, ...p);
const run = (args) => execFileSync(node, args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const cli = path.join('apps', 'observatory', 'record.mjs');

function stamp() { return new Date().toISOString(); }

/**
 * A short, stable digest of the watched endpoint set. Same endpoints in a
 * different order give the same value; add, remove or swap one and it changes,
 * which is the point: the day the fingerprint moves is the day the series stops
 * being comparable to the days before it.
 */
function registryFingerprint() {
  const ids = ENDPOINTS.map(e => e.id).sort().join('\n');
  return `${ENDPOINTS.length}:${createHash('sha256').update(ids).digest('hex').slice(0, 12)}`;
}

try {
  run([path.join('apps', 'observatory', 'poll.js')]);
  if (!existsSync(abs(rel('baseline.json.gz')))) {
    run([cli, 'baseline', rel('latest.ndjson'), '--format', 'otel-json', '--out', rel('baseline.json.gz')]);
  }
  run([cli, 'compare', rel('baseline.json.gz'), rel('latest.ndjson'), '--format', 'otel-json', '--out', rel('drift.json')]);

  const drift = JSON.parse(readFileSync(abs(rel('drift.json')), 'utf8'));
  const summary = JSON.parse(readFileSync(abs(rel('run-summary.json')), 'utf8'));

  // Record WHICH endpoints were watched, not just how many. A rate computed
  // across a series whose population silently changed is comparing different
  // things: the breadth pass took this registry from 63 endpoints to 179, and
  // without a marker in the record a later reader would have averaged the two
  // halves together and called the result a trend. The count alone is not
  // enough either, since an equal-sized swap leaves it unmoved, so the line
  // carries a fingerprint of the actual endpoint set.
  // `shaped` is the number that matters most: an endpoint reached but yielding
  // no parseable body contributes nothing to a contract profile, and ten of the
  // original sixty-three had been doing exactly that, uncounted, for eighteen
  // sweeps.
  const line = {
    at: summary.finished_at || stamp(),
    endpoints: summary.total,
    ok: summary.ok,
    failed: summary.failed,
    shaped: summary.body_captured,
    shapeless: (summary.shapeless || []).length,
    registry_fingerprint: registryFingerprint(),
    drift_events: drift.drift_event_count,
    new_ops: drift.new_operation_count,
    drift: (drift.drift_events || []).map(e => ({ op: e.operation, type: e.transition_type, severity: e.severity }))
  };
  appendFileSync(abs(rel('history.ndjson')), JSON.stringify(line) + '\n');

  // Roll the baseline forward: today becomes the new normal, so a change caught this
  // run is not re-reported on every subsequent run. Real drift is counted exactly once.
  run([cli, 'baseline', rel('latest.ndjson'), '--format', 'otel-json', '--out', rel('baseline.json.gz')]);

  // Regenerate the publishable figures. Anything outside this repository that
  // states a number should read that file rather than counting rows itself:
  // the record carries profiler-boundary markers, and a sum that runs through
  // one mixes our own corrected arithmetic in with observations of providers.
  run([path.join('apps', 'observatory', 'published.mjs')]);

  // Republish the machine-readable contract record. This is what an agent
  // consults through `@shiftgraph/mcp`, and it is regenerated from the folded
  // series rather than from the rolled baseline, so its observation counts are
  // cumulative rather than describing the last roll.
  run([path.join('apps', 'observatory', 'contracts-index.mjs')]);

  console.log('observatory daily run OK:', JSON.stringify({ ok: line.ok, failed: line.failed, drift_events: line.drift_events }));
} catch (err) {
  appendFileSync(abs(rel('history.ndjson')), JSON.stringify({ at: stamp(), error: String(err.stderr || err.message || err).slice(0, 300) }) + '\n');
  console.error('observatory daily run FAILED:', err.message);
  process.exitCode = 1;
}
