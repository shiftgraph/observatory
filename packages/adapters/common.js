import { normalizeDate } from '../core/utils.js';
import { parseHttpTarget } from '../core/url.js';

export function makeEvidence({ sourcePath, locator, observedAt, adapter, confidence = 1, notes = {} }) {
  return {
    id: null,
    source_path: sourcePath,
    source_locator: locator,
    observed_at: normalizeDate(observedAt),
    adapter,
    extraction_confidence: confidence,
    notes
  };
}

export function normalizeObservation(input) {
  const isHttp = !input.transport || input.transport === 'http';
  const target = isHttp
    ? parseHttpTarget({ url: input.url, host: input.host, path: input.path, route: input.route, method: input.method, redactionMode: input.redactionMode })
    : {
        transport: input.transport,
        direction: input.direction || 'outbound',
        method: input.method ? String(input.method) : 'UNKNOWN',
        hostDisplay: input.host_display || input.host || 'unknown-host',
        hostHash: input.host_hash || '',
        pathTemplate: input.path_template || input.path || '/',
        pathRaw: input.path_raw || input.path || '/',
        queryKeys: []
      };
  return {
    observed_at: normalizeDate(input.observed_at || input.timestamp),
    transport: target.transport,
    direction: input.direction || target.direction,
    method: target.method,
    host_display: target.hostDisplay,
    host_hash: target.hostHash,
    path_template: target.pathTemplate,
    path_raw: target.pathRaw,
    query_keys: target.queryKeys || [],
    status_code: numberOrNull(input.status_code ?? input.status),
    duration_ms: numberOrNull(input.duration_ms ?? input.latency_ms ?? input.duration),
    request_content_type: cleanContentType(input.request_content_type),
    response_content_type: cleanContentType(input.response_content_type),
    request_body: input.request_body ?? input.request,
    response_body: input.response_body ?? input.response,
    error_body: input.error_body ?? input.error,
    headers: input.headers,
    response_headers: input.response_headers,
    extraction_confidence: input.extraction_confidence ?? 1
  };
}

function cleanContentType(value) {
  if (!value) return null;
  return String(value).split(';')[0].trim().toLowerCase() || null;
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
