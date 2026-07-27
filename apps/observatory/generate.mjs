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
import { readStoredSync, CAPTURE_FILE } from './capture-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileValue, structuralProfile, carryOptionality } from '../../packages/core/shape.js';
import { generateModule, countFields } from '../../packages/generate/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HTTP_DIR = path.join(REPO_ROOT, 'data', 'observatory');
const MCP_DIR = path.join(REPO_ROOT, 'data', 'observatory-mcp');

/**
 * Load every observation of every endpoint, oldest first.
 * Returns Map<endpointId, {day, body}[]>.
 */
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

function loadSeries(dir, prefix) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && CAPTURE_FILE.test(f))
    // `*-latest.ndjson` is a copy of the newest dated file. Counting it would
    // double every observation and put "latest.ndj" where a date belongs.
    .filter((f) => !f.includes('latest'))
    .filter((f) => statSync(path.join(dir, f)).size > 200)
    .sort();
  const series = new Map();
  for (const f of files) {
    for (const line of readStoredSync(path.join(dir, f)).trim().split('\n')) {
      if (!line) continue;
      let span;
      try { span = JSON.parse(line); } catch { continue; }
      const id = span.resource?.endpoint_id;
      const raw = span.attributes?.['shiftgraph.response.body'];
      if (!id || !raw) continue;
      if (!series.has(id)) series.set(id, []);
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      try { series.get(id).push({ day: m ? m[1] : 'unknown', body: decodeEmbeddedJson(JSON.parse(raw)) }); } catch { /* skip */ }
    }
  }
  return series;
}

/**
 * Fold a whole series into one profile, carrying optionality forward exactly as
 * the baseline roll does. This is the point: the type is built from everything
 * ever observed, so a field seen absent even once is optional in the emitted
 * type. A single observation would produce a confidently over-narrow type.
 */
function foldSeries(observations) {
  let profile = structuralProfile(profileValue(observations[0].body));
  for (let i = 1; i < observations.length; i++) {
    profile = carryOptionality(profile, structuralProfile(profileValue(observations[i].body)));
  }
  return profile;
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

  const load = (m) =>
    m === 'mcp' ? loadSeries(MCP_DIR, 'responses-') : loadSeries(HTTP_DIR, 'capture-');

  if (mode === 'list' || !mode) {
    for (const m of target ? [target] : ['api', 'mcp']) {
      const series = load(m);
      console.log(`\n${m.toUpperCase()} — ${series.size} targets with observed responses:\n`);
      const rows = [...series.entries()]
        .map(([id, obs]) => ({ id, n: obs.length, fields: countFields(foldSeries(obs)).total }))
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

  const series = load(mode);
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
  const observations = foldIds
    ? foldIds.flatMap((id) => {
        const s = series.get(id);
        if (!s) throw new Error(`no observations for "${id}" in the fold list`);
        return s;
      })
    : series.get(target);
  if (!observations) {
    const near = [...series.keys()].filter((k) => k.includes(target)).slice(0, 5);
    throw new Error(
      `no observations for "${target}".` + (near.length ? ` Did you mean: ${near.join(', ')}?` : ` Run 'generate list ${mode}'.`),
    );
  }

  const profile = foldSeries(observations);
  const counts = countFields(profile);

  // The honest limits go IN the file, not in a footnote nobody reads.
  const notes = [];
  if (observations.length < 3) {
    notes.push(
      `only ${observations.length} observation${observations.length === 1 ? '' : 's'}, so optionality is under-evidenced: a field that IS conditional may be typed required here.`,
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
    observations: observations.length,
    observedFrom: observations[0].day,
    observedTo: observations[observations.length - 1].day,
    command: `npx shiftgraph generate ${mode} ${target}`,
    notes,
  });

  const out = flags.out || `${target.replace(/[^A-Za-z0-9]+/g, '-')}.ts`;
  await fs.writeFile(out, module, 'utf8');
  console.log(`Wrote ${out}`);
  console.log(`  ${counts.total} fields (${counts.optional} optional) from ${observations.length} observation(s)`);
  console.log(`  observed ${observations[0].day} to ${observations[observations.length - 1].day}`);
}

main().catch((err) => {
  console.error(`generate failed: ${err.message}`);
  process.exitCode = 1;
});
