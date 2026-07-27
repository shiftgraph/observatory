#!/usr/bin/env node
// SHIFTGRAPH public API observatory - poller (Track A).
//
// Polls the curated public endpoints once, measures status + latency, captures
// the JSON response SHAPE (values are stripped later by the engine's edge
// redaction), and emits an OpenTelemetry NDJSON capture that flows straight
// through the existing SHIFTGRAPH audit pipeline (no new detection code).
//
// A single run is a PROFILE / baseline (a snapshot). Drift accrues when this is
// re-run on a schedule and compared against the saved baseline:
//   node apps/observatory/poll.js
//   node apps/observatory/record.mjs baseline data/observatory/latest.ndjson --format otel-json --out data/observatory/baseline.json.gz   (first time)
//   node apps/observatory/record.mjs compare  data/observatory/baseline.json.gz data/observatory/latest.ndjson --format otel-json         (later runs)
//
// White-hat: identifies itself via User-Agent, spaces requests, only touches
// public endpoints, and never sends credentials.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ENDPOINTS, REGISTRY_META } from './registry.js';
import { gzip, CAPTURE_FILE } from './capture-io.mjs';

// Identify honestly. A polled host's operator should be able to tell who we are
// and reach us; that is the whole basis on which unauthenticated polling is
// acceptable. The contact is configurable so the deployed identity is a
// deliberate choice rather than something hardcoded here by accident.
const CONTACT = process.env.OBSERVATORY_CONTACT || 'research; polite; contact: local';
const UA = `shiftgraph-observatory/0.4 (${CONTACT})`;
const TIMEOUT_MS = 15000;
const DELAY_MS = 200;          // polite spacing between requests
/**
 * Body-size cap, raised from 200kb after the shapeless report showed what it
 * was quietly costing.
 *
 * Ten of the original sixty-three endpoints had never produced a profile at
 * all, and five of those were over the old cap: npm's react packument, crates'
 * serde, PyPI's django, npm's express, pokeapi. The npm packument is the single
 * most on-thesis surface the observatory watches, and it had been counted as an
 * observed endpoint for eighteen sweeps while contributing nothing. "Zero drift
 * across sixty-three endpoints" was really zero drift across fifty-three.
 *
 * One megabyte captures every one of them except the react packument at 6.7mb,
 * which stays out on purpose: it is mostly a thousand-entry version map whose
 * contract is better read from `react/latest`, and that endpoint was added in
 * the same pass. Anything still excluded now says so in the run summary rather
 * than vanishing.
 */
const MAX_BODY_BYTES = 1_000_000;
/**
 * NEVER DELETED. `null` means keep everything, forever.
 *
 * Raw captures are the one asset here that cannot be re-observed. A profile is
 * a function computed over a stored response, so a defect in the function is
 * fixable by re-running it, which is how every profiling correction was
 * measured against identical inputs. That property holds only while the
 * responses exist.
 *
 * Two settings destroyed data before this one, and both solved a problem that
 * did not exist:
 *
 *   Seven days, chosen for disk reasons and never recognised as a decision
 *   about the core asset, cost sixteen days of raw responses.
 *
 *   Ninety, which replaced it, counted FILES rather than days. One sweep a day
 *   makes those look identical and they are not: four sweeps ran on 26 July
 *   during development, so the window collapsed fastest exactly when the work
 *   was heaviest. A count standing in for a duration, which is the same defect
 *   as the ledger rate dividing by rows and calling them days.
 *
 * There was never disk pressure. Captures are compressed, which puts a sweep
 * at roughly 1.2 MB and a year of four-a-day at roughly 1.7 GB.
 *
 * If a real constraint ever appears, set this to a number of DAYS and know
 * that you are trading the one asset we claim cannot be bought. It only ever
 * goes up.
 */
const KEEP_CAPTURE_DAYS = null;
const OUT_DIR = path.join('data', 'observatory');

/**
 * Round-robin the sweep across hosts so consecutive requests land on different
 * servers.
 *
 * The registry is grouped by provider for humans to read, which meant seventeen
 * consecutive api.github.com calls spaced 200ms apart: a five-per-second burst
 * at one host, which is what secondary rate limiters exist to stop, while the
 * other hundred and thirty hosts sat idle. Interleaving costs nothing in total
 * runtime and reduces the per-host rate to roughly one request per sweep-length.
 */
function interleaveByHost(endpoints) {
  const byHost = new Map();
  for (const ep of endpoints) {
    let host;
    try { host = new URL(ep.url).hostname; } catch { host = ep.url; }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(ep);
  }
  const queues = [...byHost.values()];
  const out = [];
  for (let more = true; more; ) {
    more = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) { out.push(next); more = true; }
    }
  }
  return out;
}

function nowNs() { return (BigInt(Date.now()) * 1000000n).toString(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollOne(ep) {
  const startNs = nowNs();
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const attrs = { 'http.request.method': ep.method || 'GET', 'url.full': ep.url };
  let status = null, contentType = '', bodyObj, errNote, bodyNote;
  try {
    const res = await fetch(ep.url, {
      method: ep.method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, */*' }
    });
    status = res.status;
    contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    // An endpoint that answers 200 but yields no shape contributes nothing to
    // the profile, and it used to fail that way in silence: a body over the size
    // cap and a body that is not JSON both simply left `bodyObj` undefined. The
    // reason is recorded so dead weight is visible in the run summary and can be
    // fixed or dropped, rather than padding the endpoint count with entries that
    // are never actually compared.
    if (!/json/i.test(contentType)) bodyNote = `non-json (${contentType.split(';')[0] || 'no content-type'})`;
    else if (text.length === 0) bodyNote = 'empty-body';
    else if (text.length >= MAX_BODY_BYTES) bodyNote = `too-large (${Math.round(text.length / 1024)}kb)`;
    else {
      try { bodyObj = JSON.parse(text); } catch { bodyNote = 'json-parse-failed'; }
    }
  } catch (e) {
    errNote = e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message || 'network-error');
  } finally {
    clearTimeout(timer);
  }
  const duration = Date.now() - t0;
  attrs['duration_ms'] = duration;
  if (status !== null) attrs['http.response.status_code'] = status;
  if (contentType) attrs['http.response.header.content-type'] = contentType;
  if (bodyObj !== undefined) attrs['shiftgraph.response.body'] = JSON.stringify(bodyObj);
  const span = {
    name: ep.method || 'GET',
    startTimeUnixNano: startNs,
    attributes: attrs,
    resource: { provider: ep.provider, category: ep.category, endpoint_id: ep.id }
  };
  const ok = status !== null && status < 500 && !errNote;
  return { span, ok, status, duration, errNote, bodyNote, ep };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const order = interleaveByHost(ENDPOINTS);
  console.log(`SHIFTGRAPH observatory: polling ${REGISTRY_META.total} endpoints (${REGISTRY_META.statuspage_count} status pages + ${REGISTRY_META.direct_count} direct APIs across ${REGISTRY_META.distinct_contract_providers} distinct providers)...\n`);
  const lines = [];
  const summary = {
    schema_version: 'shiftgraph.observatory.run.v1',
    started_at: new Date().toISOString(),
    total: ENDPOINTS.length,
    ok: 0,
    failed: 0,
    body_captured: 0,
    by_status: {},
    failures: [],
    /** Reached, but produced no profileable shape. Dead weight until fixed or dropped. */
    shapeless: []
  };
  for (const ep of order) {
    const r = await pollOne(ep);
    lines.push(JSON.stringify(r.span));
    if (r.ok) summary.ok++; else summary.failed++;
    if (r.span.attributes['shiftgraph.response.body']) summary.body_captured++;
    const key = r.status === null ? 'ERR' : String(r.status);
    summary.by_status[key] = (summary.by_status[key] || 0) + 1;
    if (!r.ok) summary.failures.push({ id: r.ep.id, url: r.ep.url, status: r.status, note: r.errNote || null });
    if (r.ok && r.bodyNote) summary.shapeless.push({ id: r.ep.id, url: r.ep.url, reason: r.bodyNote });
    console.log(`  ${(r.status ?? 'ERR').toString().padEnd(4)} ${String(r.duration + 'ms').padEnd(8)} ${r.ep.id}${r.bodyNote ? `  [no shape: ${r.bodyNote}]` : ''}`);
    await sleep(DELAY_MS);
  }
  const body = lines.join('\n') + '\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // The dated capture is written compressed and the working copy is not.
  //
  // The dated file is kept forever, so it is the one whose size compounds: a
  // sweep is about 9 MB of NDJSON and roughly an eighth of that gzipped, which
  // is the difference between a record that stays in one repository for years
  // and one that outgrows it inside a year. `latest.ndjson` is overwritten
  // every sweep rather than accumulating, so compressing it would buy nothing
  // and would make the handoff to the baseline step harder to inspect by hand.
  const capturePath = path.join(OUT_DIR, `capture-${stamp}.ndjson.gz`);
  await fs.writeFile(capturePath, await gzip(Buffer.from(body, 'utf8'), { level: 9 }));
  await fs.writeFile(path.join(OUT_DIR, 'latest.ndjson'), body, 'utf8');
  summary.finished_at = new Date().toISOString();
  summary.capture = capturePath;
  await fs.writeFile(path.join(OUT_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  // Nothing is deleted while KEEP_CAPTURE_DAYS is null, which is the default and
  // should stay that way. Raw responses are the asset; there is no disk pressure
  // to trade them against.
  //
  // The guarded path retires by DATE rather than by file count, because a day
  // with four sweeps writes four files and counting them would prune fastest
  // exactly on the days we work hardest.
  if (KEEP_CAPTURE_DAYS !== null) {
    const cutoff = new Date(Date.now() - KEEP_CAPTURE_DAYS * 86_400_000);
    const captures = (await fs.readdir(OUT_DIR))
      .filter((f) => f.startsWith('capture-') && CAPTURE_FILE.test(f))
      .sort();
    const retired = captures.filter((f) => {
      const stamped = f.match(/(\d{4}-\d{2}-\d{2})/);
      // A file whose date cannot be read is KEPT. Deleting something we failed
      // to understand is the wrong direction for data that cannot be
      // re-observed.
      if (!stamped) return false;
      return new Date(`${stamped[1]}T00:00:00Z`) < cutoff;
    });
    for (const f of retired) await fs.rm(path.join(OUT_DIR, f), { force: true });
    if (retired.length) {
      console.log(`Retired ${retired.length} capture(s) older than ${KEEP_CAPTURE_DAYS} days.`);
    }
  }
  console.log(`\nDone: ${summary.ok} ok / ${summary.failed} failed of ${summary.total}. Bodies captured: ${summary.body_captured}.`);
  console.log(`Status distribution: ${JSON.stringify(summary.by_status)}`);
  if (summary.shapeless.length) {
    console.log(`\nReached but shapeless (${summary.shapeless.length}) - these contribute nothing to the profile:`);
    for (const s of summary.shapeless) console.log(`  ${s.id.padEnd(30)} ${s.reason}`);
  }
  if (summary.failures.length) {
    console.log(`\nUnreachable (${summary.failures.length}):`);
    for (const f of summary.failures) console.log(`  ${f.id.padEnd(30)} ${f.status ?? 'ERR'} ${f.note || ''}`);
  }
  console.log(`Capture: ${capturePath}`);
  console.log(`Latest:  ${path.join(OUT_DIR, 'latest.ndjson')}`);
}

main().catch((err) => {
  console.error(`Observatory poll failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
