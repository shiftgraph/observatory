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

/**
 * Requests still awaiting an answer.
 *
 * A lookup is a network fetch, so a request that arrives just before the input
 * closes is still in flight when `end` fires. Exiting there drops the response
 * with no error anywhere: the caller waits, gets nothing, and the process is
 * already gone. A live host holds stdin open so it rarely shows, which is
 * exactly what makes it the kind of bug that reaches production.
 *
 * Found by piping two requests in and receiving one answer.
 */
const inFlight = new Set();
let inputClosed = false;

function maybeExit() {
  if (!inputClosed || inFlight.size > 0) return;

  // NOTHING IS CALLED HERE. The process is simply allowed to end.
  //
  // This used to be `process.exit(0)`, and on the fastest path — a refusal,
  // which makes one request and then only computes — that raced libuv's own
  // teardown and produced a hard Windows assertion:
  //
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c:76
  //
  // The answer had already been written to stdout, so a caller saw a correct
  // response while the host saw the server crash. Deferring the exit by a tick
  // did not fix it, because the race is with socket teardown rather than with
  // the microtask queue.
  //
  // Node exits on its own once no handle is left open. stdin has ended, the
  // responses are written, and the fetches close their connections rather than
  // pooling them, so there is nothing left to wait on and nothing to force.
  //
  // Found by the pre-publish smoke test running the installed binary. The unit
  // tests never saw it: they call the handler directly and never start a
  // process that has to end.
  process.exitCode = 0;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf('\n');
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line) {
      const task = dispatch(line).finally(() => {
        inFlight.delete(task);
        maybeExit();
      });
      inFlight.add(task);
    }
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

process.stdin.on('end', () => {
  inputClosed = true;
  maybeExit();
});
