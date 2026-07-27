#!/usr/bin/env node
// SHIFTGRAPH MCP tool-contract observatory (Plan v2, Phase 0).
//
// Spawns each public MCP server, performs the protocol handshake, asks for
// `tools/list`, and records every tool's contract. One capture per run; run it
// on a schedule and compare against a saved baseline exactly like the HTTP
// observatory, through the same engine and the same honesty laws.
//
// THE UNIT: one span per TOOL, not per server. A tool is an interface and its
// `inputSchema` is its contract, so a tool whose schema changes is a contract
// change on a surface an agent depends on. That makes tool-level drift directly
// measurable by machinery that already exists.
//
// The emitted span uses an `mcp://` URL and declares a JSON content type. The
// scheme is honest about the transport, and the content type is what makes the
// engine classify the observation as a dependency operation rather than
// discarding it as an unrecognized surface.
//
// SECURITY: this executes third-party npm packages via `npx -y`. Every entry in
// the registry is an official or first-party vendor package. Read the note at
// the top of mcp-registry.js before adding anything.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MCP_SERVERS, MCP_REGISTRY_META } from './mcp-registry.js';

const OUT_DIR = path.join('data', 'observatory-mcp');
const STARTUP_TIMEOUT_MS = 90000; // npx may need to download the package first
const CALL_TIMEOUT_MS = 20000;
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT = { name: 'shiftgraph-observatory', version: '0.1' };

function nowNs() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

/**
 * One MCP session over stdio. Resolves with the tool list, or an honest
 * failure. Never throws: a server that will not start is an observation.
 */
function session(server) {
  return new Promise((resolve) => {
    const args = ['-y', server.pkg, ...(server.extraArgs || [])];
    const started = Date.now();
    let child;
    try {
      // npx is a .cmd shim on Windows, and since the CVE-2024-27980 mitigation
      // Node refuses to spawn one without a shell (EINVAL). So a shell is
      // required here, not preferred.
      //
      // With a shell, arguments are concatenated rather than escaped, which is
      // why Node deprecates passing an args array that way. Every argument here
      // comes from our own hardcoded registry and none may contain whitespace,
      // which the assertion below enforces rather than assumes. Passing one
      // pre-joined string keeps the safety visible instead of leaving it to a
      // reader to work out.
      const unsafe = args.find((a) => /\s/.test(a));
      if (unsafe) {
        return resolve({ ok: false, reason: `unsafe argument (contains whitespace): ${unsafe}`, ms: 0 });
      }
      child = spawn(`npx ${args.join(' ')}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
    } catch (err) {
      return resolve({ ok: false, reason: `spawn-failed: ${err.message}`, ms: 0 });
    }

    let buffer = '';
    let stderr = '';
    let settled = false;
    const pending = new Map();
    let serverInfo = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ...result, ms: Date.now() - started, stderr: stderr.slice(-400) });
    };

    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', serverInfo }),
      STARTUP_TIMEOUT_MS,
    );

    const send = (msg) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* closed */ }
    };
    const request = (id, method, params) => {
      const p = new Promise((res) => pending.set(id, res));
      send({ jsonrpc: '2.0', id, method, params });
      return Promise.race([p, new Promise((res) => setTimeout(() => res({ error: { message: 'call-timeout' } }), CALL_TIMEOUT_MS))]);
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // servers log noise to stdout too
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => finish({ ok: false, reason: `process-error: ${err.message}` }));
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, reason: `exited-before-response (code ${code})`, serverInfo });
    });

    (async () => {
      const init = await request(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT,
      });
      if (!init || init.error) {
        return finish({ ok: false, reason: `initialize-failed: ${init?.error?.message ?? 'no response'}` });
      }
      serverInfo = init.result?.serverInfo ?? null;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const listed = await request(2, 'tools/list', {});
      if (!listed || listed.error) {
        return finish({ ok: false, reason: `tools/list-failed: ${listed?.error?.message ?? 'no response'}`, serverInfo });
      }
      finish({
        ok: true,
        serverInfo,
        protocolVersion: init.result?.protocolVersion ?? null,
        tools: listed.result?.tools ?? [],
      });
    })();
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(
    `SHIFTGRAPH MCP observatory: ${MCP_REGISTRY_META.total} servers across ` +
      `${MCP_REGISTRY_META.providers} providers. First run downloads packages, so it is slow.\n`,
  );

  const lines = [];
  const summary = {
    schema_version: 'shiftgraph.observatory.mcp.run.v1',
    started_at: new Date().toISOString(),
    servers_total: MCP_SERVERS.length,
    servers_ok: 0,
    servers_failed: 0,
    tools_total: 0,
    per_server: [],
    failures: [],
  };

  for (const server of MCP_SERVERS) {
    const startNs = nowNs();
    const result = await session(server);

    if (!result.ok) {
      summary.servers_failed++;
      summary.failures.push({ id: server.id, pkg: server.pkg, reason: result.reason });
      console.log(`  ${'FAIL'.padEnd(5)} ${String(result.ms + 'ms').padEnd(8)} ${server.id.padEnd(26)} ${result.reason}`);
      summary.per_server.push({ id: server.id, ok: false, reason: result.reason, tools: 0 });
      continue;
    }

    summary.servers_ok++;
    summary.tools_total += result.tools.length;
    summary.per_server.push({
      id: server.id,
      ok: true,
      tools: result.tools.length,
      version: result.serverInfo?.version ?? null,
      protocol: result.protocolVersion ?? null,
    });

    // One span per tool, recording what the tool DECLARES.
    //
    // The span used to be named `tools/call` and the method `CALL`, which said
    // this was an invocation. It never was. The only JSON-RPC request this
    // poller issues is `tools/list`, so what is captured below is a tool
    // definition, and no tool response has ever been observed.
    //
    // That mislabel had a real cost beyond tidiness. Phase 0's number is how
    // often tool contracts actually move, and from declarations alone we can
    // only see a server author editing a schema. A response shape changing
    // without a schema edit is invisible, and for the ~65% of tools that
    // declare no `outputSchema` at all, response drift is entirely invisible.
    // So the ledger as built cannot measure Phase 0's number for two thirds of
    // the surface, which is the exact population the wedge is about.
    //
    // Naming it honestly is the cheap half. The invocation harness is the rest.
    for (const tool of result.tools) {
      lines.push(
        JSON.stringify({
          name: 'tools/list',
          startTimeUnixNano: startNs,
          attributes: {
            'http.request.method': 'DECLARE',
            'url.full': `mcp://${server.provider}/${server.pkg}/tools/${tool.name}`,
            'http.response.status_code': 200,
            'http.response.header.content-type': 'application/json',
            duration_ms: result.ms,
            'shiftgraph.response.body': JSON.stringify({
              name: tool.name,
              description: tool.description ?? null,
              inputSchema: tool.inputSchema ?? null,
              outputSchema: tool.outputSchema ?? null,
            }),
          },
          resource: {
            provider: server.provider,
            category: server.category,
            endpoint_id: `${server.id}:${tool.name}`,
            server_version: result.serverInfo?.version ?? null,
            protocol_version: result.protocolVersion ?? null,
          },
        }),
      );
    }

    console.log(
      `  ${'OK'.padEnd(5)} ${String(result.ms + 'ms').padEnd(8)} ${server.id.padEnd(26)} ` +
        `${result.tools.length} tools  v${result.serverInfo?.version ?? '?'}`,
    );
  }

  const body = lines.join('\n') + (lines.length ? '\n' : '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const capturePath = path.join(OUT_DIR, `capture-${stamp}.ndjson`);
  await fs.writeFile(capturePath, body, 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'latest.ndjson'), body, 'utf8');
  summary.finished_at = new Date().toISOString();
  summary.capture = capturePath;
  await fs.writeFile(path.join(OUT_DIR, 'run-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(
    `\nDone: ${summary.servers_ok} servers reachable, ${summary.servers_failed} not. ` +
      `${summary.tools_total} tool contracts recorded.`,
  );
  console.log(`Capture: ${capturePath}`);
  if (summary.servers_ok > 0) {
    console.log(
      `\nNext: baseline it, then compare on the next run.\n` +
        `  node apps/observatory/record.mjs baseline ${path.join(OUT_DIR, 'latest.ndjson')} --format otel-json --out ${path.join(OUT_DIR, 'baseline.json')}`,
    );
  }
}

main().catch((err) => {
  console.error(`MCP observatory failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
