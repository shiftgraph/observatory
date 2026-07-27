#!/usr/bin/env node
// The daily MCP contract sweep, and the ledger it writes.
//
// This is the measurement Plan v2 Phase 0 exists to produce: how often do tool
// contracts actually change? Every run polls, compares against yesterday's
// baseline, appends one row to a permanent ledger, and rolls the baseline
// forward so each change is counted exactly once.
//
// The ledger is the point. A number nobody wrote down is a number nobody can be
// held to, and this one decides whether the paid change-detection layer is worth
// selling. Pre-committed reading, from the plan:
//
//   tool contracts moving weekly            -> the paid layer is real
//   roughly one change per tool per quarter -> the frequency argument fails a
//                                              second time and we stop
//
// Run it daily:  node apps/observatory/mcp-daily.mjs
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeLedger } from './ledger-rate.mjs';

/**
 * This runs unattended under Task Scheduler as well as from a shell, and a
 * scheduled task inherits neither PATH nor a working directory from the session
 * that registered it. Bare `node` resolved fine interactively and died at
 * 0xC000013A under the scheduler, AFTER the poll had already succeeded, so the
 * sweep observed 72 tools and then wrote nothing at all.
 *
 * A job that fails only when nobody is watching is the worst shape a
 * measurement can have, so both halves are pinned: every child is spawned with
 * the absolute interpreter path (`process.execPath`), and the process moves
 * itself to the repository root before touching a relative path.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const DIR = path.join(REPO_ROOT, 'data', 'observatory-mcp');
const LEDGER = path.join(DIR, 'contract-ledger.json');
const BASELINE = path.join(DIR, 'baseline.json');
const LATEST = path.join(DIR, 'latest.ndjson');

function run(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};

async function main() {
  const startedAt = new Date().toISOString();
  const day = startedAt.slice(0, 10);

  // 1. Observe.
  const poll = await run(process.execPath, ['apps/observatory/mcp-poll.js']);
  if (poll.code !== 0) {
    console.error('poll failed:\n' + poll.out);
    process.exitCode = 1;
    return;
  }
  const runSummary = await readJson(path.join(DIR, 'run-summary.json'), {});

  // A sweep that reached nothing is a broken sweep, not a quiet day. Recording
  // it as a normal row would put zeros into the ledger and pull the measured
  // rate toward zero using days on which we observed nothing at all, which is
  // the precise failure this product exists to catch: an instrument reporting
  // calm because it went blind. Refuse the row and exit loudly.
  if ((runSummary.servers_ok ?? 0) === 0) {
    console.error(
      `\nSWEEP FAILED: no server was reachable, so nothing was observed.\n` +
        `Nothing was written to the ledger, deliberately: a zero here is absence of ` +
        `observation, not absence of change.\n` +
        `First failures: ${(runSummary.failures || []).slice(0, 3).map((f) => `${f.id} (${f.reason})`).join('; ') || 'none recorded'}`,
    );
    process.exitCode = 1;
    return;
  }

  // 2. Compare against the last sweep, if there is one. The first run only
  //    establishes the baseline; there is nothing yet to compare against.
  const hadBaseline = (await readJson(BASELINE)) !== null;
  let drift = { drift_event_count: 0, new_operation_count: 0, drift_events: [] };
  if (hadBaseline) {
    const cmp = await run(process.execPath, [
      'apps/observatory/record.mjs', 'compare', BASELINE, LATEST,
      '--format', 'otel-json', '--out', path.join(DIR, 'drift.json'),
    ]);
    if (cmp.code !== 0) console.error('compare reported a problem:\n' + cmp.out);
    drift = (await readJson(path.join(DIR, 'drift.json'), drift)) ?? drift;
  }

  // 3. Append to the ledger, then roll the baseline forward so a change that
  //    persists is not re-counted every day for the rest of its life.
  const ledger = await readJson(LEDGER, {
    schema_version: 'shiftgraph.mcp.contract-ledger.v1',
    started_on: day,
    note:
      'One row per sweep, not per day: a day swept twice has two rows, and a day ' +
      'missed has none. Rates are computed from the elapsed span, never the row count. ' +
      'Drift is counted once, on the sweep it first appears.',
    days: [],
  });
  ledger.days.push({
    day,
    at: startedAt,
    servers_reachable: runSummary.servers_ok ?? 0,
    servers_unreachable: runSummary.servers_failed ?? 0,
    tools_observed: runSummary.tools_total ?? 0,
    contract_changes: hadBaseline ? drift.drift_event_count : null,
    new_tools: hadBaseline ? drift.new_operation_count : null,
    changes: (drift.drift_events || []).map((e) => ({
      tool: e.operation,
      type: e.transition_type,
      severity: e.severity,
      explanation: e.explanation,
    })),
  });
  await fs.writeFile(LEDGER, JSON.stringify(ledger, null, 2), 'utf8');

  const roll = await run(process.execPath, [
    'apps/observatory/record.mjs', 'baseline', LATEST,
    '--format', 'otel-json', '--out', BASELINE,
  ]);
  if (roll.code !== 0) console.error('baseline roll-forward failed:\n' + roll.out);

  // 4. Report what the ledger now says. The arithmetic lives in ledger-rate.mjs
  //    because it is the part that makes the go/no-go call, and it has to be
  //    testable without spawning twenty servers to reach it.
  const summary = summarizeLedger(ledger, {
    tools: runSummary.tools_total ?? 0,
    serversOk: runSummary.servers_ok ?? 0,
    now: startedAt,
  });

  console.log(`\n=== MCP contract ledger, ${summary.sweeps} sweep(s) since ${ledger.started_on} ===`);
  for (const line of summary.lines) console.log(line);

  if (drift.drift_event_count > 0) {
    console.log('\n  today:');
    for (const e of drift.drift_events.slice(0, 10)) console.log(`    [${e.severity}] ${e.operation}: ${e.explanation}`);
  }
  console.log(`\n  ledger: ${LEDGER}`);
}

main().catch((err) => {
  console.error(`mcp-daily failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
