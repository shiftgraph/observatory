import { readText, safeParseJson, durationMsFromNano, normalizeDate } from '../core/utils.js';
import { makeEvidence, normalizeObservation, numberOrNull } from './common.js';

export const name = 'otel-json';

export async function parseFile(filePath, options = {}) {
  const text = await readText(filePath);
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rows = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = safeParseJson(trimmed, filePath);
    if (parsed.ok) {
      rows.push(...extractSpans(parsed.value).map((span, i) => ({ span, locator: `json:${i + 1}` })));
    } else {
      rows.push(...parseLines(text, filePath));
    }
  } else {
    rows.push(...parseLines(text, filePath));
  }
  return rows.map(({ span, locator }) => spanToRecord(span, filePath, locator, options)).filter(Boolean);
}

function parseLines(text, filePath) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = safeParseJson(line, `${filePath}:${i + 1}`);
    if (!parsed.ok) continue;
    const spans = extractSpans(parsed.value);
    for (let j = 0; j < spans.length; j++) rows.push({ span: spans[j], locator: `line:${i + 1}${spans.length > 1 ? `/${j + 1}` : ''}` });
  }
  return rows;
}

function extractSpans(value) {
  if (Array.isArray(value)) return value.flatMap(extractSpans);
  if (!value || typeof value !== 'object') return [];
  if (value.resourceSpans) {
    return value.resourceSpans.flatMap(rs => (rs.scopeSpans || rs.instrumentationLibrarySpans || []).flatMap(ss => ss.spans || []));
  }
  if (value.scopeSpans) return value.scopeSpans.flatMap(ss => ss.spans || []);
  if (Array.isArray(value.spans)) return value.spans;
  if (value.traceId || value.spanId || value.attributes || value.name) return [value];
  return [];
}

function spanToRecord(span, sourcePath, locator, options) {
  const attrs = normalizeAttrs(span.attributes || {});
  const method = pick(attrs, ['http.request.method', 'http.method', 'rpc.method', 'method']);
  const url = pick(attrs, ['url.full', 'http.url', 'http.target_url', 'http.request.url', 'url']);
  const route = pick(attrs, ['http.route', 'url.template']);
  const host = pick(attrs, ['server.address', 'net.peer.name', 'http.host', 'peer.service', 'host']);
  const path = pick(attrs, ['url.path', 'http.target', 'http.path', 'path']);
  const status = pick(attrs, ['http.response.status_code', 'http.status_code', 'status_code', 'status']);
  const duration = numberOrNull(pick(attrs, ['duration_ms', 'http.duration_ms', 'latency_ms'])) ?? durationMsFromNano(span.startTimeUnixNano, span.endTimeUnixNano);
  const observedAt = normalizeDate(span.startTimeUnixNano ? Number(BigInt(span.startTimeUnixNano) / 1000000n) : span.start_time || span.timestamp || attrs.time || attrs.timestamp);
  const requestBody = parseMaybeJson(pick(attrs, ['shiftgraph.request.body', 'http.request.body', 'request.body', 'request_body']));
  const responseBody = parseMaybeJson(pick(attrs, ['shiftgraph.response.body', 'http.response.body', 'response.body', 'response_body']));
  const errorBody = parseMaybeJson(pick(attrs, ['shiftgraph.error.body', 'exception.message', 'error', 'error.body']));
  const requestContentType = pick(attrs, ['http.request.header.content-type', 'http.request.header.content_type', 'request.content_type']);
  const responseContentType = pick(attrs, ['http.response.header.content-type', 'http.response.header.content_type', 'response.content_type']);
  const confidenceMissing = [];
  if (!method) confidenceMissing.push('missing method');
  if (!url && !host && !path) confidenceMissing.push('missing url/host/path');
  if (!observedAt) confidenceMissing.push('missing timestamp');
  const confidence = Math.max(0.25, 1 - confidenceMissing.length * 0.2);
  if (!method && !url && !host && !path) return null;
  const obs = normalizeObservation({
    observed_at: observedAt,
    method,
    url,
    route,
    host,
    path,
    status_code: status,
    duration_ms: duration,
    request_content_type: requestContentType,
    response_content_type: responseContentType,
    request_body: requestBody,
    response_body: responseBody,
    error_body: errorBody,
    redactionMode: options.redactionMode
  });
  return {
    evidence: makeEvidence({ sourcePath, locator, observedAt, adapter: name, confidence, notes: { trace_id: span.traceId, span_id: span.spanId, degraded: confidenceMissing } }),
    observation: obs
  };
}

function normalizeAttrs(attrs) {
  if (Array.isArray(attrs)) {
    const out = {};
    for (const attr of attrs) out[attr.key] = unwrapOtelValue(attr.value);
    return out;
  }
  return attrs;
}

function unwrapOtelValue(value) {
  if (value && typeof value === 'object') {
    for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (k in value) return value[k];
    if ('arrayValue' in value) return value.arrayValue.values?.map(unwrapOtelValue) || [];
    if ('kvlistValue' in value) return normalizeAttrs(value.kvlistValue.values || []);
  }
  return value;
}

function pick(obj, keys) {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  return null;
}

function parseMaybeJson(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object') return value;
  const s = String(value);
  const parsed = safeParseJson(s, 'attribute-json');
  return parsed.ok ? parsed.value : { message: s };
}
