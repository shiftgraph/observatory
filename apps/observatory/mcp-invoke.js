#!/usr/bin/env node
// The invocation harness: actually CALL read-only MCP tools and record what
// comes back.
//
// Everything before this observed declarations. `mcp-poll.js` issues
// `tools/list` and records each tool's schema, which is the 100% case: every
// tool declares its inputs. The gap the product exists for is the other half —
// roughly two thirds of tools declare no `outputSchema` at all, so an agent
// calling one has no contract for the response it must reason over. That half
// cannot be read from a declaration. It has to be observed, and observing it
// means invoking.
//
// SAFETY, which is a scope decision rather than a limitation to discover later:
//
//   - Only tools whose names match a read verb are invoked. `create_issue`,
//     `send_message` and `delete_*` are never called speculatively against a
//     real server, because a harness that mutates someone else's state to
//     satisfy our curiosity is indefensible regardless of what it learns.
//   - The resulting record is therefore BIASED TOWARD READS. That bias is
//     stated in the README and in the generated output, not buried. It is also
//     probably the right bias: a read's shape is what an agent reasons over,
//     and a wrong assumption there is what produces a confidently wrong answer,
//     while a write's response is usually an acknowledgement.
//   - Arguments are synthesised conservatively from the declared inputSchema.
//     Where a required argument cannot be synthesised safely, the tool is
//     skipped and recorded as skipped.
//
// POLITENESS, ported from the HTTP sweep rather than reinvented: one server at
// a time, spaced calls, an identifying User-Agent equivalent in the client
// info, and a hard per-call timeout. We are generating traffic against other
// people's servers.
//
// CREDENTIALS are pluggable and absent by default. A server whose required
// environment variables are missing is skipped and logged as skipped, never
// silently omitted, because "we observed nothing here" and "we never looked"
// must never be the same row.
//
//   node apps/observatory/mcp-invoke.js
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_SERVERS } from './mcp-registry.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = path.join(REPO_ROOT, 'data', 'observatory-mcp');

const CALL_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const DELAY_BETWEEN_CALLS_MS = 250;
const MAX_TOOLS_PER_SERVER = 40;

/** A read verb. Anything not matching is not invoked, full stop. */
const READ_VERB = /^(get|list|read|search|fetch|describe|query|find|show|view|resolve|lookup|count|stat|inspect)[_-]?/i;

/**
 * Names that read like reads but are not. `read_query` on a database server
 * executes arbitrary SQL; `get_env` discloses the host environment. The verb
 * heuristic is deliberately overridden here rather than made cleverer, because
 * a cleverer verb rule is the templating mistake in a new costume.
 */
const NEVER_CALL = new Set([
  'read_query', 'write_query', 'create_table', 'list_tables', // db servers execute SQL
  'get_env',                                                   // discloses host environment
  'read_file', 'read_text_file', 'read_media_file', 'read_multiple_files',
  'directory_tree', 'list_directory', 'list_directory_with_sizes',
  'search_files', 'get_file_info', 'list_allowed_directories', // local disk disclosure
]);

/**
 * Compare blocklist entries with separators normalised.
 *
 * The first run of this harness called `get-env` and wrote this machine's
 * environment variables into a capture file. `get_env` was in the blocklist;
 * the server spells it `get-env`. A safety list that fails on a hyphen is not a
 * safety list, and the failure was silent — the call succeeded, so nothing drew
 * attention to it.
 *
 * Matching on the normalised name is the fix. Adding "also add the hyphenated
 * spelling" would have left the next naming convention to find on its own.
 */
const normaliseToolName = (n) => String(n).toLowerCase().replace(/[-_\s]/g, '');
const NEVER_CALL_NORMALISED = new Set([...NEVER_CALL].map(normaliseToolName));
const isBlocked = (name) => NEVER_CALL_NORMALISED.has(normaliseToolName(name));

const nowNs = () => (BigInt(Date.now()) * 1000000n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Synthesise a minimal argument object from a declared inputSchema. Returns
 * null when a required argument cannot be filled safely, which skips the tool.
 * Conservative on purpose: a plausible-looking wrong argument produces a
 * plausible-looking wrong observation, and a wrong observation is worse than a
 * missing one.
 */
function synthesiseArgs(schema) {
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const args = {};
  for (const name of required) {
    const p = props[name];
    if (!p) return null;
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    if (p.enum?.length) args[name] = p.enum[0];
    else if (p.default !== undefined) args[name] = p.default;
    else if (t === 'string') args[name] = 'shiftgraph';
    else if (t === 'number' || t === 'integer') args[name] = 1;
    else if (t === 'boolean') args[name] = false;
    else if (t === 'array') args[name] = [];
    else if (t === 'object') args[name] = {};
    else return null; // unknown or union type: refuse rather than guess
  }
  return args;
}

function missingCredentials(server) {
  const needed = server.env ?? [];
  return needed.filter((name) => !process.env[name]);
}

/** One server: handshake, list, then call each safely-callable tool. */
function runServer(server) {
  return new Promise((resolve) => {
    const args = ['-y', server.pkg, ...(server.extraArgs ?? [])];
    const unsafe = args.find((a) => /\s/.test(a));
    if (unsafe) return resolve({ ok: false, reason: `unsafe argument: ${unsafe}`, calls: [] });

    const child = spawn(`npx ${args.join(' ')}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env },
    });

    const calls = [];
    const pending = new Map();
    let buf = '';
    let nextId = 100;
    let settled = false;

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { child.kill(); } catch { /* already gone */ }
      resolve(out);
    };
    const guard = setTimeout(() => finish({ ok: false, reason: 'handshake-timeout', calls }), HANDSHAKE_TIMEOUT_MS);

    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* closed */ } };
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); res(null); }, CALL_TIMEOUT_MS);
        pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
        send({ jsonrpc: '2.0', id, method, params });
      });

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const handler = pending.get(msg.id);
        if (handler) { pending.delete(msg.id); handler(msg); }
      }
    });
    child.on('error', () => finish({ ok: false, reason: 'spawn-failed', calls }));
    child.on('close', () => finish({ ok: calls.length > 0, reason: settled ? 'closed' : 'exited', calls }));

    (async () => {
      const init = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'shiftgraph-observatory', version: '0.4' },
      });
      if (!init || init.error) return finish({ ok: false, reason: 'initialize-failed', calls });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const listed = await request('tools/list', {});
      const tools = listed?.result?.tools ?? [];
      if (!tools.length) return finish({ ok: false, reason: 'no-tools', calls });

      for (const tool of tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        if (!READ_VERB.test(tool.name) || isBlocked(tool.name)) {
          calls.push({ tool: tool.name, skipped: 'not-safely-callable' });
          continue;
        }
        const callArgs = synthesiseArgs(tool.inputSchema);
        if (callArgs === null) {
          calls.push({ tool: tool.name, skipped: 'cannot-synthesise-required-arguments' });
          continue;
        }
        const started = nowNs();
        const t0 = Date.now();
        const res = await request('tools/call', { name: tool.name, arguments: callArgs });
        const ms = Date.now() - t0;
        if (!res) { calls.push({ tool: tool.name, skipped: 'call-timeout' }); continue; }
        if (res.error) { calls.push({ tool: tool.name, skipped: `error: ${String(res.error.message).slice(0, 60)}` }); continue; }
        calls.push({ tool: tool.name, startedNs: started, ms, result: res.result });
        await sleep(DELAY_BETWEEN_CALLS_MS);
      }
      finish({ ok: true, reason: 'complete', calls });
    })();
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const lines = [];
  const summary = {
    schema_version: 'shiftgraph.mcp.invoke.v1',
    started_at: new Date().toISOString(),
    servers_attempted: 0,
    servers_ok: 0,
    tools_invoked: 0,
    tools_skipped: 0,
    skipped_for_credentials: [],
    per_server: [],
    read_bias_note:
      'Only read-verb tools are invoked. Write and delete tools are never called speculatively, so this record is deliberately biased toward reads.',
  };

  console.log(`MCP invocation harness: ${MCP_SERVERS.length} servers registered.\n`);

  for (const server of MCP_SERVERS) {
    const missing = missingCredentials(server);
    if (missing.length) {
      summary.skipped_for_credentials.push({ id: server.id, needs: missing });
      console.log(`  --   ${server.id.padEnd(26)} skipped, needs ${missing.join(', ')}`);
      continue;
    }
    summary.servers_attempted++;
    const out = await runServer(server);
    const invoked = out.calls.filter((c) => c.result);
    const skipped = out.calls.filter((c) => c.skipped);
    if (out.ok) summary.servers_ok++;
    summary.tools_invoked += invoked.length;
    summary.tools_skipped += skipped.length;
    summary.per_server.push({ id: server.id, ok: out.ok, reason: out.reason, invoked: invoked.length, skipped: skipped.length });
    console.log(`  ${out.ok ? 'ok' : '--'}   ${server.id.padEnd(26)} ${String(invoked.length).padStart(2)} invoked, ${String(skipped.length).padStart(2)} skipped  (${out.reason})`);

    for (const c of invoked) {
      lines.push(
        JSON.stringify({
          name: 'tools/call',
          startTimeUnixNano: c.startedNs,
          attributes: {
            'http.request.method': 'CALL',
            'url.full': `mcp://${server.provider}/${server.pkg}/tools/${c.tool}`,
            'http.response.status_code': 200,
            'http.response.header.content-type': 'application/json',
            duration_ms: c.ms,
            'shiftgraph.response.body': JSON.stringify(c.result),
          },
          resource: { provider: server.provider, category: server.category, endpoint_id: `${server.id}:${c.tool}` },
        }),
      );
    }
  }

  summary.finished_at = new Date().toISOString();

  if (!lines.length) {
    console.error(
      '\nNO TOOL WAS SUCCESSFULLY INVOKED.\n' +
        'Nothing is written, deliberately: an empty response record and "we never called anything"\n' +
        'must never be the same file. Skipped-for-credentials is recorded in the summary.',
    );
    await fs.writeFile(path.join(OUT_DIR, 'invoke-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    process.exitCode = 1;
    return;
  }

  const body = lines.join('\n') + '\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(OUT_DIR, `responses-${stamp}.ndjson`), body, 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'responses-latest.ndjson'), body, 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'invoke-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\nInvoked ${summary.tools_invoked} tools across ${summary.servers_ok} servers.`);
  console.log(`Skipped ${summary.tools_skipped} as not safely callable; ${summary.skipped_for_credentials.length} servers skipped for credentials.`);
  console.log(`Responses: ${path.join(OUT_DIR, 'responses-latest.ndjson')}`);
}

main().catch((err) => {
  console.error(`mcp-invoke failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
