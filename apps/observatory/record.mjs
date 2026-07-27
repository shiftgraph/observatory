#!/usr/bin/env node
/**
 * The two operations the observatory performs on a capture: establish a
 * baseline, and compare a new capture against it.
 *
 * This exists because the observatory previously reached these through the
 * full audit CLI, which also carries corpus export, evidence bundling and
 * HTML reporting. None of that is part of observing public interfaces, and a
 * public repository should contain what it runs and nothing else.
 *
 * It is a thin entry point, deliberately: it calls exactly the same
 * `runAudit`, `writeBaseline` and `compareBaseline` with exactly the same
 * arguments the CLI passed. Reimplementing any of that logic would risk
 * losing series memory, which is the mechanism that made the replay honest,
 * and which lives in `writeBaseline`'s `prior` argument rather than anywhere
 * obvious.
 *
 *   node apps/observatory/record.mjs baseline <capture> --out baseline.json
 *   node apps/observatory/record.mjs compare  <baseline> <capture> --out drift.json
 */
import { promises as fs } from 'node:fs';
import { runAudit } from '../../packages/core/audit.js';
import { writeJson, safeParseJson } from '../../packages/core/utils.js';
import { readStored, gzip } from './capture-io.mjs';
import { writeBaseline, compareBaseline } from '../../packages/testgen/baseline.js';

/**
 * Writes the baseline compressed when the target says so.
 *
 * The baseline is about 10 MB and is rewritten on every sweep, so at four
 * sweeps a day an uncompressed one would add roughly 14 GB a year to the
 * repository's history. It compresses to under two percent of that, because it
 * is the same structural vocabulary repeated across a hundred and eighty
 * endpoints.
 *
 * The compression lives here rather than inside `writeBaseline` so the shared
 * engine keeps one behaviour and this repository's storage policy stays this
 * repository's business.
 */
async function writeBaselineTo(report, outPath, prior) {
  if (!outPath.endsWith('.gz')) return writeBaseline(report, outPath, prior);
  const staging = outPath.replace(/\.gz$/, '');
  await writeBaseline(report, staging, prior);
  await fs.writeFile(outPath, await gzip(await fs.readFile(staging), { level: 9 }));
  await fs.rm(staging, { force: true });
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const AUDIT_OPTS = (flags) => ({
  format: flags.format || 'auto',
  redactionMode: flags.redact || 'balanced',
  origin: flags.origin,
  deploymentsPath: flags.deployments,
});

async function baselineCommand(argv) {
  const { positional, flags } = parseArgs(argv);
  if (!positional.length) throw new Error('baseline requires input paths');
  if (!flags.out) throw new Error('baseline requires --out baseline.json');
  const report = await runAudit(positional, AUDIT_OPTS(flags));

  // Series memory. If a baseline already exists at this path, optionality
  // rolls forward from it rather than the history starting over. A baseline
  // that forgets what it has already seen absent reports the same conditional
  // field as a change every time the condition flips, which is one event
  // counted repeatedly rather than vigilance.
  let prior = null;
  try {
    prior = JSON.parse(await readStored(flags.out));
  } catch {
    /* first run: nothing to carry forward */
  }

  await writeBaselineTo(report, flags.out, prior);
  console.log(
    `Baseline written: ${flags.out}${prior ? ' (optionality carried forward)' : ''}`,
  );
  console.log(`${report.operations.length} operations captured.`);
}

async function compareCommand(argv) {
  const { positional, flags } = parseArgs(argv);
  if (positional.length < 2) {
    throw new Error('compare requires baseline.json and at least one input path');
  }
  const parsed = safeParseJson(await readStored(positional[0]), positional[0]);
  if (!parsed.ok) throw new Error(parsed.error);

  const report = await runAudit(positional.slice(1), AUDIT_OPTS(flags));
  const diff = compareBaseline(parsed.value, report);
  if (flags.out) await writeJson(flags.out, diff);
  console.log(
    `Cross-capture drift events: ${diff.drift_event_count} (baseline ${diff.baseline_created_at || 'unknown'} -> now)`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd === 'baseline') return baselineCommand(argv);
  if (cmd === 'compare') return compareCommand(argv);
  throw new Error(
    `Unknown command: ${cmd || '(none)'}. Expected 'baseline' or 'compare'.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
