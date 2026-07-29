// A non-2xx body is never the contract.
//
// This fired for real. On 2026-07-29T18:58Z the public observatory swept while
// rate-limited; six GitHub endpoints answered {message, documentation_url} with
// a 403 and content-type: application/json; the sweeper kept the body because it
// only ever checked content-type, and the engine profiled the error page as the
// new dominant shape. Six BREAKING events reached the published record -
// $.avatar_url removed, $.body removed, the licences array becoming an object -
// and nothing at GitHub had changed.
//
// @shiftgraph/generate has refused error responses since its first version for
// exactly this reason: "types from an error response would describe the error,
// not the contract". Nothing downstream of it had the same rule, so the rule now
// lives in normalizeObservation, which every adapter and the hosted ingest both
// pass through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObservation } from '../packages/adapters/common.js';
test('a non-2xx body never becomes the contract, and is kept as the error', () => {
  const envelope = { message: 'API rate limit exceeded', documentation_url: 'https://docs.github.com/rest' };

  const rateLimited = normalizeObservation({
    url: 'https://api.github.com/users/torvalds',
    method: 'GET',
    status: 403,
    response_content_type: 'application/json',
    response_body: envelope,
    observed_at: '2026-07-29T18:58:44Z',
  });
  assert.equal(rateLimited.response_body, undefined, '403 body was profiled as the contract');
  assert.deepEqual(rateLimited.error_body, envelope, 'the error body must still be retained');
  assert.equal(rateLimited.status_code, 403, 'the status itself is still observed');

  // The success path is untouched: this rule must not cost us real contracts.
  const ok = normalizeObservation({
    url: 'https://api.github.com/users/torvalds',
    method: 'GET',
    status: 200,
    response_content_type: 'application/json',
    response_body: { login: 'x', id: 0 },
    observed_at: '2026-07-29T18:58:44Z',
  });
  assert.deepEqual(ok.response_body, { login: 'x', id: 0 });
  assert.equal(ok.error_body, undefined);

  // A capture with no status recorded is still profiled. Refusing those would
  // silently drop every observation from a source that omits the code, which is
  // a bigger hole than the one being closed.
  const noStatus = normalizeObservation({
    url: 'https://api.example.com/thing',
    method: 'GET',
    response_body: { a: 1 },
    observed_at: '2026-07-29T18:58:44Z',
  });
  assert.deepEqual(noStatus.response_body, { a: 1 });

  // A redirect body is a courtesy page, not a payload.
  const redirected = normalizeObservation({
    url: 'https://api.example.com/thing',
    method: 'GET',
    status: 301,
    response_body: { moved: true },
    observed_at: '2026-07-29T18:58:44Z',
  });
  assert.equal(redirected.response_body, undefined);
});
