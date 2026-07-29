#!/usr/bin/env node
/**
 * The figures that may be published, computed from the record rather than
 * written by hand.
 *
 * This exists because of a specific failure. The public page carried numbers
 * that someone typed once and that then drifted from the record behind them,
 * and correcting it publicly cost more than the numbers were ever worth.
 * Nothing here is typed: every value is derived, so the page cannot say
 * something the record does not.
 *
 * THE BOUNDARY IS THE WHOLE POINT. `history.ndjson` carries marker rows with
 * `marker: "profiler-boundary"`. A drift row before one of them was computed
 * by a profiler we have since corrected, or against a baseline built by one,
 * so it describes our own arithmetic rather than a provider. Summing the file
 * end to end silently mixes the two, and the result looks like evidence.
 *
 * I did exactly that while reading this file and got six drift events where
 * the instrument reports one. The marker was there and the sum ignored it,
 * which is what a marker read only by humans is worth.
 *
 *   node apps/observatory/published.mjs        writes data/observatory/published.json
 *   node apps/observatory/published.mjs --show prints it
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINTS, REGISTRY_META } from './registry.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(REPO_ROOT, 'data', 'observatory');

/**
 * Splits the record at the last profiler boundary and returns only what came
 * after it. Rows recording a failed run are kept out of the totals and counted
 * separately, because "we swept and saw nothing" and "the sweep failed" are
 * different facts and averaging them produces neither.
 */
export function publishable(lines) {
  const rows = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  let lastBoundary = -1;
  rows.forEach((r, i) => {
    if (r.marker === 'profiler-boundary') lastBoundary = i;
  });

  /**
   * Retracted drift claims, named by the sweep that made them.
   *
   * A profiler-boundary discards everything before it, which is right when the
   * profiler itself changed but far too blunt for one bad sweep: it would throw
   * away ten good ones to disown six claims. So a retraction marker names the
   * sweeps whose DRIFT is disowned while leaving the sweep itself counted - it
   * genuinely happened and genuinely reached its endpoints.
   *
   * Append-only, deliberately. The wrong claims stay in the file where anyone
   * can see what was said and when; what changes is that the published record
   * stops repeating them. Correcting by deletion would leave no evidence the
   * correction happened, which is the failure this whole record exists to avoid.
   */
  const retracted = new Set(
    rows.filter((r) => r.marker === 'drift-retraction').flatMap((r) => r.retracts ?? []),
  );

  const after = rows.slice(lastBoundary + 1);
  const sweeps = after.filter((r) => !r.error && !r.marker && typeof r.ok === 'number');
  const failed = after.filter((r) => r.error).length;

  const sum = (k) =>
    sweeps.reduce((s, r) => {
      if (k === 'drift_events' && retracted.has(r.at)) return s;
      return s + (r[k] || 0);
    }, 0);

  return {
    /** Every value below covers only sweeps after this instant. */
    since: rows[lastBoundary]?.at ?? sweeps[0]?.at ?? null,
    sweeps: sweeps.length,
    failed_runs: failed,
    endpoints_reached: sum('ok'),
    endpoints_profiled: sum('shaped'),
    drift_events: sum('drift_events'),
    /** What the most recent sweep saw, for a page that wants one moment. */
    latest: sweeps.length
      ? {
          at: sweeps[sweeps.length - 1].at,
          reached: sweeps[sweeps.length - 1].ok,
          profiled: sweeps[sweeps.length - 1].shaped,
          unprofilable: sweeps[sweeps.length - 1].shapeless ?? 0,
        }
      : null,
    /**
     * Withheld until the record can support a claim. One sweep is a snapshot,
     * not a finding about how often interfaces move, and a page that prints a
     * rate from it invites a reader to check and find nothing behind it.
     */
    publishable: sweeps.length >= MIN_SWEEPS_TO_PUBLISH,
    minimum_sweeps: MIN_SWEEPS_TO_PUBLISH,
  };
}

/**
 * A week of six-hourly observation. Below this the honest thing for the page
 * to say is that observation is under way, not a number.
 */
export const MIN_SWEEPS_TO_PUBLISH = 28;

function main() {
  const history = readFileSync(path.join(DIR, 'history.ndjson'), 'utf8').split('\n');
  const record = publishable(history);

  const out = {
    generated_at: new Date().toISOString(),
    watching: {
      endpoints: ENDPOINTS.length,
      providers: REGISTRY_META.providers,
      categories: REGISTRY_META.categories,
    },
    captures_retained: readdirSync(DIR).filter((f) => f.startsWith('capture-')).length,
    record,
  };

  if (process.argv.includes('--show')) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  writeFileSync(path.join(DIR, 'published.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `published.json: ${record.sweeps} sweeps since ${record.since}, ` +
      `${record.drift_events} drift, publishable=${record.publishable}`,
  );
}

if (import.meta.url === `file://${process.argv[1]?.split(path.sep).join('/')}` ||
    process.argv[1]?.endsWith('published.mjs')) {
  main();
}
