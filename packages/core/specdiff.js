// specdiff.js
// Spec-vs-reality: compare a provider's PUBLISHED OpenAPI schema against how its API
// actually behaves (the live structural profile the engine reconstructs). Catches
// "the docs are wrong" from a SINGLE capture, no time-to-pass required:
//   - undocumented fields the API returns but the spec never mentions (the risky ones
//     agents and integrators do not know about),
//   - documented fields the spec promises but the live response does not deliver,
//   - type mismatches between spec and reality.
//
// It reuses the engine's own structural diff, so it inherits the same contract-not-data
// discipline (value buckets and wildcard leaves are ignored).

import { structuralDiff } from './shape.js';

// Convert an OpenAPI / JSON-Schema node into the engine's profile shape
// ({type:'object',keys}, {type:'array',element}, {type:'string'|'integer'|'float'|'boolean'|'null'|'union'}).
export function schemaToProfile(schema, spec, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || depth > 16) return { type: 'unknown' };
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { type: 'unknown' };
    const resolved = resolveRef(schema.$ref, spec);
    if (!resolved) return { type: 'unknown' };
    return schemaToProfile(resolved, spec, depth + 1, new Set(seen).add(schema.$ref));
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: 'object', properties: {} };
    for (const s of schema.allOf) {
      const r = s && s.$ref ? resolveRef(s.$ref, spec) : s;
      if (r && r.properties) Object.assign(merged.properties, r.properties);
    }
    return schemaToProfile(merged, spec, depth + 1, seen);
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const variants = (schema.oneOf || schema.anyOf).map(s => schemaToProfile(s, spec, depth + 1, seen).type);
    return { type: 'union', variants: [...new Set(variants)].sort() };
  }
  const t = Array.isArray(schema.type) ? (schema.type.find(x => x !== 'null') || schema.type[0]) : schema.type;
  if (t === 'object' || schema.properties) {
    const keys = {};
    for (const [k, v] of Object.entries(schema.properties || {})) keys[k] = schemaToProfile(v, spec, depth + 1, seen);
    return { type: 'object', keys };
  }
  if (t === 'array') return { type: 'array', element: schemaToProfile(schema.items || {}, spec, depth + 1, seen) };
  if (t === 'integer') return { type: 'integer' };
  if (t === 'number') return { type: 'float' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'string') return { type: 'string' };
  if (t === 'null') return { type: 'null' };
  return { type: 'unknown' };
}

function resolveRef(ref, spec) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node && node[key];
    if (node === undefined) return null;
  }
  return node || null;
}

// Resolve the success (2xx) JSON response schema for one endpoint, OAS3 or OAS2.
export function resolveEndpointSchema(spec, method, pathTemplate, status = '200') {
  const op = spec?.paths?.[pathTemplate]?.[String(method).toLowerCase()];
  if (!op || !op.responses) return null;
  const resp = op.responses[status] || op.responses['200'] || op.responses['201'] || op.responses.default
    || op.responses[Object.keys(op.responses).find(c => /^2\d\d$/.test(c)) || ''];
  if (!resp) return null;
  const schema = resp.content?.['application/json']?.schema      // OpenAPI 3
    || resp.schema;                                              // OpenAPI 2
  return schema ? schemaToProfile(schema, spec) : null;
}

// List every (method, path) operation declared in the spec.
export function listSpecOperations(spec) {
  const ops = [];
  for (const [p, item] of Object.entries(spec?.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (item[m]) ops.push({ method: m.toUpperCase(), path: p, segments: p.split('/').filter(Boolean) });
    }
  }
  return ops;
}

function isParam(seg) { return seg.startsWith('{') && seg.endsWith('}'); }
function segMatch(specSeg, liveSeg) {
  // A spec path parameter matches any live segment; our own template tokens
  // ({int},{uuid},{token},...) match any spec segment. Otherwise, literal match.
  if (isParam(specSeg) || isParam(liveSeg)) return true;
  return specSeg.toLowerCase() === liveSeg.toLowerCase();
}

// Match a live operation (method + templated route) to the best spec operation.
// "Best" = same method, same segment count, all segments compatible, most literal
// (non-parameter) matches. Returns the spec op or null.
export function matchSpecOperation(spec, method, liveRoute) {
  const liveSegs = String(liveRoute || '').split('/').filter(Boolean);
  let best = null, bestScore = -1;
  for (const op of listSpecOperations(spec)) {
    if (op.method !== String(method || '').toUpperCase()) continue;
    if (op.segments.length !== liveSegs.length) continue;
    let ok = true, literal = 0;
    for (let i = 0; i < op.segments.length; i++) {
      if (!segMatch(op.segments[i], liveSegs[i])) { ok = false; break; }
      if (!isParam(op.segments[i]) && !isParam(liveSegs[i])) literal++;
    }
    if (ok && literal > bestScore) { best = op; bestScore = literal; }
  }
  return best;
}

// Compare a spec-derived profile (before) against the live profile (after).
export function specVsReality(specProfile, liveProfile) {
  const diffs = structuralDiff(specProfile, liveProfile);
  return {
    undocumented: diffs.filter(d => d.type === 'field_added').map(d => d.path),            // live returns, spec omits
    documented_but_absent: diffs.filter(d => d.type === 'field_removed').map(d => d.path), // spec promises, live omits
    type_mismatches: diffs.filter(d => d.type === 'type_changed').map(d => ({ path: d.path, spec: d.before, live: d.after })),
    matches: diffs.length === 0
  };
}
