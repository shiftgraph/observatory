import * as otel from './otel-json.js';
import * as ndjson from './ndjson.js';
import * as har from './har.js';
import * as mcp from './mcp.js';
import * as otlpProto from './otlp-proto.js';

const adapters = new Map([
  ['otel-json', otel],
  ['ndjson', ndjson],
  ['har', har],
  ['mcp-jsonrpc', mcp],
  ['mcp', mcp],
  ['otlp-proto', otlpProto]
]);

export function getAdapter(format) {
  const adapter = adapters.get(format);
  if (!adapter) throw new Error(`Unsupported format: ${format}. Supported: ${[...adapters.keys()].join(', ')}`);
  return adapter;
}

export function inferFormat(filePath, explicit) {
  if (explicit && explicit !== 'auto') return explicit;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.har')) return 'har';
  if (lower.endsWith('.mcp') || lower.endsWith('.mcp.json') || lower.endsWith('.jsonrpc')) return 'mcp-jsonrpc';
  if (lower.endsWith('.pb') || lower.endsWith('.proto.bin') || lower.endsWith('.otlp')) return 'otlp-proto';
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl') || lower.endsWith('.log')) return 'ndjson';
  return 'otel-json';
}
