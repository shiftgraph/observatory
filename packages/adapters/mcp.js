import { readText, safeParseJson, normalizeDate, sha256 } from '../core/utils.js';
import { makeEvidence, normalizeObservation } from './common.js';

export const name = 'mcp-jsonrpc';

export async function parseFile(filePath, options = {}) {
  const text = await readText(filePath);
  const entries = parseJsonish(text, filePath);
  const byId = new Map();
  const records = [];
  for (let i = 0; i < entries.length; i++) {
    const { value, locator } = entries[i];
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      const msg = unwrap(row);
      if (!msg || typeof msg !== 'object') continue;
      const ts = normalizeDate(row.timestamp || row.time || msg.timestamp || msg.time || msg.params?._timestamp);
      if (msg.method === 'tools/call') {
        const id = stableId(msg.id, locator, i);
        byId.set(id, { request: msg, row, locator, observedAt: ts });
        const inlineResult = row.result || msg.result || row.response?.result;
        if (inlineResult !== undefined || row.error || msg.error) records.push(recordFromCall({ request: msg, result: inlineResult, row, locator, filePath, observedAt: ts, options }));
      } else if (msg.result !== undefined && msg.id !== undefined && byId.has(String(msg.id))) {
        const pending = byId.get(String(msg.id));
        records.push(recordFromCall({ request: pending.request, result: msg.result, row: pending.row, responseRow: row, locator: `${pending.locator}+${locator}`, filePath, observedAt: pending.observedAt || ts, options }));
      } else if (msg.method === 'tools/list' || msg.result?.tools || row.result?.tools || row.tools) {
        records.push(...recordsFromToolList({ msg, row, locator, filePath, observedAt: ts, options }));
      }
    }
  }
  return records.filter(Boolean);
}

function recordFromCall({ request, result, row, responseRow, locator, filePath, observedAt, options }) {
  const toolName = request.params?.name || row.tool || row.tool_name || 'unknown_tool';
  const server = row.server || row.server_name || row.mcp_server || row.transport?.server || 'mcp-server';
  // Spelled out because the one-liner it replaces read as a precedence bug:
  // `a || b || c ? (a || b || d) : undefined` groups the whole chain into the
  // condition, so when only `result.isError` was truthy the ENTIRE result became
  // the error body. That is in fact the right answer for MCP - a tool failure is
  // returned inside the result rather than as a protocol error, so the result IS
  // the error - but nothing said so and nothing tested it, which is how a
  // deliberate choice becomes indistinguishable from a mistake.
  const transportError = responseRow?.error ?? row.error;
  const error = transportError ?? (result?.isError ? result : undefined);
  const obs = normalizeObservation({
    observed_at: observedAt || row.started_at || row.timestamp,
    transport: 'mcp',
    direction: 'outbound',
    method: 'tools/call',
    host_display: server,
    path_template: `tool:${toolName}`,
    status_code: error ? 500 : 200,
    duration_ms: row.duration_ms || responseRow?.duration_ms || row.latency_ms,
    request_body: request.params?.arguments || request.params || {},
    response_body: error ? undefined : normalizeMcpResult(result),
    error_body: error,
    redactionMode: options.redactionMode
  });
  return {
    evidence: makeEvidence({ sourcePath: filePath, locator, observedAt, adapter: name, confidence: toolName === 'unknown_tool' ? 0.55 : 0.9, notes: { jsonrpc_id: request.id, tool_name: toolName, server } }),
    observation: obs
  };
}

function recordsFromToolList({ msg, row, locator, filePath, observedAt, options }) {
  const tools = msg.result?.tools || row.result?.tools || row.tools || [];
  const server = row.server || row.server_name || row.mcp_server || 'mcp-server';
  return tools.map((tool, index) => {
    const toolName = tool.name || `tool_${index + 1}`;
    const obs = normalizeObservation({
      observed_at: observedAt || row.timestamp,
      transport: 'mcp',
      direction: 'inbound-schema',
      method: 'tools/list',
      host_display: server,
      path_template: `tool-schema:${toolName}`,
      status_code: 200,
      duration_ms: row.duration_ms,
      request_body: { list: true },
      response_body: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema || tool.input_schema || tool.schema || {} },
      redactionMode: options.redactionMode
    });
    return {
      evidence: makeEvidence({ sourcePath: filePath, locator: `${locator}/tool:${index + 1}`, observedAt, adapter: name, confidence: 0.9, notes: { tool_name: toolName, server, kind: 'tool_schema' } }),
      observation: obs
    };
  });
}

function parseJsonish(text, filePath) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = safeParseJson(trimmed, filePath);
  if (parsed.ok) return [{ value: parsed.value, locator: 'json:1' }];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = safeParseJson(line, `${filePath}:${i + 1}`);
    if (row.ok) out.push({ value: row.value, locator: `line:${i + 1}` });
  }
  return out;
}

function unwrap(row) {
  return row.message || row.jsonrpc || row.request || row.response || row;
}

function normalizeMcpResult(result) {
  if (!result) return { empty_result: true };
  if (Array.isArray(result.content)) {
    return { content: result.content.map(c => ({ type: c.type, text: c.text, mimeType: c.mimeType, resource: c.resource ? { uri: c.resource.uri, mimeType: c.resource.mimeType } : undefined })) };
  }
  return result;
}

function stableId(id, locator, index) {
  if (id !== undefined && id !== null) return String(id);
  return sha256(`${locator}:${index}`).slice(0, 16);
}
