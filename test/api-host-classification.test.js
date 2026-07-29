// Backlog Issue 2: a JSON API at a bare resource path was dropped as `other`.
//
// `requestKind` reached `api` via the content-type, the path, or a non-GET
// method. None of those fires for a GET to api.github.com/repos/{o}/{r} in a
// capture that omits the content-type - the "api" is in the HOST - so the
// endpoint this project quotes more than any other was classified `other`,
// excluded from the dependency set, and the audit reported no third-party
// dependencies at all. A wrong answer that looks like a clean one.
//
// The rule is narrow on purpose. It matches a host LABEL, not a substring, and
// anything it declines stays `other`. Widening it adds dependencies to a
// customer's quota, so the safe direction to be wrong in is downward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestKind, isDependencyKind } from '../packages/core/classify.js';

const kind = (over) => requestKind({ method: 'GET', path_raw: '/repos/facebook/react', ...over });

test('an api host is a dependency even with no content-type and no api in the path', () => {
  assert.equal(kind({ host_display: 'api.github.com' }), 'api');
  assert.equal(isDependencyKind(kind({ host_display: 'api.github.com' })), true);
  assert.equal(kind({ host_display: 'api.stripe.com', path_raw: '/v1/charges/ch_1' }), 'api');
  // A nested label counts too: many vendors publish api.<region>.<vendor>.com.
  assert.equal(kind({ host_display: 'eu.api.example.com' }), 'api');
  assert.equal(kind({ host_display: 'rest.example.com' }), 'api');
});

test('a substring is not a label, so near-misses stay out', () => {
  // These are the reason the rule is anchored. Each contains "api" and none is
  // an api host, and classifying them would put someone else's marketing site
  // into a customer's monitored-dependency count.
  for (const host of ['www.googleapis.com', 'rapidapi.example.com', 'apiary.example.com', 'therapist.example']) {
    assert.equal(kind({ host_display: host }), 'other', `${host} must not classify as api on its host alone`);
  }
});

test('the content-type still wins, and still classifies correctly', () => {
  assert.equal(kind({ host_display: 'www.googleapis.com', response_content_type: 'application/json' }), 'api');
  assert.equal(kind({ host_display: 'api.github.com', response_content_type: 'text/html' }), 'page');
});

test('an api host does not override a more specific kind', () => {
  // Order matters in requestKind: assets, media and telemetry are decided
  // before the api test, so a static file served from an api host stays an
  // asset rather than becoming a monitored dependency.
  assert.equal(kind({ host_display: 'api.example.com', path_raw: '/static/app.js' }), 'asset');
  assert.equal(kind({ host_display: 'api.example.com', path_raw: '/logo.png' }), 'image');
  assert.equal(
    kind({ host_display: 'api.example.com', path_raw: '/graphql' }),
    'graphql',
    'graphql is decided before the api fallback',
  );
});
