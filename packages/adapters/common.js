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

/**
 * A NON-2xx BODY IS NEVER THE CONTRACT.
 *
 * The one place every adapter and the hosted ingest both pass through, which is
 * why the rule belongs here rather than in six readers.
 *
 * `@shiftgraph/generate` has refused error responses since its first version:
 * "types from an error response would describe the error, not the contract."
 * Nothing downstream of here had that rule. On 2026-07-29T18:58Z the public
 * observatory swept while rate-limited, six GitHub endpoints answered
 * `{message, documentation_url}` with a 403 and a content-type of
 * application/json, and the engine profiled the rate-limit page as the new
 * dominant shape: six BREAKING events, `$.avatar_url` removed, `$.body`
 * removed, the licences array becoming an object. Nothing at GitHub had
 * changed. Those six reached the published record.
 *
 * The body is moved to `error_body` rather than discarded, so the status
 * distribution, the error rate and the evidence still see everything that
 * arrived. Only the CONTRACT stops being derived from a failure.
 *
 * A 3xx is excluded too: a redirect body is a courtesy page, not a payload.
 */
function contractBearing(status) {
  return status === null || (status >= 200 && status < 300);
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
  const statusCode = numberOrNull(input.status_code ?? input.status);
  const rawResponseBody = input.response_body ?? input.response;
  const keepsContract = contractBearing(statusCode);
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
    status_code: statusCode,
    duration_ms: numberOrNull(input.duration_ms ?? input.latency_ms ?? input.duration),
    request_content_type: cleanContentType(input.request_content_type),
    response_content_type: cleanContentType(input.response_content_type),
    request_body: input.request_body ?? input.request,
    response_body: keepsContract ? rawResponseBody : undefined,
    error_body: input.error_body ?? input.error ?? (keepsContract ? undefined : rawResponseBody),
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
