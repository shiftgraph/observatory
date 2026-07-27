const RANKS = ['info', 'low', 'medium', 'high', 'critical'];

export function applyCausalAssessment(transition, operation, deploymentAssessment) {
  const adjusted = { ...transition };
  const baseConfidence = Number(adjusted.confidence || 0);
  adjusted.causal_analysis = deploymentAssessment;
  adjusted.confidence = clamp(baseConfidence + (deploymentAssessment?.confidence_adjustment || 0), 0.05, 0.97);
  adjusted.confidence_label = confidenceLabel(adjusted.confidence);
  if (deploymentAssessment?.severity_adjustment) adjusted.severity = shiftSeverity(adjusted.severity, deploymentAssessment.severity_adjustment);
  const reasons = new Set(adjusted.degraded_reasons || []);
  for (const r of deploymentAssessment?.reasons || []) reasons.add(r);
  if (deploymentAssessment?.supplied) reasons.delete('no deployment data supplied');
  adjusted.degraded_reasons = [...reasons];
  if (deploymentAssessment?.claim_language) {
    if (deploymentAssessment.claim_language === 'external-suspected' && ['associated', 'observed'].includes(adjusted.causal_language)) {
      adjusted.causal_language = adjusted.causal_language === 'associated' ? 'external-suspected' : 'observed';
    } else {
      adjusted.causal_language = deploymentAssessment.claim_language;
    }
  }
  adjusted.explanation = appendCausalSentence(adjusted.explanation, deploymentAssessment, adjusted.causal_language);
  return adjusted;
}

function appendCausalSentence(text, assessment, language) {
  if (!assessment) return text;
  if (assessment.assessment === 'no_internal_deploy_overlap' && language === 'external-suspected') {
    return `${text} Deployment context supplied: no internal deployment window overlapped first-seen time, so this is external-suspected, not confirmed.`;
  }
  if (assessment.assessment === 'internal_deploy_overlap') {
    const names = (assessment.matching || []).slice(0, 3).map(w => w.summary || w.version || w.id).join(', ');
    return `${text} Internal deployment window overlapped first-seen time${names ? ` (${names})` : ''}; claim downgraded to ambiguous.`;
  }
  if (assessment.assessment === 'unmatched_internal_deploy_nearby') {
    return `${text} Deployment context supplied: unrelated deployment activity was nearby; causal claim remains conservative.`;
  }
  return text;
}

function shiftSeverity(severity, delta) {
  const i = RANKS.indexOf(severity);
  if (i === -1) return severity;
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, i + delta))];
}

function confidenceLabel(v) {
  if (v >= 0.85) return 'high';
  if (v >= 0.7) return 'medium-high';
  if (v >= 0.5) return 'medium';
  if (v >= 0.3) return 'low-medium';
  return 'low';
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
