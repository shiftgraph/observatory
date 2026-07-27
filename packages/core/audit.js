import path from 'node:path';
import { collectInputFiles, sha256, percentile } from './utils.js';
import { profileWithHash } from './shape.js';
import { canonicalOperationIdentity, displayOperation } from './operation.js';
import { behaviorVector, statusClass } from './behavior.js';
import { requestKind, isDependencyKind, extractGraphqlOp, resolveFirstPartyHosts, isFirstParty } from './classify.js';
import { getAdapter, inferFormat } from '../adapters/index.js';
import { loadDeploymentContext, assessDeploymentOverlap } from './deployments.js';
import { applyCausalAssessment } from './causality.js';
import { assessTemporalValidity, detectWithinCaptureDrift } from './drift.js';
import { TOOL_VERSION } from './version.js';

export async function runAudit(inputs, options = {}) {
  const started = new Date().toISOString();
  const inputFiles = await collectInputFiles(inputs);
  const runId = `run_${sha256(`${started}:${inputFiles.join('|')}`).slice(0, 16)}`;
  const evidence = [];
  const observations = [];
  const degraded = [];
  const deploymentContext = await loadDeploymentContext(options.deploymentsPath, options);

  // Pass 1: parse + enrich (kind, graphql op, shapes, behavior).
  for (const filePath of inputFiles) {
    const format = inferFormat(filePath, options.format || 'auto');
    const adapter = getAdapter(format);
    const records = await adapter.parseFile(filePath, { redactionMode: options.redactionMode || 'balanced' });
    for (const record of records) {
      const evidenceId = `ev_${sha256(`${filePath}:${record.evidence.source_locator}:${evidence.length}`).slice(0, 16)}`;
      evidence.push({ ...record.evidence, id: evidenceId, source_path: path.relative(process.cwd(), record.evidence.source_path) });
      const obs = enrichObservation(record.observation, evidenceId, runId);
      observations.push(obs);
      if (!obs.observed_at) degraded.push({ evidence_id: evidenceId, reason: 'missing timestamp' });
      if (obs.method === 'UNKNOWN' || obs.host_display === 'unknown-host') degraded.push({ evidence_id: evidenceId, reason: 'low operation identity confidence' });
    }
  }

  // Pass 2: resolve origin, then assign identity + dependency flag (identity depends on kind).
  const firstPartyHosts = resolveFirstPartyHosts(observations, { origin: options.origin });
  for (const obs of observations) {
    obs.first_party = isFirstParty(obs.host_display, firstPartyHosts);
    const { identity, coi_hash } = canonicalOperationIdentity(obs);
    obs.operation_identity = identity;
    obs.coi_hash = coi_hash;
    obs.is_dependency = isDependencyKind(obs.kind) && !obs.first_party;
  }

  const dependencyObs = observations.filter(o => o.is_dependency);
  const operations = buildOperations(dependencyObs);
  const populations = buildPopulations(operations, dependencyObs);
  const { transitions, driftCapableCount } = detectDrift(operations, dependencyObs, { ...options, deploymentContext });
  const context = summarizeContext(observations, firstPartyHosts);
  const analysisMode = transitions.length || operations.some(o => o.temporal.drift_capable) ? 'drift' : 'profile';
  const summary = buildSummary({ observations, operations, populations, transitions, degraded, context, driftCapableCount, analysisMode });

  return {
    schema_version: 'shiftgraph.audit.v2',
    tool_version: TOOL_VERSION,
    analysis_mode: analysisMode,
    run: { id: runId, started_at: started, completed_at: new Date().toISOString(), input_paths: inputs, file_count: inputFiles.length, redaction_mode: options.redactionMode || 'balanced', origin_hint: options.origin || null },
    summary,
    dependencies: buildDependencyList(operations),
    operations,
    populations,
    transitions,
    context,
    evidence,
    degraded,
    deployment_context: deploymentContext,
    privacy: privacySummary(options.redactionMode || 'balanced')
  };
}

function enrichObservation(obs, evidenceId, runId) {
  const graphqlOp = extractGraphqlOp(obs.request_body);
  const withKind = { ...obs, graphql_op: graphqlOp };
  withKind.kind = requestKind(withKind);
  const request = profileWithHash(obs.request_body ?? { unavailable: true });
  const response = profileWithHash(obs.response_body ?? { unavailable: true });
  const error = profileWithHash(obs.error_body ?? { unavailable: true });
  const behavior = behaviorVector(obs);
  return {
    id: `obs_${sha256(`${runId}:${evidenceId}`).slice(0, 16)}`,
    evidence_id: evidenceId,
    observed_at: obs.observed_at,
    transport: obs.transport,
    direction: obs.direction,
    method: obs.method,
    host_display: obs.host_display,
    host_hash: obs.host_hash,
    path_template: obs.path_template,
    path_raw: obs.path_raw,
    kind: withKind.kind,
    graphql_op: graphqlOp,
    status_code: obs.status_code,
    status_class: statusClass(obs.status_code),
    duration_ms: obs.duration_ms,
    request_shape_hash: request.shape_hash,
    response_shape_hash: response.shape_hash,
    error_shape_hash: error.shape_hash,
    behavior_vector_hash: behavior.behavior_hash,
    request_profile: request.profile,
    response_profile: response.profile,
    error_profile: error.profile,
    behavior_vector: behavior.vector
  };
}

function buildOperations(dependencyObs) {
  const groups = groupBy(dependencyObs, o => o.coi_hash);
  return [...groups.entries()].map(([coiHash, rows]) => {
    const sorted = rows.slice().sort(byTime);
    const identity = rows[0].operation_identity;
    const shapes = buildResponseShapes(sorted);
    const dominant = shapes.find(s => !s.unavailable) || null;
    const temporal = assessTemporalValidity(sorted);
    const errorRate = rate(rows, isErrorRow);
    return {
      id: `op_${sha256(coiHash).slice(0, 16)}`,
      coi_hash: coiHash,
      display_name: displayOperation(identity),
      kind: identity.kind,
      transport: identity.transport,
      method: identity.method || null,
      host_display: identity.host,
      route: identity.route || null,
      graphql_op: identity.op || null,
      first_party: false,
      sample_count: rows.length,
      first_seen: sorted[0]?.observed_at || null,
      last_seen: sorted.at(-1)?.observed_at || null,
      status_distribution: distribution(rows.map(r => r.status_class)),
      error_rate: errorRate,
      p95_latency_ms: percentile(rows.map(r => r.duration_ms), 95),
      median_latency_ms: percentile(rows.map(r => r.duration_ms), 50),
      response_shapes: shapes,
      dominant_response_shape: dominant ? { hash: dominant.population_hash, share: dominant.share, representative_profile: dominant.representative_profile, evidence_ids: dominant.evidence_ids } : null,
      health: healthOf(errorRate, rows),
      temporal
    };
  }).sort((a, b) => b.sample_count - a.sample_count || a.display_name.localeCompare(b.display_name));
}

function buildResponseShapes(sortedRows) {
  const groups = groupBy(sortedRows, r => r.response_shape_hash);
  const total = sortedRows.length || 1;
  return [...groups.entries()].map(([hash, members]) => {
    const first = members.find(m => !isUnavailable(m.response_profile)) || members[0];
    return {
      population_hash: hash,
      sample_count: members.length,
      share: members.length / total,
      representative_profile: first?.response_profile,
      unavailable: isUnavailable(first?.response_profile),
      first_seen: members[0]?.observed_at || null,
      last_seen: members.at(-1)?.observed_at || null,
      evidence_ids: members.slice(0, 25).map(m => m.evidence_id)
    };
  }).sort((a, b) => b.sample_count - a.sample_count);
}

// Kept for opt-in corpus + baseline compatibility: response populations for dependency ops only
// (no asset/first-party noise), so downstream consumers never ingest the noisy buckets.
function buildPopulations(operations, dependencyObs) {
  const pops = [];
  const opByCoi = new Map(operations.map(op => [op.coi_hash, op]));
  for (const op of operations) {
    for (const s of op.response_shapes) {
      pops.push({
        id: `pop_${sha256(`${op.id}:response:${s.population_hash}`).slice(0, 16)}`,
        operation_id: op.id,
        coi_hash: op.coi_hash,
        population_hash: s.population_hash,
        kind: 'response',
        sample_count: s.sample_count,
        share: s.share,
        first_seen: s.first_seen,
        last_seen: s.last_seen,
        representative_profile: s.representative_profile,
        evidence_ids: s.evidence_ids
      });
    }
  }
  return pops.sort((a, b) => b.sample_count - a.sample_count);
}

function detectDrift(operations, dependencyObs, options) {
  const transitions = [];
  let driftCapableCount = 0;
  const obsByCoi = groupBy(dependencyObs, o => o.coi_hash);
  for (const op of operations) {
    if (!op.temporal.drift_capable) continue;
    driftCapableCount++;
    const rows = obsByCoi.get(op.coi_hash) || [];
    for (const ev of detectWithinCaptureDrift(op, rows)) {
      transitions.push(applyCausalAssessment(ev, op, assessDeploymentOverlap(ev, op, options.deploymentContext, options)));
    }
  }
  transitions.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence);
  return { transitions, driftCapableCount };
}

function summarizeContext(observations, firstPartyHosts) {
  const context = observations.filter(o => !o.is_dependency);
  const byBucket = {};
  const hostCounts = new Map();
  for (const o of context) {
    const bucket = o.first_party ? (isDependencyKind(o.kind) ? 'first_party_api' : `first_party_${o.kind}`) : o.kind;
    byBucket[bucket] = (byBucket[bucket] || 0) + 1;
    hostCounts.set(o.host_display, (hostCounts.get(o.host_display) || 0) + 1);
  }
  return {
    first_party_hosts: [...firstPartyHosts],
    excluded_observation_count: context.length,
    buckets: byBucket,
    top_excluded_hosts: [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, count]) => ({ host, count })),
    note: 'These observations are context, not third-party dependency operations, and are never analyzed for drift. First-party calls (your own app/API) and static assets/telemetry are excluded by design.'
  };
}

function buildDependencyList(operations) {
  const byHost = groupBy(operations, op => op.host_display);
  return [...byHost.entries()].map(([host, ops]) => ({
    host,
    operation_count: ops.length,
    sample_count: ops.reduce((n, o) => n + o.sample_count, 0),
    error_rate: weightedRate(ops),
    kinds: distribution(ops.map(o => o.kind))
  })).sort((a, b) => b.sample_count - a.sample_count);
}

function buildSummary({ observations, operations, populations, transitions, degraded, context, driftCapableCount, analysisMode }) {
  const totalSpanMinutes = spanMinutes(observations);
  return {
    analysis_mode: analysisMode,
    observation_count: observations.length,
    host_count: new Set(observations.map(o => o.host_display)).size,
    first_party_hosts: context.first_party_hosts,
    third_party_dependency_count: new Set(operations.map(o => o.host_display)).size,
    dependency_operation_count: operations.length,
    response_population_count: populations.length,
    excluded_context_observation_count: context.excluded_observation_count,
    context_buckets: context.buckets,
    drift_capable_operation_count: driftCapableCount,
    transition_count: transitions.length,
    high_or_critical_transition_count: transitions.filter(t => ['high', 'critical'].includes(t.severity)).length,
    external_suspected_transition_count: transitions.filter(t => t.causal_language === 'external-suspected').length,
    ambiguous_transition_count: transitions.filter(t => t.causal_language === 'ambiguous').length,
    degraded_record_count: degraded.length,
    temporal: {
      total_span_minutes: totalSpanMinutes,
      drift_analysis_possible: driftCapableCount > 0,
      reason: driftCapableCount > 0
        ? `${driftCapableCount} operation(s) had enough temporal spread for within-capture drift analysis`
        : `no operation had enough temporal spread; this is a SNAPSHOT PROFILE. Save a baseline and re-capture later (shiftgraph baseline / compare), or observe continuously, to detect drift`
    },
    top_dependencies: operations.map(op => ({
      operation_id: op.id,
      display_name: op.display_name,
      host: op.host_display,
      sample_count: op.sample_count,
      error_rate: op.error_rate,
      p95_latency_ms: op.p95_latency_ms,
      transition_count: transitions.filter(t => t.operation_id === op.id).length
    })).sort((a, b) => b.transition_count - a.transition_count || b.sample_count - a.sample_count).slice(0, 10)
  };
}

function privacySummary(mode) {
  return {
    redaction_mode: mode,
    raw_payload_values_exported: false,
    raw_headers_exported: false,
    hosted_export_created: false,
    notes: [
      'Audit output stores structural profiles, operation metadata, evidence locators, and redacted diffs only.',
      'Values, bodies, headers, cookies, and secret-like fields are stripped during profiling; raw source files stay on the local machine.',
      'Any future network contribution is opt-in and previewable.'
    ]
  };
}

function healthOf(errorRate, rows) {
  if (!rows.length) return 'unknown';
  if (errorRate > 0.5) return 'errors';
  if (errorRate > 0.1) return 'degraded';
  if (rows.every(r => r.status_class === '2xx')) return 'ok';
  return 'mixed';
}

function weightedRate(ops) {
  const total = ops.reduce((n, o) => n + o.sample_count, 0) || 1;
  return ops.reduce((n, o) => n + (o.error_rate || 0) * o.sample_count, 0) / total;
}

function spanMinutes(observations) {
  const times = observations.map(o => o.observed_at ? new Date(o.observed_at).getTime() : NaN).filter(Number.isFinite);
  if (times.length < 2) return 0;
  return Math.round(((Math.max(...times) - Math.min(...times)) / 60000) * 10) / 10;
}

function isErrorRow(r) { return Number.isFinite(r.status_code) && r.status_code >= 400; }
function isUnavailable(p) { return Boolean(p?.type === 'object' && p.keys?.unavailable); }

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) { const k = fn(row); if (!map.has(k)) map.set(k, []); map.get(k).push(row); }
  return map;
}
function distribution(values) { const out = {}; for (const v of values) out[v ?? 'unknown'] = (out[v ?? 'unknown'] || 0) + 1; return out; }
function rate(rows, pred) { return rows.length ? rows.filter(pred).length / rows.length : 0; }
function byTime(a, b) { return new Date(a.observed_at || 0) - new Date(b.observed_at || 0); }
function severityRank(s) { return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[s] ?? 0; }
