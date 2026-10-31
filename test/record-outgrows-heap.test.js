// The record can grow larger than the heap, and the readers keep working.
//
// This failed for real. On 2026-10-31, after 366 green sweeps, the six-hourly
// run died in the contracts index with "JavaScript heap out of memory". Every
// reader that walks the whole record (the contracts index, the replay and the
// generator) read each capture's bodies into one list per endpoint and folded
// the lists afterwards, so the memory a run needed grew with every sweep ever
// taken. At 377 captures it passed the 4 GB a GitHub runner's heap allows, and
// it would have passed it again on every run after, since the record only
// grows. The baseline had already rolled when the index died, so each failed
// run's observations were lost with the runner.
//
// The readers now fold each body the moment they read it. This holds that: a
// record many times larger than a small heap is indexed, replayed and listed
// inside it, by the scripts as they ship, copied over a synthetic record so the
// real one is never touched.
//
// The control is what makes the test mean something. The same record, read
// the way the readers used to read it, must NOT fit the same heap. If a change
// to the profiler or to Node made the synthetic record cheap enough to buffer,
// the readers would pass whether or not they buffer, and this test would say
// nothing; the control fails it first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { ENDPOINTS } from '../apps/observatory/registry.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The heap every reader gets, in MB. A tenth of what a runner gives, and then some. */
const HEAP_MB = 64;
/** Captures in the synthetic record. Folded, the record costs one body; buffered, all of them. */
const CAPTURES = 40;
/** Items per body: megabytes of values, one small shape. */
const ITEMS = 25_000;

const ENDPOINT = ENDPOINTS[0];

function body(sweep) {
  return {
    sweep,
    items: Array.from({ length: ITEMS }, (_, i) => ({
      id: i,
      name: `item ${sweep}-${i}, which is data rather than shape`,
      score: (i * 7919) % 1000,
    })),
  };
}

function span(sweep) {
  return {
    name: `GET ${ENDPOINT.url}`,
    startTimeUnixNano: String(Date.UTC(2026, 0, 1 + sweep) * 1e6),
    attributes: {
      'http.request.method': 'GET',
      'url.full': ENDPOINT.url,
      'http.response.status_code': 200,
      'http.response.header.content-type': 'application/json',
      'shiftgraph.response.body': JSON.stringify(body(sweep)),
    },
    resource: { provider: ENDPOINT.provider, category: ENDPOINT.category, endpoint_id: ENDPOINT.id },
  };
}

/** A copy of the code beside a synthetic record, so REPO_ROOT resolves to it. */
function syntheticRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'observatory-heap-'));
  cpSync(path.join(REPO_ROOT, 'apps'), path.join(root, 'apps'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'packages'), path.join(root, 'packages'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  const dir = path.join(root, 'data', 'observatory');
  mkdirSync(dir, { recursive: true });
  for (let sweep = 0; sweep < CAPTURES; sweep += 1) {
    const at = new Date(Date.UTC(2026, 0, 1 + sweep)).toISOString().replace(/[:.]/g, '-');
    writeFileSync(
      path.join(dir, `capture-${at}.ndjson.gz`),
      zlib.gzipSync(`${JSON.stringify(span(sweep))}\n`),
    );
  }
  // What the readers used to do: keep every parsed body until the walk ends.
  writeFileSync(
    path.join(root, 'buffer-every-body.mjs'),
    [
      "import { readdirSync } from 'node:fs';",
      "import path from 'node:path';",
      "import { readStoredSync } from './apps/observatory/capture-io.mjs';",
      "const dir = path.join('data', 'observatory');",
      'const held = [];',
      "for (const f of readdirSync(dir).filter((f) => f.startsWith('capture-')).sort()) {",
      "  for (const line of readStoredSync(path.join(dir, f)).trim().split('\\n')) {",
      "    held.push(JSON.parse(JSON.parse(line).attributes['shiftgraph.response.body']));",
      '  }',
      '}',
      'console.log(held.length);',
      '',
    ].join('\n'),
  );
  return root;
}

function run(root, script, args = []) {
  return spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');

test('a record larger than the heap is indexed, replayed and listed inside it', (t) => {
  const root = syntheticRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const control = run(root, 'buffer-every-body.mjs');
  assert.notEqual(
    control.status,
    0,
    `the synthetic record fits a ${HEAP_MB} MB heap even with every body held, so passing below proves nothing; raise CAPTURES or ITEMS until the control fails:\n${tail(control)}`,
  );

  const index = run(root, path.join('apps', 'observatory', 'contracts-index.mjs'));
  assert.equal(index.status, 0, `the contracts index did not fit a ${HEAP_MB} MB heap:\n${tail(index)}`);
  const published = JSON.parse(readFileSync(path.join(root, 'data', 'contracts', 'index.json'), 'utf8'));
  const entry = published.contracts.find((c) => c.id === ENDPOINT.id);
  assert.ok(entry, `the index did not publish ${ENDPOINT.id}`);
  assert.equal(entry.observations, CAPTURES, 'the index folded fewer observations than the record holds');

  const replay = run(root, path.join('apps', 'observatory', 'replay.mjs'));
  assert.equal(replay.status, 0, `the replay did not fit a ${HEAP_MB} MB heap:\n${tail(replay)}`);
  assert.match(replay.stdout, new RegExp(`captures replayed\\s+: ${CAPTURES}\\b`), 'the replay read fewer captures than the record holds');
  assert.match(replay.stdout, new RegExp(`comparisons made\\s+: ${CAPTURES - 1}\\b`), 'the replay compared fewer observations than the record holds');

  const list = run(root, path.join('apps', 'observatory', 'generate.mjs'), ['list', 'api']);
  assert.equal(list.status, 0, `the generator's list did not fit a ${HEAP_MB} MB heap:\n${tail(list)}`);
  assert.match(list.stdout, new RegExp(`${ENDPOINT.id}\\s+${CAPTURES} obs`), 'the list folded fewer observations than the record holds');
});
