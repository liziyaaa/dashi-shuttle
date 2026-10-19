import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncClient, encodeData } from '../sync.js';
import { freshData } from '../core.js';
import { emptyPending } from '../scheduler.js';

for (const status of [403, 429]) test(`secondary ${status} obeys Retry-After instead of an unrelated primary reset`, async t => {
  let now = Date.UTC(2026, 9, 19, 0), limited = true, requests = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    if (limited) return Response.json({ message: 'secondary rate limit' }, { status, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4500', 'x-ratelimit-reset': String((now + 3600000) / 1000) } });
    if (options.method === 'PUT') return Response.json({});
    return url.includes('/contents/') ? Response.json({ sha: '1', content: encodeData(freshData()) }) : Response.json({ private: true, default_branch: 'main' });
  });
  const client = createSyncClient({ repo: 'owner/private', token: 'github_pat_fake' });
  const sync = () => client.sync(freshData, () => {}, undefined, { today: '2026-10-19', pending: emptyPending() });
  await assert.rejects(sync(), error => { assert.equal(error.retryAt, now + 60000); return true; });
  now += 59000; const before = requests;
  await assert.rejects(sync(), /限流/); assert.equal(requests, before);
  now += 1001; limited = false;
  await sync(); assert.ok(requests > before);
});

test('exhausted primary quota still blocks through its reset even if Retry-After is shorter', async t => {
  let now = Date.UTC(2026, 9, 19, 0), requests = 0;
  const reset = now + 3600000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) } }); });
  const client = createSyncClient({ repo: 'owner/private', token: 'github_pat_fake' });
  const sync = () => client.sync(freshData, () => {}, undefined, { today: '2026-10-19', pending: emptyPending() });
  await assert.rejects(sync(), error => error.retryAt === reset);
  now += 61000; await assert.rejects(sync(), /限流/); assert.equal(requests, 1);
});
