import { readText, safeParseJson } from '../core/utils.js';
import { makeEvidence, normalizeObservation } from './common.js';

export const name = 'ndjson';

export async function parseFile(filePath, options = {}) {
  const text = await readText(filePath);
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = safeParseJson(line, `${filePath}:${i + 1}`);
    if (!parsed.ok) continue;
    const row = parsed.value;
    const observedAt = get(row, ['time', 'timestamp', '@timestamp', 'observed_at', 'date']);
    const method = get(row, ['method', 'http.method', 'http_request_method']) || row.http?.method || row.request?.method;
    const url = get(row, ['url', 'http.url', 'request.url']) || row.http?.url || row.request?.url;
    const host = get(row, ['host', 'server.address', 'hostname']) || row.http?.host || row.request?.host;
    const path = get(row, ['path', 'url.path', 'request.path']) || row.http?.path || row.request?.path;
    const status = get(row, ['status', 'status_code', 'statusCode', 'http.status_code']) || row.response?.status;
    const duration = get(row, ['duration_ms', 'latency_ms', 'durationMs', 'elapsed_ms']) || row.duration?.ms;
    const requestHeaders = row.headers || row.request?.headers;
    const responseHeaders = row.response_headers || row.response?.headers;
    const obs = normalizeObservation({
      observed_at: observedAt,
      method, url, host, path,
      status_code: status,
      duration_ms: duration,
      // Carry content-type through so a JSON API served at a bare resource path
      // (e.g. GitHub /repos/{o}/{r}) classifies as an `api` dependency rather than
      // `other`. Explicit field first, else derive from a captured header. The
      // OTel adapter already does this; NDJSON previously did not (backlog Issue 3).
      request_content_type: row.request_content_type || headerValue(requestHeaders, 'content-type'),
      response_content_type: row.response_content_type || headerValue(responseHeaders, 'content-type'),
      request_body: row.request_body || row.request?.body,
      response_body: row.response_body || row.response?.body,
      error_body: row.error_body || row.error,
      headers: requestHeaders,
      response_headers: responseHeaders,
      redactionMode: options.redactionMode
    });
    const degraded = [];
    if (!method) degraded.push('missing method');
    if (!url && !host && !path) degraded.push('missing url/host/path');
    records.push({
      evidence: makeEvidence({ sourcePath: filePath, locator: `line:${i + 1}`, observedAt, adapter: name, confidence: Math.max(0.25, 1 - degraded.length * 0.2), notes: { degraded } }),
      observation: obs
    });
  }
  return records;
}

function get(obj, keys) {
  for (const key of keys) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur = obj;
      for (const p of parts) cur = cur?.[p];
      if (cur !== undefined && cur !== null && cur !== '') return cur;
    } else if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

// Case-insensitive header lookup. Accepts either a plain object ({name: value})
// or a HAR-style array ([{name, value}]); NDJSON captures use either.
function headerValue(headers, name) {
  if (!headers) return null;
  const target = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers) if (h && String(h.name).toLowerCase() === target) return h.value;
    return null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === target) return v;
  return null;
}
