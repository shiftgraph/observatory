// drift.js
// Honest drift detection. Two hard rules that fix the rehearsal-001 false-positive failure mode:
//
//   1. TEMPORAL VALIDITY GATE. An operation is analyzed for within-capture drift only if it was
//      observed enough times across enough real time. A single short capture (a 30-second HAR)
//      is a SNAPSHOT and yields ZERO drift claims: only a profile plus a saved baseline. Real
//      drift is detected either from a long log with genuine time spread, or by comparing a
//      saved baseline to a later re-capture (detectCrossCaptureDrift).
//
//   2. SUSTAINED, DISPLACED CHANGE ONLY. A drift event requires that a prior behavior was stable,
//      then a different behavior appeared and PERSISTED and DISPLACED the old one. Two response
//      shapes that coexist from the start (success vs 404, empty vs non-empty) are request-
//      conditioned variance, not drift, and are suppressed.
import { percentile, sha256 } from './utils.js';
import { summarizeDiff, hasStructuralDiff, hasBreakingDiff } from './shape.js';

const MIN_TIMESTAMPED = 12;
const MIN_DISTINCT_BUCKETS = 6;
const MIN_SPAN_MINUTES = 20;

export function assessTemporalValidity(rows) {
  const times = rows.map(r => r.observed_at ? new Date(r.observed_at).getTime() : NaN).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < MIN_TIMESTAMPED) {
    return { drift_capable: false, timestamped: times.length, distinct_time_buckets: 0, span_minutes: 0, reason: `only ${times.length} timestamped observations (need >= ${MIN_TIMESTAMPED} for drift analysis)` };
  }
  const spanMinutes = (times.at(-1) - times[0]) / 60000;
  const buckets = new Set(times.map(t => Math.floor(t / 60000))).size;
  if (buckets < MIN_DISTINCT_BUCKETS || spanMinutes < MIN_SPAN_MINUTES) {
    return { drift_capable: false, timestamped: times.length, distinct_time_buckets: buckets, span_minutes: round(spanMinutes), reason: `capture spans ${round(spanMinutes)} min across ${buckets} time buckets; within-capture drift needs >= ${MIN_SPAN_MINUTES} min and >= ${MIN_DISTINCT_BUCKETS} buckets, else save a baseline and re-capture later` };
  }
  return { drift_capable: true, timestamped: times.length, distinct_time_buckets: buckets, span_minutes: round(spanMinutes), reason: 'sufficient temporal spread for within-capture drift analysis' };
}

// Within-capture drift: only call when assessTemporalValidity(...).drift_capable is true.
export function detectWithinCaptureDrift(op, rows) {
  const timed = rows.filter(r => r.observed_at).sort(byTime);
  const events = [];
  const mid = Math.floor(timed.length / 2);
  const early = timed.slice(0, mid);
  const late = timed.slice(mid);
  if (early.length < 5 || late.length < 5) return events;
  const shape = detectShapeDisplacement(op, early, late);
  if (shape) events.push(shape);
  const status = detectStatusRegime(op, early, late);
  if (status) events.push(status);
  const latency = detectLatencyRegime(op, early, late);
  if (latency) events.push(latency);
  return events;
}

// Cross-capture drift: compare a saved baseline operation to the same operation now. This is the
// real temporal comparison (two captures at different points in time) and the primary M0 drift
// path for short captures: `shiftgraph baseline` today, `shiftgraph compare` after a re-capture.
export function detectCrossCaptureDrift(baselineOp, currentOp) {
  const events = [];
  const b = baselineOp.dominant_response_shape;
  const c = currentOp.dominant_response_shape;
  // Fire only on a genuine structural (contract) difference, not a hash change from
  // data variance. hasStructuralDiff is wildcard-tolerant: an empty array or null in
  // the baseline that carries a value later is a data refinement, never drift.
  if (b && c && !isUnavailable(b.representative_profile) && !isUnavailable(c.representative_profile) && hasStructuralDiff(b.representative_profile, c.representative_profile)) {
    const diff = summarizeDiff(b.representative_profile, c.representative_profile, 30);
    const breaking = hasBreakingDiff(b.representative_profile, c.representative_profile);
    events.push(makeEvent({
      op: currentOp, type: 'dominant_response_shape_changed',
      first_seen: currentOp.first_seen, last_before: baselineOp.last_seen,
      severity: breaking ? 'high' : 'low',
      confidence: breaking ? 0.7 : 0.5, causal_language: 'associated',
      explanation: `Dominant response shape for ${currentOp.display_name} changed since baseline. Diff: ${diff}.`,
      evidence_ids: (c.evidence_ids || []).slice(0, 25)
    }));
  }
  const errDelta = (currentOp.error_rate || 0) - (baselineOp.error_rate || 0);
  if (errDelta >= 0.25 && currentOp.sample_count >= 5 && baselineOp.sample_count >= 5) {
    events.push(makeEvent({
      op: currentOp, type: 'status_error_rate_shift',
      first_seen: currentOp.first_seen, last_before: baselineOp.last_seen,
      severity: errDelta >= 0.5 ? 'high' : 'medium', confidence: 0.65, causal_language: 'associated',
      explanation: `${currentOp.display_name} error rate rose from ${(baselineOp.error_rate * 100).toFixed(1)}% (baseline) to ${(currentOp.error_rate * 100).toFixed(1)}% (now).`,
      evidence_ids: []
    }));
  }
  const bl = baselineOp.p95_latency_ms, cl = currentOp.p95_latency_ms;
  if (bl && cl && cl / bl >= 2.5 && currentOp.sample_count >= 5) {
    events.push(makeEvent({
      op: currentOp, type: 'latency_regime_shift',
      first_seen: currentOp.first_seen, last_before: baselineOp.last_seen,
      severity: cl / bl >= 5 ? 'high' : 'medium', confidence: 0.6, causal_language: 'associated',
      explanation: `${currentOp.display_name} p95 latency rose from ${bl}ms (baseline) to ${cl}ms (now).`,
      evidence_ids: []
    }));
  }
  return events;
}

function detectShapeDisplacement(op, early, late) {
  const dEarly = dominantHash(early, 'response_shape_hash');
  const dLate = dominantHash(late, 'response_shape_hash');
  if (!dEarly || !dLate || dEarly.hash === dLate.hash) return null;
  const lateShapeShareEarly = shareOf(early, 'response_shape_hash', dLate.hash);
  const earlyShapeShareLate = shareOf(late, 'response_shape_hash', dEarly.hash);
  // Clean displacement: the late-dominant shape must be rare early (not concurrent variance) and
  // clearly dominant late.
  if (dLate.share < 0.5 || lateShapeShareEarly > 0.2) return null;
  const repLate = late.find(r => r.response_shape_hash === dLate.hash);
  const repEarly = early.find(r => r.response_shape_hash === dEarly.hash);
  if (isUnavailable(repLate?.response_profile) || isUnavailable(repEarly?.response_profile)) return null;
  if (!hasStructuralDiff(repEarly?.response_profile, repLate?.response_profile)) return null;
  const diff = summarizeDiff(repEarly?.response_profile, repLate?.response_profile, 30);
  return makeEvent({
    op, type: 'response_population_displaced',
    first_seen: repLate?.observed_at, last_before: early.at(-1)?.observed_at,
    severity: /removed|changed/.test(diff) ? 'high' : 'medium',
    confidence: clamp(0.5 + Math.min(0.25, late.length / 100) + (dLate.share - 0.5), 0.3, 0.9),
    causal_language: 'associated',
    explanation: `Dominant response shape for ${op.display_name} displaced within the capture (prior shape receded to ${(earlyShapeShareLate * 100).toFixed(0)}% late). Diff: ${diff}.`,
    evidence_ids: late.filter(r => r.response_shape_hash === dLate.hash).slice(0, 25).map(r => r.evidence_id)
  });
}

function detectStatusRegime(op, early, late) {
  const eErr = rate(early, isError), lErr = rate(late, isError);
  if (lErr - eErr < 0.3) return null;
  return makeEvent({
    op, type: 'status_error_rate_shift',
    first_seen: late[0]?.observed_at, last_before: early.at(-1)?.observed_at,
    severity: lErr - eErr >= 0.5 ? 'high' : 'medium',
    confidence: clamp(0.5 + Math.min(0.2, late.length / 80) + (lErr - eErr), 0.3, 0.9),
    causal_language: 'associated',
    explanation: `${op.display_name} error rate rose from ${(eErr * 100).toFixed(1)}% to ${(lErr * 100).toFixed(1)}% across the capture.`,
    evidence_ids: late.filter(isError).slice(0, 25).map(r => r.evidence_id)
  });
}

function detectLatencyRegime(op, early, late) {
  const eP = percentile(early.map(r => r.duration_ms), 95);
  const lP = percentile(late.map(r => r.duration_ms), 95);
  if (!eP || !lP || lP / eP < 2.5) return null;
  return makeEvent({
    op, type: 'latency_regime_shift',
    first_seen: late[0]?.observed_at, last_before: early.at(-1)?.observed_at,
    severity: lP / eP >= 5 ? 'high' : 'medium',
    confidence: clamp(0.45 + Math.min(0.2, late.length / 80) + Math.min(0.25, (lP / eP - 1) / 5), 0.3, 0.85),
    causal_language: 'associated',
    explanation: `${op.display_name} p95 latency rose from ${eP}ms to ${lP}ms across the capture.`,
    evidence_ids: late.slice(0, 25).map(r => r.evidence_id)
  });
}

function makeEvent({ op, type, first_seen, last_before, severity, confidence, causal_language, explanation, evidence_ids }) {
  return {
    id: `tr_${sha256(`${op.id}:${type}:${first_seen}`).slice(0, 16)}`,
    operation_id: op.id,
    operation: op.display_name,
    transition_type: type,
    first_seen: first_seen || null,
    last_known_before: last_before || null,
    severity,
    confidence: round2(confidence),
    confidence_label: confidenceLabel(confidence),
    causal_language,
    degraded_reasons: ['no deployment data supplied'],
    evidence_ids: evidence_ids || [],
    explanation
  };
}

function dominantHash(rows, key) {
  const counts = new Map();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) || 0) + 1);
  let best = null;
  for (const [hash, n] of counts) if (!best || n > best.n) best = { hash, n };
  return best && rows.length ? { hash: best.hash, share: best.n / rows.length } : null;
}
function shareOf(rows, key, hash) { return rows.length ? rows.filter(r => r[key] === hash).length / rows.length : 0; }
function rate(rows, pred) { return rows.length ? rows.filter(pred).length / rows.length : 0; }
function isError(r) { return Number.isFinite(r.status_code) && r.status_code >= 400; }
function isUnavailable(p) { return Boolean(p?.type === 'object' && p.keys?.unavailable); }
function byTime(a, b) { return new Date(a.observed_at || 0) - new Date(b.observed_at || 0); }
function confidenceLabel(v) { if (v >= 0.85) return 'high'; if (v >= 0.7) return 'medium-high'; if (v >= 0.5) return 'medium'; if (v >= 0.3) return 'low-medium'; return 'low'; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
