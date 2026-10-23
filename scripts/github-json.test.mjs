import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubJson } from './github-json.mjs';

function sequence(responses) {
  let calls = 0;
  return {
    fetchImpl: async () => {
      const next = responses[calls++];
      if (next instanceof Error) throw next;
      return next;
    },
    calls: () => calls,
    sleep: async () => {},
  };
}
const json = () => new Response('{"data":{"ok":true}}');

test('recovers from the HTML server error observed in the failed sync', async () => {
  const options = sequence([new Response('<html>Bad gateway</html>', { status: 502 }), json()]);
  const { body } = await githubJson('https://api.github.com/graphql', {}, options);
  assert.equal(body.data.ok, true);
  assert.equal(options.calls(), 2);
});

test('retries invalid successful JSON responses', async () => {
  const options = sequence([new Response('<html>Unavailable</html>'), json()]);
  assert.equal((await githubJson('https://api.github.com/graphql', {}, options)).body.data.ok, true);
  assert.equal(options.calls(), 2);
});

test('retries network failures', async () => {
  const options = sequence([new TypeError('fetch failed'), json()]);
  await githubJson('https://api.github.com/graphql', {}, options);
  assert.equal(options.calls(), 2);
});

test('preserves missing and unauthorized REST results without retrying', async () => {
  for (const status of [401, 403, 404]) {
    const options = sequence([new Response('', { status })]);
    const result = await githubJson('https://api.github.com/repos/example/missing', {}, options);
    assert.equal(result.response.status, status);
    assert.equal(result.body, null);
    assert.equal(options.calls(), 1);
  }
});

test('retries exhausted API rate limits', async () => {
  const options = sequence([new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), json()]);
  await githubJson('https://api.github.com/graphql', {}, options);
  assert.equal(options.calls(), 2);
});

test('bounds retries and omits response content from the final error', async () => {
  const options = sequence([new Response('private upstream detail'), new Response('private upstream detail')]);
  await assert.rejects(
    githubJson('https://api.github.com/graphql', {}, { ...options, attempts: 2 }),
    { message: 'GitHub returned invalid JSON (HTTP 200)' },
  );
  assert.equal(options.calls(), 2);
});
