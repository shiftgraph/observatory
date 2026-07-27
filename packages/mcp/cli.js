#!/usr/bin/env node
/**
 * stdio transport for the ShiftGraph MCP server.
 *
 * Newline-delimited JSON-RPC on stdin and stdout, which is what the stdio
 * transport is. Two rules matter and both are easy to get wrong:
 *
 * NOTHING BUT JSON-RPC MAY EVER REACH STDOUT. A stray console.log corrupts the
 * stream and the host disconnects with an error that names neither the log nor
 * the line. Diagnostics go to stderr, which hosts collect and show.
 *
 * A message may arrive split across chunks, or several may arrive in one. The
 * buffer is drained line by line rather than parsed per chunk.
 */
import { createStore, handle } from './index.js';

const store = createStore({
  base: process.env.SHIFTGRAPH_CONTRACTS_BASE || undefined,
});

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf('\n');
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line) void dispatch(line);
    cut = buffer.indexOf('\n');
  }
});

async function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Unparseable input has no id, so there is nobody to answer. Reporting it
    // on stderr is all that can honestly be done.
    process.stderr.write('shiftgraph-mcp: ignoring unparseable line\n');
    return;
  }

  try {
    const response = await handle(message, store);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (err) {
    if (message.id !== undefined && message.id !== null) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: String(err?.message || err) },
        })}\n`,
      );
    } else {
      process.stderr.write(`shiftgraph-mcp: ${String(err?.message || err)}\n`);
    }
  }
}

process.stdin.on('end', () => process.exit(0));
