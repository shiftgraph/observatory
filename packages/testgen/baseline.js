import { writeJson } from '../core/utils.js';
import { carryOptionality } from '../core/shape.js';
import { detectCrossCaptureDrift } from '../core/drift.js';

// A baseline snapshots each third-party dependency operation's stable profile at one point in
// time. Comparing a later capture against it is the honest cross-capture drift path: two real
// captures at two real times, which a single short snapshot can never provide on its own.
export function baselineFromReport(report, prior = null) {
  // Series memory (mechanism 2b): a field observed absent at any point in this
  // operation's history is optional from here on. Presence within one response
  // cannot see this, because a single-sample object reveals nothing about which
  // of its fields are conditional. The baseline is where time is kept, so this
  // is where the evidence lives.
  const priorShapeByCoi = new Map(
    (prior?.operations || []).map(op => [op.coi_hash, op.dominant_response_shape?.representative_profile]),
  );
  return {
    schema_version: 'shiftgraph.baseline.v2',
    created_at: report.run.completed_at || new Date().toISOString(),
    source_run_id: report.run.id,
    operations: report.operations.map(op => ({
      coi_hash: op.coi_hash,
      display_name: op.display_name,
      host_display: op.host_display,
      sample_count: op.sample_count,
      first_seen: op.first_seen,
      last_seen: op.last_seen,
      error_rate: op.error_rate,
      p95_latency_ms: op.p95_latency_ms,
      dominant_response_shape: rollShape(op, priorShapeByCoi.get(op.coi_hash)),
      response_shape_hashes: op.response_shapes.map(s => s.population_hash)
    }))
  };
}

function rollShape(op, priorProfile) {
  const shape = op.dominant_response_shape;
  if (!shape?.representative_profile || !priorProfile) return shape;
  return { ...shape, representative_profile: carryOptionality(priorProfile, shape.representative_profile) };
}

export async function writeBaseline(report, outPath, prior = null) {
  await writeJson(outPath, baselineFromReport(report, prior));
}

export function compareBaseline(baseline, report) {
  const baseByCoi = new Map((baseline.operations || []).map(op => [op.coi_hash, op]));
  const events = [];
  const newOperations = [];
  for (const op of report.operations) {
    const base = baseByCoi.get(op.coi_hash);
    if (!base) { newOperations.push({ operation: op.display_name, sample_count: op.sample_count, first_seen: op.first_seen }); continue; }
    for (const ev of detectCrossCaptureDrift(base, op)) events.push(ev);
  }
  events.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence);
  return {
    schema_version: 'shiftgraph.compare.v2',
    baseline_created_at: baseline.created_at || null,
    drift_event_count: events.length,
    new_operation_count: newOperations.length,
    drift_events: events,
    new_operations: newOperations
  };
}

function severityRank(s) { return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[s] ?? 0; }
