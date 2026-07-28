/**
 * The observed contract record, as an MCP server.
 *
 * An agent writing an integration has to know what an interface returns. Today
 * it reads documentation that over-describes, or a type generated from that
 * documentation, or it guesses. It guesses more often than anyone admits: two
 * thirds of MCP tools declare no output schema at all, and even a maintained
 * OpenAPI description over-promises, because a specification describes the
 * union of every possible response while the caller receives exactly one.
 *
 * This answers from what interfaces were actually observed to return.
 *
 * THREE DESIGN RULES, EACH OF WHICH COSTS SOMETHING.
 *
 * It holds no generation logic. Everything served here is pre-computed in the
 * observatory and published as flat JSON. A client that generates is a client
 * that can generate differently from the record, and then two answers to one
 * question exist. This client fetches and formats; it never derives.
 *
 * It refuses rather than guesses. Asked about an interface with no record, it
 * says so and points at the tool that would observe one. An agent handed a
 * plausible shape it cannot distinguish from an observed one is worse off than
 * an agent told nothing, because it will proceed with confidence either way.
 *
 * Every answer carries its own evidence. How many observations, over what
 * period, and what the record structurally cannot see. An agent that knows a
 * type rests on four observations of a public endpoint can weigh it; one handed
 * a bare declaration cannot.
 *
 * Zero dependencies, including no MCP SDK. The protocol over stdio is
 * newline-delimited JSON-RPC, and implementing the four methods we need costs
 * less than asking every user to install a tree.
 */

const DEFAULT_BASE =
  'https://raw.githubusercontent.com/shiftgraph/observatory/main/data/contracts';

/** The protocol revisions this server knows how to speak. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'shiftgraph', version: '0.1.1' };

/**
 * `Connection: close`, deliberately.
 *
 * Node's fetch pools connections and holds each socket open for seconds after
 * the response. That is the right default for a long-running client and the
 * wrong one here: this process makes one or two requests and then has nothing
 * left to do, and a lingering socket meant exiting while libuv was still
 * closing a handle. On Windows that is not a quiet early exit, it is a hard
 * assertion:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c:76
 *
 * The response had already reached stdout, so a caller saw a correct answer
 * while the host saw the server crash. Closing the connection when we are done
 * with it removes the handle rather than racing it.
 *
 * Pooling buys nothing at this volume: the index is fetched once per process
 * and cached.
 */
const FETCH_OPTS = { headers: { connection: 'close' } };

/**
 * Fetched once per process and kept.
 *
 * The record moves every six hours and an agent session is minutes, so a
 * refetch inside one session would cost latency to observe a change that
 * almost certainly has not happened. A long-running host restarts often enough
 * to pick the record up.
 */
export function createStore({ base = DEFAULT_BASE, fetchImpl = fetch } = {}) {
  let indexPromise = null;
  const contracts = new Map();

  async function getIndex() {
    if (!indexPromise) {
      indexPromise = fetchImpl(`${base}/index.json`, FETCH_OPTS).then(async (res) => {
        if (!res.ok) throw new Error(`contract index unavailable (HTTP ${res.status})`);
        return res.json();
      });
    }
    return indexPromise;
  }

  async function getContract(id) {
    if (!contracts.has(id)) {
      const res = await fetchImpl(`${base}/${encodeURIComponent(id)}.json`, FETCH_OPTS);
      if (!res.ok) throw new Error(`no contract file for "${id}" (HTTP ${res.status})`);
      contracts.set(id, await res.json());
    }
    return contracts.get(id);
  }

  return { getIndex, getContract };
}

/**
 * Resolve what an agent typed to a contract we hold.
 *
 * Deliberately narrow. It matches an exact id, then host plus path, then host
 * alone when that host has exactly one contract. It does NOT fuzzy-match across
 * providers: returning "close enough" for an interface nobody asked about is
 * the failure mode this whole record exists to remove, and an agent cannot tell
 * a near-miss from a hit.
 */
export function resolveTarget(index, query) {
  const raw = String(query || '').trim();
  if (!raw) return { match: null, candidates: [] };

  const byId = index.contracts.find((c) => c.id === raw);
  if (byId) return { match: byId, candidates: [] };

  let host = null;
  let pathname = null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = url.host;
    pathname = url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    /* not a URL; fall through to the id-substring pass */
  }

  if (host) {
    const sameHost = index.contracts.filter((c) => c.host === host);
    if (sameHost.length) {
      const exact = sameHost.find((c) => (c.path || '').replace(/\/+$/, '') === pathname);
      if (exact) return { match: exact, candidates: [] };
      if (pathname === '/' && sameHost.length === 1) return { match: sameHost[0], candidates: [] };
      return { match: null, candidates: sameHost };
    }
  }

  const near = index.contracts.filter((c) => c.id.includes(raw) || raw.includes(c.provider));
  return { match: null, candidates: near.slice(0, 10) };
}

/** The limits that travel with every answer, so none is read as a guarantee. */
function limitsBlock(index) {
  return index.limits.map((l) => `- ${l}`).join('\n');
}

function describe(contract, entry, index) {
  const lines = [];
  lines.push(`# ${entry.method} ${entry.url}`);
  lines.push('');
  lines.push(
    `Observed ${entry.observations} time${entry.observations === 1 ? '' : 's'} across ` +
      `${entry.observed_days} day${entry.observed_days === 1 ? '' : 's'} ` +
      `(${entry.observed_from} to ${entry.observed_to}). ` +
      `${entry.fields} fields, ${entry.optional_fields} of them observed optional. ` +
      `Evidence: ${entry.confidence}.`,
  );
  lines.push('');

  if (contract.typescript) {
    lines.push('```typescript');
    lines.push(contract.typescript.trim());
    lines.push('```');
  } else {
    lines.push('No declaration is published for this endpoint.');
  }

  if (contract.notes?.length) {
    lines.push('');
    lines.push('## What this does not tell you');
    for (const n of contract.notes) lines.push(`- ${n}`);
  }

  lines.push('');
  lines.push('## Limits of the whole record');
  lines.push(limitsBlock(index));
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'lookup_contract',
    description:
      'What a public API endpoint was actually OBSERVED to return, as a TypeScript declaration, ' +
      'with how many observations support it and what the record cannot see. Use this before ' +
      'writing code against an interface, instead of inferring the response shape. Accepts a ' +
      'full URL, a host and path, or a ShiftGraph contract id. Answers "no record" rather than ' +
      'guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'A URL such as https://api.github.com/repos/facebook/react, or a host, or a contract id.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'list_contracts',
    description:
      'Every interface the public record covers, optionally filtered by provider or category. ' +
      'Use to find out whether a contract exists before looking one up.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider, for example "github".' },
        category: { type: 'string', description: 'Filter by category, for example "status-page".' },
      },
    },
  },
  {
    name: 'record_limits',
    description:
      'What this record is, how it is produced, and what it structurally cannot know. Read this ' +
      'before relying on any answer from it.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callTool(store, name, args = {}) {
  const index = await store.getIndex();

  if (name === 'record_limits') {
    return (
      `The ShiftGraph public contract record.\n\n` +
      `${index.watching.endpoints} public endpoints across ${index.watching.providers} providers ` +
      `in ${index.watching.categories} categories, swept every six hours. ` +
      `${index.published} have a published contract.\n\n` +
      `Each response is reduced to its structure at collection: field names, types, nesting, and ` +
      `whether a field is optional. Values are discarded and never stored. Optionality is earned ` +
      `rather than assumed: a field is marked optional only where the interface was watched ` +
      `omitting it.\n\n` +
      `## Limits\n${limitsBlock(index)}\n\n` +
      `The record and the instrument that produces it are public at ` +
      `https://github.com/shiftgraph/observatory`
    );
  }

  if (name === 'list_contracts') {
    let rows = index.contracts;
    if (args.provider) rows = rows.filter((c) => c.provider === args.provider);
    if (args.category) rows = rows.filter((c) => c.category === args.category);
    if (!rows.length) {
      const providers = [...new Set(index.contracts.map((c) => c.provider))].sort();
      return `No contract matches that filter.\n\nProviders in the record: ${providers.join(', ')}`;
    }
    const lines = rows.map(
      (c) =>
        `${c.id}  ${c.method} ${c.url}  (${c.observations} obs, ${c.fields} fields, ${c.confidence})`,
    );
    return `${rows.length} contract${rows.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`;
  }

  if (name === 'lookup_contract') {
    const { match, candidates } = resolveTarget(index, args.target);

    // The refusal path, and it is the important one. An agent that receives a
    // shape here cannot tell an observed one from an invented one, so the only
    // safe answer when we hold no record is to say so and name the tool that
    // would produce one.
    if (!match) {
      const near = candidates.length
        ? `\n\nThe record does cover these, which may or may not be what you meant:\n` +
          candidates.map((c) => `- ${c.id}  ${c.method} ${c.url}`).join('\n')
        : '';
      return (
        `No observed record for "${args.target}".\n\n` +
        `This record covers ${index.published} public, unauthenticated endpoints. It does not ` +
        `cover authenticated interfaces, private services, or anything not on its list, and it ` +
        `will not infer a shape it has not seen.\n\n` +
        `To observe this interface yourself right now:\n\n` +
        `    npx @shiftgraph/generate ${args.target}\n` +
        `${near}`
      );
    }

    const contract = await store.getContract(match.id);
    return describe(contract, match, index);
  }

  throw new Error(`unknown tool: ${name}`);
}

/** JSON-RPC dispatch. Returns a response object, or null for a notification. */
export async function handle(message, store) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  // A notification has no id and takes no response, ever. Answering one is a
  // protocol violation that some hosts treat as a fatal desync.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const toolName = params?.name;
      try {
        const text = await callTool(store, toolName, params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        // Reported as a tool result rather than a protocol error, which is what
        // the specification asks for: the model should see that the lookup
        // failed and why, not have the conversation torn down.
        return reply({
          content: [{ type: 'text', text: `Lookup failed: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export { TOOLS, SUPPORTED_PROTOCOLS, DEFAULT_BASE };
