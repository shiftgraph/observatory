#!/usr/bin/env node
// The first half of the demo: an agent writing code against an MCP tool is
// guessing what comes back, and nothing in the tool's declaration tells it
// otherwise.
//
// Reproducible on purpose. A screenshot of an agent being wrong proves nothing,
// because the reader cannot tell whether the agent was set up to fail. This
// reads the real tool definition out of our own capture, prints everything the
// agent is given, and then shows several mutually incompatible response shapes
// that are ALL equally consistent with that definition. The point is not that
// one guess is wrong. It is that the declaration cannot distinguish them.
//
//   node apps/observatory/demo-guess.mjs [tool-name]
import { readdirSync, statSync } from 'node:fs';
import { readStoredSync, CAPTURE_FILE } from './capture-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(REPO_ROOT, 'data', 'observatory-mcp');
const WANTED = process.argv[2] || 'search_repositories';

function latestCapture() {
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith('capture-') && CAPTURE_FILE.test(f))
    .filter((f) => statSync(path.join(DIR, f)).size > 1000)
    .sort();
  return path.join(DIR, files[files.length - 1]);
}

const tools = [];
for (const line of readStoredSync(latestCapture()).trim().split('\n')) {
  const span = JSON.parse(line);
  const body = span.attributes?.['shiftgraph.response.body'];
  if (body) tools.push(JSON.parse(body));
}

const tool = tools.find((t) => t.name === WANTED);
if (!tool) {
  console.error(`no tool named ${WANTED} in the capture`);
  process.exit(1);
}

const declaresOutput = tool.outputSchema && Object.keys(tool.outputSchema).length > 0;
const withOutput = tools.filter((t) => t.outputSchema && Object.keys(t.outputSchema).length).length;

const line = (s = '') => console.log(s);

line('='.repeat(74));
line(`  EVERYTHING AN AGENT IS GIVEN ABOUT  ${tool.name}`);
line('='.repeat(74));
line();
line(`  description : ${tool.description ?? '(none)'}`);
line();
line('  inputSchema : declared, complete, machine-readable');
line(
  JSON.stringify(tool.inputSchema, null, 2)
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n'),
);
line();
line(`  outputSchema: ${declaresOutput ? JSON.stringify(tool.outputSchema) : '*** NOT DECLARED ***'}`);
line();
line('-'.repeat(74));
line('  SO THE AGENT MUST GUESS. THESE ARE ALL EQUALLY CONSISTENT:');
line('-'.repeat(74));
line();

// Every one of these is a shape a competent developer would write, and the
// declaration above rules out none of them.
const guesses = [
  ['the REST shape, because the tool wraps a documented API',
   `{ total_count: number, items: Array<{ id, full_name, stargazers_count, ... }> }`],
  ['a bare array, because the tool is named "search" and returns results',
   `Array<{ name: string, url: string, description: string | null }>`],
  ['the MCP envelope with JSON encoded inside text, which is what most servers actually do',
   `{ content: [ { type: "text", text: "<a JSON string you must parse yourself>" } ] }`],
  ['the MCP envelope with structured content, which the spec also permits',
   `{ content: [...], structuredContent: { ... }, isError?: boolean }`],
  ['a prose summary, because the server author decided an LLM reads this',
   `{ content: [ { type: "text", text: "Found 30 repositories. The top result is..." } ] }`],
];

for (const [why, shape] of guesses) {
  line(`  ${why}`);
  line(`    ${shape}`);
  line();
}

line('-'.repeat(74));
line('  WHY THIS IS THE INTERESTING FAILURE');
line('-'.repeat(74));
line();
line('  An agent that guesses wrong does not crash. It receives a shape it did');
line('  not expect, finds no field where it looked, and narrates a confident');
line('  answer around the hole. Nothing throws. Nothing is logged. The run');
line('  simply produces a worse result, and the team reports that the agent');
line('  "got dumber this week".');
line();
line('  Knowing GitHub\'s REST API does not rescue you, because the question is');
line('  not what GitHub returns. It is what THIS SERVER returns after wrapping');
line('  it, and that is a decision made by the server author, undeclared.');
line();
line('-'.repeat(74));
line(`  MEASURED ON OUR OWN CAPTURE, ${new Date().toISOString().slice(0, 10)}`);
line('-'.repeat(74));
line();
line(`  tools captured                    : ${tools.length}`);
line(`  declaring an inputSchema          : ${tools.length} (100%)`);
line(`  declaring an outputSchema         : ${withOutput} (${Math.round((withOutput / tools.length) * 100)}%)`);
line(`  with NO declared output contract  : ${tools.length - withOutput} (${Math.round(((tools.length - withOutput) / tools.length) * 100)}%)`);
line();
line('  Sample: these tools come from 8 reachable servers, mostly official');
line('  reference implementations. That is a thin sample and it is stated here');
line('  rather than omitted; widening the registry is a scheduled task, and the');
line('  number should not appear on a public page until it is widened.');
line();
line();

// ---------------------------------------------------------------------------
// SECOND HALF: what the tool actually returns, from observation.
// ---------------------------------------------------------------------------
//
// Written after the invocation harness produced the first tool responses this
// project has ever recorded. Until then this section could not exist, because
// we had only ever read declarations.
import { readdirSync as _readdir } from 'node:fs';

const respFiles = _readdir(DIR).filter((f) => f.startsWith('responses-') && !f.includes('latest'));
if (!respFiles.length) {
  line('  (no observed responses yet: run apps/observatory/mcp-invoke.js)');
} else {
  let observed = null;
  for (const f of respFiles) {
    for (const l of readStoredSync(path.join(DIR, f)).trim().split('\n')) {
      const s = JSON.parse(l);
      if (s.resource?.endpoint_id?.endsWith(`:${WANTED}`)) observed = JSON.parse(s.attributes['shiftgraph.response.body']);
    }
  }
  line('-'.repeat(74));
  line('  WHAT IT ACTUALLY RETURNS, OBSERVED');
  line('-'.repeat(74));
  line();
  if (!observed) {
    line(`  ${tool.name} was not invoked (not safely callable, or credentials absent).`);
  } else {
    const envelope = Object.keys(observed).sort().join(', ');
    line(`  envelope        : { ${envelope} }`);
    const block = observed.content?.[0];
    if (block) {
      line(`  content[0].type : ${block.type}`);
      const t = typeof block.text === 'string' ? block.text.trim() : '';
      if (t.startsWith('{') || t.startsWith('[')) {
        const inner = JSON.parse(t);
        line(`  content[0].text : a JSON STRING you must parse yourself`);
        line(`  once parsed     : { ${Object.keys(inner).sort().join(', ')} }`);
        line();
        line('  So the payload the agent needs is at content[0].text, encoded as a');
        line('  string, three levels below where a reasonable guess would look. None of');
        line('  that indirection is declared anywhere, and it is per-tool rather than');
        line('  per-server: the same server answers some tools with structuredContent');
        line('  and others with only this.');
      } else {
        line(`  content[0].text : prose, not JSON`);
      }
    }
    line();
    line('  Types generated from this observation are at:');
    line(`      node apps/observatory/generate.mjs mcp <server>:${tool.name}`);
    line();
    line('  That is the whole product in one line: the agent stops guessing, because');
    line('  something watched the tool answer and wrote down what came back.');
  }
  line();
}
