import { promises as fs } from 'node:fs';
import { durationMsFromNano, normalizeDate } from '../core/utils.js';
import { makeEvidence, normalizeObservation, numberOrNull } from './common.js';
import { decodeMessage, str, hex, double, bool, first, all } from './protobuf-wire.js';

export const name = 'otlp-proto';

export async function parseFile(filePath, options = {}) {
  const buf = await fs.readFile(filePath);
  const spans = extractExportTraceServiceRequest(buf);
  return spans.map((span, i) => spanToRecord(span, filePath, `proto-span:${i + 1}`, options)).filter(Boolean);
}

function extractExportTraceServiceRequest(buf) {
  const root = decodeMessage(buf);
  const resourceSpans = all(root, 1).filter(f => f.wire === 2).flatMap(f => decodeResourceSpans(f.value));
  if (resourceSpans.length) return resourceSpans;
  // Fallback: some test fixtures store ResourceSpans directly.
  return decodeResourceSpans(buf);
}

function decodeResourceSpans(buf) {
  const msg = decodeMessage(buf);
  return all(msg, 2).flatMap(f => decodeScopeSpans(f.value));
}

function decodeScopeSpans(buf) {
  const msg = decodeMessage(buf);
  return all(msg, 2).map(f => decodeSpan(f.value));
}

function decodeSpan(buf) {
  const msg = decodeMessage(buf);
  const attrs = {};
  for (const f of all(msg, 9)) {
    const kv = decodeKeyValue(f.value);
    if (kv.key) attrs[kv.key] = kv.value;
  }
  return {
    traceId: firstStringBytes(msg, 1),
    spanId: firstStringBytes(msg, 2),
    name: firstText(msg, 5),
    kind: firstInt(msg, 6),
    startTimeUnixNano: firstBigint(msg, 7),
    endTimeUnixNano: firstBigint(msg, 8),
    attributes: attrs,
    status: first(msg, 15) ? decodeMessage(first(msg, 15).value) : null
  };
}

function decodeKeyValue(buf) {
  const msg = decodeMessage(buf);
  const key = firstText(msg, 1);
  const valueField = first(msg, 2);
  return { key, value: valueField ? decodeAnyValue(valueField.value) : null };
}

function decodeAnyValue(buf) {
  const msg = decodeMessage(buf);
  const s = first(msg, 1); if (s) return str(s.value);
  const b = first(msg, 2); if (b) return bool(b.value);
  const i = first(msg, 3); if (i) return Number(i.value);
  const d = first(msg, 4); if (d) return double(d.value);
  const arr = first(msg, 5); if (arr) return all(decodeMessage(arr.value), 1).map(v => decodeAnyValue(v.value));
  const kvl = first(msg, 6); if (kvl) {
    const out = {};
    for (const kvField of all(decodeMessage(kvl.value), 1)) {
      const kv = decodeKeyValue(kvField.value);
      out[kv.key] = kv.value;
    }
    return out;
  }
  const by = first(msg, 7); if (by) return `bytes:${hex(by.value).slice(0, 32)}`;
  return null;
}

function spanToRecord(span, sourcePath, locator, options) {
  const attrs = span.attributes || {};
  const method = pick(attrs, ['http.request.method', 'http.method', 'rpc.method', 'method']);
  const url = pick(attrs, ['url.full', 'http.url', 'http.target_url', 'http.request.url', 'url']);
  const route = pick(attrs, ['http.route', 'url.template']);
  const host = pick(attrs, ['server.address', 'net.peer.name', 'http.host', 'peer.service', 'host']);
  const path = pick(attrs, ['url.path', 'http.target', 'http.path', 'path']);
  const status = pick(attrs, ['http.response.status_code', 'http.status_code', 'status_code', 'status']);
  const duration = numberOrNull(pick(attrs, ['duration_ms', 'http.duration_ms', 'latency_ms'])) ?? durationMsFromNano(span.startTimeUnixNano, span.endTimeUnixNano);
  const observedAt = normalizeDate(span.startTimeUnixNano);
  const obs = normalizeObservation({
    observed_at: observedAt,
    method, url, route, host, path,
    status_code: status,
    duration_ms: duration,
    request_body: parseMaybeJson(pick(attrs, ['shiftgraph.request.body', 'http.request.body', 'request.body', 'request_body'])),
    response_body: parseMaybeJson(pick(attrs, ['shiftgraph.response.body', 'http.response.body', 'response.body', 'response_body'])),
    error_body: parseMaybeJson(pick(attrs, ['shiftgraph.error.body', 'exception.message', 'error', 'error.body'])),
    redactionMode: options.redactionMode
  });
  if (!method && !url && !host && !path) return null;
  return {
    evidence: makeEvidence({ sourcePath, locator, observedAt, adapter: name, confidence: 0.86, notes: { trace_id: span.traceId, span_id: span.spanId, span_name: span.name } }),
    observation: obs
  };
}

function pick(obj, keys) { for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]; return null; }
function parseMaybeJson(value) { if (value === null || value === undefined || value === '') return undefined; if (typeof value === 'object') return value; try { return JSON.parse(String(value)); } catch { return { message: String(value) }; } }
function firstText(fields, n) { const f = first(fields, n); return f && f.wire === 2 ? str(f.value) : null; }
function firstStringBytes(fields, n) { const f = first(fields, n); return f && f.wire === 2 ? hex(f.value) : null; }
function firstInt(fields, n) { const f = first(fields, n); return f ? Number(f.value) : null; }
function firstBigint(fields, n) { const f = first(fields, n); return f ? f.value : null; }
