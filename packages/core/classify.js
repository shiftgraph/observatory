// classify.js
// Classifies each observation by request KIND and by first-party vs third-party ORIGIN.
//
// Why this exists: the whole product is about THIRD-PARTY dependency drift. The previous
// engine treated the site you are on, its static assets, and a real external API identically,
// which is the root cause of the rehearsal-001 false positives (unlike requests merged, then
// their natural differences read as "drift"). Here we cleanly separate:
//   - origin: first-party (your own app) vs third-party (an external dependency)
//   - kind:   api | graphql | rpc | tool | asset | image | page | telemetry | other
// Only THIRD-PARTY api/graphql/rpc/tool operations are ever analyzed for drift. Everything
// else is kept as context and can never produce a drift claim.

const TELEMETRY_HINT = /(collector\.|\/collect\b|analytics|telemetry|beacon|ingest\.sentry|sentry_key|google-analytics|googletagmanager|\bsegment\.|amplitude|mixpanel|datadoghq|nr-data|newrelic|clarity\.ms|hotjar|fullstory|posthog|doubleclick)/i;
const ASSET_PATH = /(?:^|\/)(?:assets|static|_next\/static|_nuxt|dist|build|cdn|chunks)\//i;
const ASSET_EXT = /\.(?:js|mjs|cjs|css|map|woff2?|ttf|otf|eot|svg|ico)(?:\?|#|$)/i;
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|mp3|wav|pdf)(?:\?|#|$)/i;
const API_PATH = /(?:^|\/)(?:api|rest|rpc|graphql|gql|v\d+|gateway|webhooks?)(?:\/|$)/i;
// The same signal in the HOST, which is where most APIs actually put it.
//
// Backlog Issue 2: a JSON API served at a bare resource path was classified
// `other` and dropped from the dependency set, producing a misleading "no
// third-party dependencies" result. The usual signal is the content-type and the
// adapters now carry it, but a capture that omits one still fell through - and
// the canonical example is the endpoint this project quotes constantly:
// api.github.com/repos/{owner}/{repo} has "api" in the host, not the path.
//
// Deliberately narrow: a host LABEL equal to api, apis or rest. Not a substring,
// so googleapis.com and rapidapi.com do not match, and the rule fails toward
// `other` rather than sweeping in hosts that merely contain the letters. Any
// widening here adds dependencies to a customer's quota, so narrow is the safe
// direction to be wrong in.
const API_HOST = /(?:^|\.)(?:api|apis|rest)(?:\.|$)/i;

export function requestKind(obs) {
  const rct = String(obs.response_content_type || '').toLowerCase();
  const qct = String(obs.request_content_type || '').toLowerCase();
  const path = String(obs.path_raw || obs.path_template || '').toLowerCase();
  const host = String(obs.host_display || '').toLowerCase();
  const method = String(obs.method || 'GET').toUpperCase();

  if (obs.transport && obs.transport !== 'http') {
    // mcp / grpc / other rpc-ish transports are dependency operations by construction.
    return obs.transport === 'mcp' ? 'tool' : 'rpc';
  }
  if (TELEMETRY_HINT.test(`${host}${path}`)) return 'telemetry';
  if (obs.graphql_op || path.includes('graphql') || path.includes('/gql')) return 'graphql';
  if (ASSET_PATH.test(path) || ASSET_EXT.test(path) || /(javascript|ecmascript|text\/css|font\/|application\/font|application\/octet-stream)/.test(rct)) return 'asset';
  if (/^image\//.test(rct) || /^(?:video|audio)\//.test(rct) || MEDIA_EXT.test(path)) return 'image';
  if (/text\/html/.test(rct)) return 'page';
  if (/json/.test(rct) || /json/.test(qct) || API_PATH.test(path) || API_HOST.test(host) || method !== 'GET') return 'api';
  return 'other';
}

export function isDependencyKind(kind) {
  return kind === 'api' || kind === 'graphql' || kind === 'rpc' || kind === 'tool';
}

// Extract a GraphQL operation name from a RAW request body. operationName and top-level field
// names are schema-level identifiers, not user data, so this is safe pre-redaction and is
// essential: without it, every distinct GraphQL query collapses into one POST /graphql bucket.
export function extractGraphqlOp(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') return null;
  const body = Array.isArray(requestBody) ? requestBody[0] : requestBody;
  if (!body || typeof body !== 'object') return null;
  if (typeof body.operationName === 'string' && body.operationName.trim()) return body.operationName.trim();
  if (typeof body.query === 'string') {
    const named = body.query.match(/\b(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
    if (named) return named[1];
    const first = body.query.match(/\{\s*([A-Za-z0-9_]+)/);
    if (first) return `anon:${first[1]}`;
  }
  return null;
}

// Resolve first-party host(s). Priority: explicit --origin; else hosts that serve HTML
// documents (the app you are actually on); else the single most-frequent host.
export function resolveFirstPartyHosts(observations, { origin } = {}) {
  const set = new Set();
  if (origin) {
    for (const raw of String(origin).split(',')) {
      const h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
      if (h) set.add(h);
    }
    return set;
  }
  // Infer first-party ONLY from actual HTML-document hosts (the browser case: the app you are on
  // and its same-site API). For backend/OTel captures there is no document and every observed
  // host is an outbound dependency, so we return an empty set rather than guessing (guessing the
  // most-frequent host as first-party would wrongly exclude a heavily-used external API). Users
  // can always override with --origin.
  const pageHosts = new Map();
  for (const obs of observations) {
    if (obs.kind === 'page') pageHosts.set(obs.host_display, (pageHosts.get(obs.host_display) || 0) + 1);
  }
  for (const [h] of pageHosts) set.add(h);
  return set;
}

// Two hosts are first-party to each other if they share a registrable domain. This keeps
// api.myapp.com classified as first-party when the page is myapp.com.
export function isFirstParty(host, firstPartyHosts) {
  if (!host) return false;
  if (firstPartyHosts.has(host)) return true;
  for (const fp of firstPartyHosts) if (sameSite(host, fp)) return true;
  return false;
}

export function sameSite(hostA, hostB) {
  if (!hostA || !hostB) return false;
  if (hostA === hostB) return true;
  const a = registrableDomain(hostA), b = registrableDomain(hostB);
  return Boolean(a) && a === b;
}

// M0 heuristic: last two labels. Good enough for the common .com/.io/.dev cases; multi-part
// public suffixes (.co.uk) are a known limitation and are documented as such.
function registrableDomain(host) {
  const parts = String(host).split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}
