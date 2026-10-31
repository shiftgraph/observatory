#!/usr/bin/env node
// `generate` — observed record to committed types.
//
//   node apps/observatory/generate.mjs api  <endpoint-id> [--out FILE]
//   node apps/observatory/generate.mjs mcp  <server:tool> [--out FILE]
//   node apps/observatory/generate.mjs list [api|mcp]
//
// Reads the same records the observatory already writes. The API half runs
// against 179 real third-party endpoints captured over weeks; the MCP half runs
// against responses from the invocation harness, which is the only source that
// exists for the roughly two thirds of tools declaring no output schema.
import { promises as fs } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { readStoredSync, CAPTURE_FILE, contractBearingSpan } from './capture-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileValue, structuralProfile, carryOptionality } from '../../packages/core/shape.js';
import { generateModule, countFields } from '../../packages/generate/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HTTP_DIR = path.join(REPO_ROOT, 'data', 'observatory');
const MCP_DIR = path.join(REPO_ROOT, 'data', 'observatory-mcp');

/**
 * Decode a payload that a server encoded as JSON inside a text block.
 *
 * This is not a nicety, it is the difference between a useful type and a
 * useless one. MCP servers overwhelmingly answer with
 * `{content:[{type:"text", text:"<a JSON string>"}]}`, so profiling the
 * envelope alone yields `text: string` — perfectly honest, and it tells an
 * agent nothing about the payload it has to reason over. The contract that
 * matters is one level down, inside a string, where no schema and no
 * declaration ever looks.
 *
 * Only decodes when the text really parses as a JSON object or array. Prose
 * stays prose.
 */
function decodeEmbeddedJson(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.content)) return body;
  let decodedAny = false;
  const content = body.content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const t = block.text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return block;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') {
        decodedAny = true;
        return { ...block, text_decoded: parsed };
      }
    } catch { /* genuinely prose, leave it */ }
    return block;
  });
  return decodedAny ? { ...body, content } : body;
}

/**
 * Hands every observation of every target to `visit(id, day, body)`, oldest
 * first, as it is read, and keeps none of them.
 *
 * This used to return every parsed body of every target in one map. That is
 * memory growing with the record rather than with any one sweep, and on
 * 2026-10-31 the contracts index, walking the same API record the same way,
 * ran out of the 4 GB a GitHub runner's heap allows. `list` read exactly as
 * much, so it was the same failure waiting for the record to grow a little
 * further on whatever machine ran it.
 */
function walkObservations(dir, prefix, visit) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && CAPTURE_FILE.test(f))
    // `*-latest.ndjson` is a copy of the newest dated file. Counting it would
    // double every observation and put "latest.ndj" where a date belongs.
    .filter((f) => !f.includes('latest'))
    .filter((f) => statSync(path.join(dir, f)).size > 200)
    .sort();
  for (const f of files) {
    for (const line of readStoredSync(path.join(dir, f)).trim().split('\n')) {
      if (!line) continue;
      let span;
      try { span = JSON.parse(line); } catch { continue; }
      const id = span.resource?.endpoint_id;
      const raw = span.attributes?.['shiftgraph.response.body'];
      // A failure is not a contract (capture-io: contractBearingSpan).
      if (!id || !raw || !contractBearingSpan(span)) continue;
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      let body;
      try { body = decodeEmbeddedJson(JSON.parse(raw)); } catch { continue; }
      visit(id, m ? m[1] : 'unknown', body);
    }
  }
}

/**
 * Every target's observations folded into one profile per target, carrying
 * optionality forward exactly as the baseline roll does. This is the point:
 * the type is built from everything ever observed, so a field seen absent even
 * once is optional in the emitted type. A single observation would produce a
 * confidently over-narrow type.
 *
 * Each body is folded as it is read, in the order the buffered fold took them,
 * and the profiler and carryOptionality keep no state between calls, so each
 * target ends on the profile it always did.
 *
 * Returns Map<id, { profile, observations, from, to }>.
 */
function foldEach(dir, prefix) {
  const folds = new Map();
  walkObservations(dir, prefix, (id, day, body) => {
    const observed = structuralProfile(profileValue(body));
    const so = folds.get(id);
    if (!so) {
      folds.set(id, { profile: observed, observations: 1, from: day, to: day });
    } else {
      so.profile = carryOptionality(so.profile, observed);
      so.observations += 1;
      so.to = day;
    }
  });
  return folds;
}

/**
 * The observations of several targets folded into ONE profile, in the order the
 * buffered version concatenated them: every observation of the first target,
 * oldest first, then every observation of the next.
 *
 * The first target's observations come first in that order, so they are
 * folded as they are read, exactly as `foldEach` folds a target. A later
 * target's observations arrive interleaved with the first's and have to wait
 * for them, so a target named after the first position keeps its observations
 * as profiles until the walk ends. Profiles, never bodies: a profile holds the
 * shape and none of the values, which is the part that weighs.
 *
 * Returns { fold, missing, ids }: the chain's fold, or null with the targets
 * that had no observation, in chain order; and every target the record holds,
 * for suggesting a near name.
 */
function foldChain(dir, prefix, chain) {
  const [head] = chain;
  const waiting = new Map(chain.slice(1).map((id) => [id, []]));
  const ids = new Set();
  let first = null;
  walkObservations(dir, prefix, (id, day, body) => {
    ids.add(id);
    if (id !== head && !waiting.has(id)) return;
    const observed = structuralProfile(profileValue(body));
    if (id === head) {
      if (!first) {
        first = { profile: observed, observations: 1, from: day, to: day };
      } else {
        first.profile = carryOptionality(first.profile, observed);
        first.observations += 1;
        first.to = day;
      }
    }
    if (waiting.has(id)) waiting.get(id).push({ profile: observed, day });
  });
  const missing = chain.filter((id, i) => (i === 0 ? !first : !waiting.get(id).length));
  if (missing.length) return { fold: null, missing, ids };
  const fold = { ...first };
  for (const id of chain.slice(1)) {
    for (const o of waiting.get(id)) {
      fold.profile = carryOptionality(fold.profile, o.profile);
      fold.observations += 1;
      fold.to = o.day;
    }
  }
  return { fold, missing, ids };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [mode, target] = positional;

  const source = (m) => (m === 'mcp' ? [MCP_DIR, 'responses-'] : [HTTP_DIR, 'capture-']);

  if (mode === 'list' || !mode) {
    for (const m of target ? [target] : ['api', 'mcp']) {
      const folds = foldEach(...source(m));
      console.log(`\n${m.toUpperCase()} — ${folds.size} targets with observed responses:\n`);
      const rows = [...folds.entries()]
        .map(([id, f]) => ({ id, n: f.observations, fields: countFields(f.profile).total }))
        .sort((a, b) => b.fields - a.fields);
      for (const r of rows.slice(0, 25)) {
        console.log(`  ${r.id.padEnd(40)} ${String(r.n).padStart(3)} obs  ${String(r.fields).padStart(4)} fields`);
      }
      if (rows.length > 25) console.log(`  ... and ${rows.length - 25} more`);
    }
    console.log();
    return;
  }

  if (!['api', 'mcp'].includes(mode)) throw new Error(`unknown mode: ${mode}. Use api, mcp or list.`);
  if (!target) throw new Error(`generate ${mode} needs a target. Run 'generate list ${mode}' to see them.`);

  // Fold several targets into one type when they are the same operation
  // observed on different resources.
  //
  // THE FINDING THAT FORCED THIS. GET /repos/{owner}/{repo} returns 84 fields
  // for octocat/Hello-World and 86 for facebook/react, at the same moment with
  // the same credentials. The extras are `custom_properties` and
  // `organization`, present only because react is owned by an organisation.
  //
  // So the response shape is conditioned on the RESOURCE, not only on auth or
  // plan, and a type generated from one resource marks fields required that are
  // genuinely conditional. That is the same over-narrow failure we accuse spec
  // generators of, arrived at from the opposite direction, and observation
  // alone does not save us from it: it has to be observation of ENOUGH
  // resources. Folding is what converts "what react returns" into "what this
  // endpoint returns", and each additional resource can only widen the type
  // honestly, never narrow it.
  //
  // This is also the clearest argument for the cross-company corpus we have
  // found: one team observes their own resources, and their type is narrow in
  // exactly the ways their own data happens to be.
  const foldIds = flags.fold ? flags.fold.split(',').map((s) => s.trim()) : null;
  const { fold, missing, ids } = foldChain(...source(mode), foldIds ?? [target]);
  if (!fold && foldIds) throw new Error(`no observations for "${missing[0]}" in the fold list`);
  if (!fold) {
    const near = [...ids].filter((k) => k.includes(target)).slice(0, 5);
    throw new Error(
      `no observations for "${target}".` + (near.length ? ` Did you mean: ${near.join(', ')}?` : ` Run 'generate list ${mode}'.`),
    );
  }

  const { profile } = fold;
  const counts = countFields(profile);

  // The honest limits go IN the file, not in a footnote nobody reads.
  const notes = [];
  if (fold.observations < 3) {
    notes.push(
      `only ${fold.observations} observation${fold.observations === 1 ? '' : 's'}, so optionality is under-evidenced: a field that IS conditional may be typed required here.`,
    );
  }
  if (mode === 'mcp') {
    notes.push('MCP responses are recorded from read-only tools only, so this record is biased toward reads.');
  }
  notes.push('where a vendor ships official types, prefer theirs: this is strongest where none exist.');
  // The resource-conditioning caveat is not optional. A type built from one
  // resource is narrow in exactly the ways that resource happens to be, and a
  // reader who does not know that will trust a required field that is really
  // conditional. Saying which resources were observed is what makes the
  // required/optional split auditable instead of merely confident.
  if (foldIds) {
    notes.push(`folded from ${foldIds.length} resources (${foldIds.join(', ')}); a field is required only if present on all of them.`);
  } else {
    notes.push('observed on ONE resource, so a field may be marked required that is conditional on that resource. Fold several with --fold to widen it honestly.');
  }

  const module = generateModule({
    name: target,
    profile,
    source: mode === 'mcp' ? `MCP tool ${target}` : `HTTP endpoint ${target}`,
    observations: fold.observations,
    observedFrom: fold.from,
    observedTo: fold.to,
    command: `npx shiftgraph generate ${mode} ${target}`,
    notes,
  });

  const out = flags.out || `${target.replace(/[^A-Za-z0-9]+/g, '-')}.ts`;
  await fs.writeFile(out, module, 'utf8');
  console.log(`Wrote ${out}`);
  console.log(`  ${counts.total} fields (${counts.optional} optional) from ${fold.observations} observation(s)`);
  console.log(`  observed ${fold.from} to ${fold.to}`);
}

main().catch((err) => {
  console.error(`generate failed: ${err.message}`);
  process.exitCode = 1;
});
