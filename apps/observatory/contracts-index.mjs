#!/usr/bin/env node
/**
 * The public contract record, in a form a machine can read.
 *
 * The observatory has always produced a record a person can read: a repository
 * of captures, a history, a summary. None of that is consultable by the thing
 * that actually reads interface documentation now, which is a coding agent
 * partway through writing an integration.
 *
 * This writes the record as flat JSON, one small index plus one file per
 * endpoint, regenerated on every sweep and committed. That makes it reachable
 * over any static host with no server, no key, no rate limit and no cost, and
 * it is what `@shiftgraph/mcp` answers from.
 *
 * EVERYTHING IS PRE-COMPUTED HERE, INCLUDING THE TYPESCRIPT. The client that
 * serves this to an agent should hold no logic at all: a client that generates
 * is a client that can generate differently from us, and then two answers to
 * one question exist. The file is the answer.
 *
 * The counts are folded across the whole retained series rather than read off
 * the baseline. The baseline is rolled forward each sweep, so its sample_count
 * describes the last roll and would report one observation for an endpoint we
 * have watched for weeks. An index that understates its own evidence is worse
 * than one that omits it, because a reader would believe it.
 *
 *   node apps/observatory/contracts-index.mjs
 */
import { readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileValue, structuralProfile, carryOptionality } from '../../packages/core/shape.js';
import { generateModule, countFields, nullOnlyFields } from '../../packages/generate/index.js';
import { ENDPOINTS, REGISTRY_META } from './registry.js';
import { readStoredSync, CAPTURE_FILE, contractBearingSpan } from './capture-io.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(REPO_ROOT, 'data', 'observatory');
const OUT = path.join(REPO_ROOT, 'data', 'contracts');

/** Schema version of the published files. Bump on any breaking field change. */
const SCHEMA_VERSION = 1;

/**
 * Below this, a type is confidently over-narrow: every field it happened to
 * see is marked required, including the ones that are merely conditional.
 * Publishing the number matters more than withholding the record.
 */
const THIN_OBSERVATIONS = 3;
const STRONG_OBSERVATIONS = 10;

/**
 * Above this, the emitted declaration is not a contract anyone can read.
 *
 * Three endpoints here are data MAPS rather than records: an npm packument
 * carries an entry per published version, so its profile has a thousand
 * distinct keys and emits three and a half megabytes of TypeScript. Map
 * detection exists for exactly this and does not fire on them, because it
 * requires the sibling shapes to be identical and real packuments vary field
 * by field between releases.
 *
 * Publishing the declaration anyway would put a file no agent can use into a
 * record whose whole claim is usefulness, and would churn megabytes through
 * the repository on every sweep. Publishing nothing would hide an endpoint we
 * genuinely observe. So the entry stays, the declaration is withheld, and the
 * reason is written into the file rather than left to be inferred.
 */
const MAX_MODULE_BYTES = 64 * 1024;

function confidence(n) {
  if (n >= STRONG_OBSERVATIONS) return 'strong';
  if (n >= THIN_OBSERVATIONS) return 'thin';
  return 'insufficient';
}

/** endpoint id -> observations, oldest first. */
function loadSeries() {
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith('capture-') && CAPTURE_FILE.test(f))
    .filter((f) => statSync(path.join(DIR, f)).size > 1000)
    .sort();

  const series = new Map();
  for (const f of files) {
    const day = f.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? 'unknown';
    for (const line of readStoredSync(path.join(DIR, f)).trim().split('\n')) {
      if (!line) continue;
      let span;
      try {
        span = JSON.parse(line);
      } catch {
        continue;
      }
      const id = span.resource?.endpoint_id;
      const raw = span.attributes?.['shiftgraph.response.body'];
      // A failure is not a contract (capture-io: contractBearingSpan).
      if (!id || !raw || !contractBearingSpan(span)) continue;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!series.has(id)) series.set(id, []);
      series.get(id).push({ day, body });
    }
  }
  return series;
}

/**
 * Fold every observation into one profile, carrying optionality forward
 * exactly as the baseline roll does.
 *
 * This is the whole reason the record is worth consulting. A field is marked
 * optional only where the interface was WATCHED omitting it, so a type built
 * from the fold is narrow where the evidence supports narrow and honest where
 * it does not. A single observation would produce a confidently wrong type.
 */
function fold(observations) {
  let profile = structuralProfile(profileValue(observations[0].body));
  for (let i = 1; i < observations.length; i += 1) {
    profile = carryOptionality(profile, structuralProfile(profileValue(observations[i].body)));
  }
  return profile;
}

function main() {
  const series = loadSeries();
  const byId = new Map(ENDPOINTS.map((e) => [e.id, e]));

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const entries = [];

  for (const [id, observations] of series) {
    const ep = byId.get(id);
    if (!ep || !observations.length) continue;

    const profile = fold(observations);
    const counts = countFields(profile);
    const days = [...new Set(observations.map((o) => o.day))].sort();
    const n = observations.length;

    const notes = [];
    if (n < THIN_OBSERVATIONS) {
      notes.push(
        `only ${n} observation${n === 1 ? '' : 's'}: a field that IS conditional may be typed required here`,
      );
    }
    notes.push(
      'observed on public, unauthenticated requests. A response to an authenticated caller, on a different plan, or for a different resource can carry fields this does not',
    );
    const nullOnly = nullOnlyFields(profile);
    if (nullOnly.length) {
      notes.push(
        `typed null and never seen holding a value: ${nullOnly.slice(0, 6).join(', ')}${nullOnly.length > 6 ? ', ...' : ''}`,
      );
    }

    let typescript = generateModule({
      name: id,
      profile,
      source: `${ep.method} ${ep.url}`,
      observations: n,
      observedFrom: days[0],
      observedTo: days[days.length - 1],
      command: `npx @shiftgraph/generate ${ep.url}`,
      notes,
    });

    // Withheld rather than truncated. A half-emitted TypeScript module is not
    // valid TypeScript, and handing an agent something that looks like a
    // declaration and does not parse is worse than handing it nothing with a
    // reason attached.
    let published = profile;
    let oversize = false;
    if (Buffer.byteLength(typescript, 'utf8') > MAX_MODULE_BYTES) {
      oversize = true;
      typescript = null;
      // The profile goes too. Once the declaration is withheld, a thousand-key
      // profile is no more usable than the type it produced, and it is the
      // part that actually weighs megabytes. Nothing is lost: the raw capture
      // and the rolled baseline are both public in this repository, so the
      // full record is one directory away for anyone who wants it.
      published = null;
      notes.push(
        'declaration and profile withheld here: this endpoint returns a data MAP rather than a record, so its profile carries one key per item and the emitted type runs to megabytes. The shape worth coding against is the map ENTRY, not the map. The full record is in data/observatory as captures and in the rolled baseline',
      );
    }

    const entry = {
      id,
      provider: ep.provider,
      category: ep.category,
      method: ep.method,
      url: ep.url,
      host: (() => {
        try {
          return new URL(ep.url).host;
        } catch {
          return null;
        }
      })(),
      path: (() => {
        try {
          return new URL(ep.url).pathname;
        } catch {
          return null;
        }
      })(),
      observations: n,
      observed_days: days.length,
      observed_from: days[0],
      observed_to: days[days.length - 1],
      fields: counts.total,
      optional_fields: counts.optional,
      confidence: confidence(n),
      oversize,
    };

    entries.push(entry);

    // THE CONTRACT FILE CARRIES NO LIVE COUNTERS, AND THAT IS DELIBERATE.
    //
    // `observations`, `observed_days` and `observed_to` move on every sweep. If
    // they lived here, all one hundred and seventy-odd files would change four
    // times a day whether or not a single contract had, and the repository
    // would take megabytes of new objects daily for metadata that says nothing
    // about the interface. Worse, the history would stop showing when a
    // contract actually moved, which is the one thing this record is for.
    //
    // They live in index.json, which is fetched anyway to resolve a URL to a
    // contract. The confidence TIER is here because it changes rarely and
    // belongs beside the declaration it qualifies.
    writeFileSync(
      path.join(OUT, `${id}.json`),
      `${JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          id,
          provider: entry.provider,
          category: entry.category,
          method: entry.method,
          url: entry.url,
          host: entry.host,
          path: entry.path,
          observed_from: entry.observed_from,
          confidence: entry.confidence,
          fields: counts.total,
          optional_fields: counts.optional,
          oversize,
          notes,
          profile: published,
          typescript,
        },
        null,
        2,
      )}\n`,
    );
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : 1));

  writeFileSync(
    path.join(OUT, 'index.json'),
    `${JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        // No generated_at. It would change on every run whether or not the
        // record did, so every sweep would commit a diff and the history would
        // stop showing when the record actually moved.
        watching: {
          endpoints: ENDPOINTS.length,
          providers: REGISTRY_META.providers,
          categories: REGISTRY_META.categories,
        },
        published: entries.length,
        limits: [
          'Public, unauthenticated endpoints only. What an interface returns to an authenticated caller, on a paid plan, or for a different resource is not visible here and cannot be.',
          'A profile describes what was observed, not what is specified. It is not a guarantee about future responses.',
          `Optionality is earned: a field is optional only where the interface was watched omitting it. Below ${THIN_OBSERVATIONS} observations a conditional field may be typed required.`,
        ],
        contracts: entries,
      },
      null,
      2,
    )}\n`,
  );

  const strong = entries.filter((e) => e.confidence === 'strong').length;
  const thin = entries.filter((e) => e.confidence === 'thin').length;
  console.log(
    `contracts: ${entries.length} published (${strong} strong, ${thin} thin, ` +
      `${entries.length - strong - thin} insufficient)`,
  );
}

main();
