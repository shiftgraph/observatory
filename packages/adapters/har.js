import { readText, safeParseJson, normalizeDate } from '../core/utils.js';
import { makeEvidence, normalizeObservation } from './common.js';

export const name = 'har';

export async function parseFile(filePath, options = {}) {
  const parsed = safeParseJson(await readText(filePath), filePath);
  if (!parsed.ok) throw new Error(parsed.error);
  const entries = parsed.value?.log?.entries || [];
  return entries.map((entry, i) => {
    const request = entry.request || {};
    const response = entry.response || {};
    const requestHeaders = headersToObject(request.headers);
    const responseHeaders = headersToObject(response.headers);
    const responseBody = parseContent(response.content);
    const requestBody = request.postData?.text ? parseMaybeJson(request.postData.text) : undefined;
    const observedAt = normalizeDate(entry.startedDateTime);
    const obs = normalizeObservation({
      observed_at: observedAt,
      method: request.method,
      url: request.url,
      status_code: response.status,
      duration_ms: entry.time,
      request_content_type: request.postData?.mimeType || headerValue(requestHeaders, 'content-type'),
      response_content_type: response.content?.mimeType || headerValue(responseHeaders, 'content-type'),
      request_body: requestBody,
      response_body: responseBody,
      headers: requestHeaders,
      response_headers: responseHeaders,
      redactionMode: options.redactionMode
    });
    return {
      evidence: makeEvidence({ sourcePath: filePath, locator: `entry:${i + 1}`, observedAt, adapter: name, confidence: 0.95, notes: {} }),
      observation: obs
    };
  });
}

function parseContent(content) {
  if (!content?.text) return undefined;
  if (content.mimeType && !/json|javascript|text/i.test(content.mimeType)) return { content_type: content.mimeType, body_redacted: true };
  return parseMaybeJson(content.text);
}

function parseMaybeJson(value) {
  const parsed = safeParseJson(value, 'har-content');
  return parsed.ok ? parsed.value : { message: String(value).slice(0, 200) };
}

function headersToObject(headers = []) {
  const out = {};
  for (const h of headers) out[h.name] = h.value;
  return out;
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === target) return v;
  return null;
}
