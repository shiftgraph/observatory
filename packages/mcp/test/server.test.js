/**
 * The server's job is to answer from the record or refuse. These test both
 * halves against the real published index, served from disk through a stub
 * fetch, so the shape being asserted is the shape that actually ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, callTool, resolveTarget, handle, TOOLS } from '../index.js';

const CONTRACTS = path.resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'data',
  'contracts',
);

const haveRecord = existsSync(path.join(CONTRACTS, 'index.json'));

/** Serves the real files, so a test that passes here passes against the CDN. */
function diskFetch(url) {
  const file = path.join(CONTRACTS, decodeURIComponent(url.split('/').pop()));
  if (!existsSync(file)) {
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
  }
  const body = JSON.parse(readFileSync(file, 'utf8'));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

const store = () => createStore({ base: 'https://example.invalid/contracts', fetchImpl: diskFetch });
const index = () => JSON.parse(readFileSync(path.join(CONTRACTS, 'index.json'), 'utf8'));

test('every tool declares a schema a host can render', () => {
  assert.ok(TOOLS.length >= 3);
  for (const t of TOOLS) {
    assert.ok(t.name && t.description, `${t.name} is underspecified`);
    assert.equal(t.inputSchema.type, 'object');
    // A description that does not say what the tool refuses is a description
    // an agent will over-trust.
    assert.ok(t.description.length > 60, `${t.name}'s description is too thin to route on`);
  }
  const lookup = TOOLS.find((t) => t.name === 'lookup_contract');
  assert.match(lookup.description, /guess/i, 'lookup must advertise that it refuses rather than guesses');
});

test('initialize echoes a protocol it can speak, and falls back when it cannot', async () => {
  const known = await handle(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    store(),
  );
  assert.equal(known.result.protocolVersion, '2024-11-05');

  const unknown = await handle(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    store(),
  );
  assert.ok(unknown.result.protocolVersion !== '1999-01-01');
  assert.ok(unknown.result.serverInfo.name === 'shiftgraph');
});

test('a notification is never answered', async () => {
  // Answering one desyncs strict hosts. An id of null counts as absent.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'tools/list' }, store()), null);
  assert.equal(await handle({ jsonrpc: '2.0', id: null, method: 'ping' }, store()), null);
});

test('an unknown method is a protocol error, not a crash', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, store());
  assert.equal(res.error.code, -32601);
});

test('a failing tool returns an error RESULT, not a protocol error', async () => {
  // The model should see that the lookup failed and why. Tearing down the
  // connection hides it and looks like the server broke.
  const broken = createStore({
    base: 'https://example.invalid',
    fetchImpl: () => Promise.reject(new Error('network down')),
  });
  const res = await handle(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'record_limits' } },
    broken,
  );
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /network down/);
});

test('resolution is exact, and never fuzzy across providers', { skip: !haveRecord }, () => {
  const idx = index();
  const first = idx.contracts[0];

  assert.equal(resolveTarget(idx, first.id).match?.id, first.id, 'exact id must resolve');
  assert.equal(resolveTarget(idx, first.url).match?.id, first.id, 'full url must resolve');

  // The failure that matters: a host we do not hold must not borrow another's
  // contract. An agent cannot tell a near-miss from a hit.
  const miss = resolveTarget(idx, 'https://api.stripe.com/v1/charges');
  assert.equal(miss.match, null, 'an unheld interface must never match');
});

test('an unheld interface is refused, and the refusal is actionable', { skip: !haveRecord }, async () => {
  const text = await callTool(store(), 'lookup_contract', {
    target: 'https://api.stripe.com/v1/charges',
  });
  assert.match(text, /No observed record/);
  assert.match(text, /npx @shiftgraph\/generate/, 'a refusal must name the way to observe it');
  assert.doesNotMatch(text, /```typescript/, 'a refusal must never carry a declaration');
});

test('a held interface answers with its evidence and its limits', { skip: !haveRecord }, async () => {
  const idx = index();
  const withType = idx.contracts.find((c) => !c.oversize);
  const text = await callTool(store(), 'lookup_contract', { target: withType.url });

  assert.match(text, /```typescript/, 'a held contract must carry its declaration');
  assert.match(text, /Observed \d+ time/, 'every answer states how much evidence backs it');
  assert.match(text, /Evidence: (strong|thin|insufficient)/);
  assert.match(text, /What this does not tell you/);
  assert.match(text, /Limits of the whole record/);
  // The structural limit that makes the free record free.
  assert.match(text, /unauthenticated/i);
});

test('a withheld declaration says so rather than shipping nothing quietly', { skip: !haveRecord }, async () => {
  const idx = index();
  const oversize = idx.contracts.find((c) => c.oversize);
  if (!oversize) return;
  const text = await callTool(store(), 'lookup_contract', { target: oversize.url });
  assert.match(text, /No declaration is published/);
  assert.match(text, /data MAP rather than a record/);
});

test('listing is filterable and names the providers when a filter misses', { skip: !haveRecord }, async () => {
  const all = await callTool(store(), 'list_contracts', {});
  assert.match(all, /contracts:/);

  const none = await callTool(store(), 'list_contracts', { provider: 'not-a-provider' });
  assert.match(none, /No contract matches/);
  assert.match(none, /Providers in the record:/, 'a miss must show what IS available');
});

test('record_limits states what the record cannot know', { skip: !haveRecord }, async () => {
  const text = await callTool(store(), 'record_limits', {});
  assert.match(text, /Values are discarded and never stored/);
  assert.match(text, /Optionality is earned/);
  assert.match(text, /github\.com\/shiftgraph\/observatory/);
});

test('the index is fetched once and reused', { skip: !haveRecord }, async () => {
  let calls = 0;
  const counting = createStore({
    base: 'https://example.invalid/contracts',
    fetchImpl: (u) => {
      calls += 1;
      return diskFetch(u);
    },
  });
  await callTool(counting, 'list_contracts', {});
  await callTool(counting, 'list_contracts', {});
  await callTool(counting, 'record_limits', {});
  assert.equal(calls, 1, 'the index must not be refetched per call');
});

/**
 * The transport must not exit with an answer still owed.
 *
 * A lookup is a network fetch, so a request arriving just before the input
 * closes is in flight when `end` fires. The first version called
 * `process.exit(0)` there and dropped the response with no error anywhere: the
 * caller waits, receives nothing, and the process is already gone.
 *
 * A live host holds stdin open, so this never showed in the protocol smoke
 * test. It was found by piping two requests in and getting one answer back,
 * which is why the live run matters and the unit tests alone do not.
 */
test('the stdio transport answers every request before it exits', async () => {
  const { spawn } = await import('node:child_process');
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

  const responses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));

    // Three requests, then close immediately. Two of them need the network, so
    // both are outstanding at the moment stdin ends.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record_limits' } })}\n`,
    );
    child.stdin.end();
  });

  const ids = responses.map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 2, 3], 'every request must be answered before exit');
});
