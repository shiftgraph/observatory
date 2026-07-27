import { bucketNumber, hashObject } from './utils.js';

const LATENCY_BUCKETS = [
  ['<100ms', 0, 100],
  ['100-300ms', 100, 300],
  ['300ms-1s', 300, 1000],
  ['1-3s', 1000, 3000],
  ['3-10s', 3000, 10000],
  ['10s+', 10000, Infinity]
];

export function statusClass(statusCode) {
  if (!Number.isFinite(statusCode)) return 'unknown';
  return `${Math.floor(statusCode / 100)}xx`;
}

export function behaviorVector(obs) {
  const status = Number.isFinite(obs.status_code) ? obs.status_code : null;
  const vector = {
    status_class: statusClass(status),
    exact_status: status,
    latency_bucket: bucketNumber(obs.duration_ms, LATENCY_BUCKETS),
    error_flag: status ? status >= 400 : Boolean(obs.error),
    rate_limit_signature: status === 429 || hasRateLimitHint(obs) ? 'present' : 'absent',
    timeout_signature: /timeout|timed out|ETIMEDOUT/i.test(JSON.stringify(obs.error || obs.error_body || '')) ? 'present' : 'absent'
  };
  return { vector, behavior_hash: `behavior:${hashObject(vector)}` };
}

function hasRateLimitHint(obs) {
  const haystack = JSON.stringify(obs.headers || obs.response_headers || obs.error_body || {}).toLowerCase();
  return haystack.includes('rate') && haystack.includes('limit');
}
