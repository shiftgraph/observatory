// The MCP tool-contract observatory registry.
//
// Why this exists (Plan v2, Phase 0): the HTTP observatory watches public REST
// endpoints, which are the calmest surface on the internet. Eighteen sweeps of
// 63 of them produced zero confirmed contract drift, which is what a working
// detector looks like pointed at something that does not move.
//
// MCP tool contracts are the opposite surface. The protocol has no versioning,
// shipped a breaking change to its own specification, and carries two open
// proposals to add semantic versioning because it has none. Every tool a server
// exposes is an interface with a contract (`inputSchema`), and an agent that
// calls it with the wrong shape does not throw: it adapts, substitutes, or
// omits, and narrates a confident wrong answer.
//
// THE MEASUREMENT THIS EXISTS TO PRODUCE: how often do tool contracts actually
// change? That number decides whether the paid change-detection layer is worth
// selling. It is a pre-committed kill criterion, not a hoped-for result.
//
// Selection rules, matching the HTTP registry's discipline:
//   - Public packages only. No credentials, no private servers, nothing gated.
//   - Servers that start without secrets, or that fail honestly when they need
//     them. A server that refuses to start is recorded as unavailable, and that
//     is data rather than noise.
//   - Resolved at `latest`, deliberately: a user running `npx -y <pkg>` gets
//     latest, so latest is the contract real users actually experience. The
//     resolved version is recorded with every observation.
//
// SECURITY NOTE, read before running: this spawns third-party npm packages on
// the host. Every entry below is an official or first-party vendor package, and
// nothing here is community-submitted. Anything added later gets the same bar,
// or this becomes a supply-chain hole pointed at our own machine.

/**
 * command/args are passed to the runner as-is. `npx -y` resolves and executes
 * without a global install, which is exactly how these are documented to run.
 */

// ---------------------------------------------------------------------------
// STATE OF THIS COLLECTION, MEASURED 2026-07-26 (npm registry metadata, nothing
// executed). Read before adding entries or citing counts.
//
//   registered : 20
//   live       :  4  everything, filesystem, memory, sequential-thinking
//   deprecated : 11  github, gitlab, slack, postgres, brave-search, puppeteer,
//                    google-maps, aws-kb, redis, everart, gdrive
//   gone       :  5  sqlite, sentry, fetch, time, git (Python-only, never on npm)
//
// 80% of the official reference collection is deprecated or absent, and NOT ONE
// deprecation message names a successor: every one is npm's generic "Package no
// longer supported." server-github is deprecated at v2025.4.8 and still answers
// — we invoked three of its tools the day this was measured.
//
// That is contract drift in its most extreme form. The implementation was
// abandoned rather than changed, silently, while the tools kept working.
//
// THE CONSEQUENCE FOR ANYONE PLANNING WORK HERE: this collection is not a
// viable corpus of real third-party surfaces. The four live servers are a
// conformance harness, two local-state servers and local disk. Real MCP
// surfaces are first-party vendor servers, mostly remote and credentialed, and
// a read-only GitHub token only widens a DEPRECATED server from 3 tools to 14.
//
// Entries are kept rather than pruned: a deprecated server that still answers is
// a real observation, and "we looked and it is dying" is not the same row as
// "we never looked."
// ---------------------------------------------------------------------------
export const MCP_SERVERS = [
  // --- Official reference servers (modelcontextprotocol) ---
  {
    id: 'mcp-everything',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-everything',
    note: 'The protocol conformance server: exercises every MCP feature, so its tool set is the broadest single contract surface published.',
  },
  {
    id: 'mcp-filesystem',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-filesystem',
    // Filesystem needs an allowed directory or it exits; give it a harmless one.
    extraArgs: ['.'],
    note: 'The most widely installed MCP server in existence.',
  },
  {
    id: 'mcp-memory',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-memory',
    note: 'Knowledge-graph memory; a stable, frequently-used reference server.',
  },
  {
    id: 'mcp-sequential-thinking',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-sequential-thinking',
    note: 'Reasoning scaffold server.',
  },

  // --- First-party vendor servers ---
  {
    id: 'mcp-github',
    // Enhancing, not required: this server ran unauthenticated on 2026-07-26
    // and invoked 3 tools. A token widens what it can reach (14 read tools
    // instead of 3) but its absence must not skip the server, because we have
    // proof it works without one.
    envOptional: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    provider: 'github',
    category: 'dev-platform',
    pkg: '@modelcontextprotocol/server-github',
    note: 'GitHub tools. Historically the most-cited MCP integration.',
  },
  {
    id: 'mcp-gitlab',
    env: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    provider: 'gitlab',
    category: 'dev-platform',
    pkg: '@modelcontextprotocol/server-gitlab',
  },
  {
    id: 'mcp-slack',
    env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    provider: 'slack',
    category: 'saas',
    pkg: '@modelcontextprotocol/server-slack',
  },
  {
    id: 'mcp-postgres',
    provider: 'postgres',
    category: 'data',
    pkg: '@modelcontextprotocol/server-postgres',
    extraArgs: ['postgresql://localhost/postgres'],
  },
  {
    id: 'mcp-sqlite',
    provider: 'sqlite',
    category: 'data',
    pkg: '@modelcontextprotocol/server-sqlite',
  },
  {
    id: 'mcp-brave-search',
    env: ['BRAVE_API_KEY'],
    provider: 'brave',
    category: 'search',
    pkg: '@modelcontextprotocol/server-brave-search',
  },
  {
    id: 'mcp-puppeteer',
    provider: 'modelcontextprotocol',
    category: 'browser',
    pkg: '@modelcontextprotocol/server-puppeteer',
  },
  {
    id: 'mcp-google-maps',
    env: ['GOOGLE_MAPS_API_KEY'],
    provider: 'google',
    category: 'saas',
    pkg: '@modelcontextprotocol/server-google-maps',
  },
  {
    id: 'mcp-sentry',
    env: ['SENTRY_AUTH_TOKEN'],
    provider: 'sentry',
    category: 'observability',
    pkg: '@modelcontextprotocol/server-sentry',
  },
  {
    id: 'mcp-fetch',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-fetch',
  },
  {
    id: 'mcp-time',
    provider: 'modelcontextprotocol',
    category: 'reference',
    pkg: '@modelcontextprotocol/server-time',
  },
  {
    id: 'mcp-aws-kb',
    provider: 'aws',
    category: 'cloud',
    pkg: '@modelcontextprotocol/server-aws-kb-retrieval',
  },
  {
    id: 'mcp-redis',
    provider: 'redis',
    category: 'data',
    pkg: '@modelcontextprotocol/server-redis',
  },
  {
    id: 'mcp-everart',
    env: ['EVERART_API_KEY'],
    provider: 'everart',
    category: 'media',
    pkg: '@modelcontextprotocol/server-everart',
  },
  {
    id: 'mcp-gdrive',
    env: ['GDRIVE_CREDENTIALS_PATH'],
    provider: 'google',
    category: 'saas',
    pkg: '@modelcontextprotocol/server-gdrive',
  },
  {
    id: 'mcp-sequential-git',
    provider: 'git',
    category: 'dev-platform',
    pkg: '@modelcontextprotocol/server-git',
  },
];

export const MCP_REGISTRY_META = {
  total: MCP_SERVERS.length,
  providers: [...new Set(MCP_SERVERS.map((s) => s.provider))].length,
  categories: [...new Set(MCP_SERVERS.map((s) => s.category))].length,
};
