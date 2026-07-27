// operation.js
// Variance-aware canonical operation identity. The core fix for overgrouping: identity is
// discriminated by KIND, and for graphql/rpc/tool by the operation NAME, so distinct GraphQL
// queries and distinct resource kinds never merge. Assets / images / pages / telemetry get a
// COARSE identity (host + kind + extension) and are excluded from drift analysis upstream, so
// they can never manufacture a false "operation" or a false transition.
import { hashObject } from './utils.js';

export function canonicalOperationIdentity(obs) {
  const kind = obs.kind || 'other';
  const base = {
    v: 2,
    transport: obs.transport || 'http',
    direction: obs.direction || 'outbound',
    host: obs.host_display || 'unknown-host',
    kind
  };
  let identity;
  if (kind === 'graphql') {
    identity = { ...base, method: (obs.method || 'POST').toUpperCase(), op: obs.graphql_op || 'graphql:unnamed' };
  } else if (kind === 'api' || kind === 'rpc' || kind === 'tool') {
    identity = { ...base, method: (obs.method || 'GET').toUpperCase(), route: obs.path_template || '/' };
  } else {
    // asset / image / page / telemetry / other: coarse, never drift-analyzed.
    identity = { ...base, group: coarseGroup(obs) };
  }
  return { identity, coi_hash: `coi:${hashObject(identity)}` };
}

function coarseGroup(obs) {
  const raw = String(obs.path_raw || obs.path_template || '');
  const ext = (raw.match(/\.([a-z0-9]{1,5})(?:\?|#|$)/i) || [null, ''])[1].toLowerCase();
  return ext ? `ext:${ext}` : `kind:${obs.kind || 'other'}`;
}

export function displayOperation(identity) {
  if (identity.kind === 'graphql') return `GraphQL ${identity.host} ${identity.op}`;
  if (identity.route) return `${identity.method} ${identity.host} ${identity.route}`;
  return `${identity.kind} ${identity.host} ${identity.group || ''}`.trim();
}
