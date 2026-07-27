import { promises as fs } from 'node:fs';
import { normalizeDate, safeParseJson, sha256 } from './utils.js';

const DEFAULT_WINDOW_MINUTES = 45;

export async function loadDeploymentContext(filePath, options = {}) {
  if (!filePath) {
    return {
      schema_version: 'shiftgraph.deployments.v1',
      source_path: null,
      windows: [],
      loaded: false,
      degraded: ['no deployment data supplied']
    };
  }
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = safeParseJson(text, filePath);
  if (!parsed.ok) throw new Error(parsed.error);
  const root = parsed.value;
  const raw = Array.isArray(root) ? root : root.deployments || root.windows || [];
  const defaultWindowMinutes = Number(root.default_window_minutes || options.defaultWindowMinutes || DEFAULT_WINDOW_MINUTES);
  const windows = raw.map((item, index) => normalizeDeploymentWindow(item, index, defaultWindowMinutes)).filter(Boolean).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  return {
    schema_version: 'shiftgraph.deployments.v1',
    source_path: filePath,
    loaded: true,
    default_window_minutes: defaultWindowMinutes,
    windows,
    degraded: windows.length ? [] : ['deployment file supplied but no parseable windows found']
  };
}

function normalizeDeploymentWindow(item, index, defaultWindowMinutes) {
  if (!item || typeof item !== 'object') return null;
  const started = normalizeDate(item.started_at || item.start || item.timestamp || item.deployed_at || item.time);
  if (!started) return null;
  const explicitEnd = normalizeDate(item.ended_at || item.end || item.completed_at);
  const startedMs = new Date(started).getTime();
  const ended = explicitEnd || new Date(startedMs + defaultWindowMinutes * 60_000).toISOString();
  const services = asStringArray(item.services || item.service || item.app || item.repository || item.repo || item.name);
  const dependencies = asStringArray(item.dependencies || item.hosts || item.external_hosts || item.providers || item.provider);
  const env = item.environment || item.env || 'unknown';
  const id = item.id || `dep_${sha256(`${started}:${ended}:${services.join(',')}:${dependencies.join(',')}:${index}`).slice(0, 16)}`;
  return {
    id,
    started_at: started,
    ended_at: ended,
    services,
    dependencies,
    environment: env,
    version: item.version || item.sha || item.commit || item.release || null,
    source: item.source || item.system || null,
    summary: item.summary || item.message || item.title || null,
    confidence: typeof item.confidence === 'number' ? clamp(item.confidence, 0, 1) : 0.8
  };
}

export function assessDeploymentOverlap(transition, operation, deploymentContext, options = {}) {
  const minutesBefore = Number(options.minutesBefore ?? 90);
  const minutesAfter = Number(options.minutesAfter ?? 15);
  if (!deploymentContext?.loaded) {
    return {
      supplied: false,
      overlap_count: 0,
      matching: [],
      assessment: 'not_supplied',
      confidence_adjustment: -0.04,
      severity_adjustment: 0,
      reasons: ['no deployment data supplied'],
      claim_language: null
    };
  }
  const firstSeen = transition?.first_seen ? new Date(transition.first_seen).getTime() : NaN;
  if (!Number.isFinite(firstSeen)) {
    return {
      supplied: true,
      overlap_count: 0,
      matching: [],
      assessment: 'unassessable',
      confidence_adjustment: -0.06,
      severity_adjustment: 0,
      reasons: ['transition has no timestamp; deployment overlap cannot be assessed'],
      claim_language: null
    };
  }
  const lower = firstSeen - minutesBefore * 60_000;
  const upper = firstSeen + minutesAfter * 60_000;
  const allOverlaps = (deploymentContext.windows || []).filter(w => intervalIntersects(new Date(w.started_at).getTime(), new Date(w.ended_at).getTime(), lower, upper));
  const host = operation?.host_display || operation?.operation_identity?.host || '';
  const matching = allOverlaps.filter(w => windowMatchesOperation(w, operation, host));
  if (matching.length) {
    return {
      supplied: true,
      overlap_count: matching.length,
      matching,
      assessment: 'internal_deploy_overlap',
      confidence_adjustment: -0.14,
      severity_adjustment: -1,
      reasons: [`${matching.length} internal deployment window overlapped the transition window`],
      claim_language: 'ambiguous'
    };
  }
  if (allOverlaps.length) {
    return {
      supplied: true,
      overlap_count: allOverlaps.length,
      matching: allOverlaps,
      assessment: 'unmatched_internal_deploy_nearby',
      confidence_adjustment: -0.04,
      severity_adjustment: 0,
      reasons: [`${allOverlaps.length} deployment window(s) were nearby but did not explicitly target this dependency`],
      claim_language: null
    };
  }
  return {
    supplied: true,
    overlap_count: 0,
    matching: [],
    assessment: 'no_internal_deploy_overlap',
    confidence_adjustment: 0.09,
    severity_adjustment: 0,
    reasons: ['no internal deployment window overlapped the transition window'],
    claim_language: 'external-suspected'
  };
}

function windowMatchesOperation(window, operation, host) {
  if (!window.dependencies?.length && !window.services?.length) return true;
  const depText = window.dependencies.join(' ').toLowerCase();
  const serviceText = window.services.join(' ').toLowerCase();
  const opText = `${operation?.display_name || ''} ${operation?.host_display || host || ''}`.toLowerCase();
  if (window.dependencies.some(d => host && host.toLowerCase().includes(String(d).toLowerCase()))) return true;
  if (window.dependencies.some(d => opText.includes(String(d).toLowerCase()))) return true;
  if (window.services.some(s => opText.includes(String(s).toLowerCase()))) return true;
  if (depText.includes('all') || serviceText.includes('all')) return true;
  return false;
}

function intervalIntersects(aStart, aEnd, bStart, bEnd) {
  return Number.isFinite(aStart) && Number.isFinite(aEnd) && aStart <= bEnd && bStart <= aEnd;
}

function asStringArray(value) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(v => String(v).trim()).filter(Boolean);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
