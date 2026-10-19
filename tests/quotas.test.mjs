import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../simulator/config.mjs';
import { createQuotaModel } from '../simulator/quotas.mjs';
import { createService } from '../simulator/service.mjs';

test('PAT owner quota is shared between drivers and resets by simulated time', async () => {
  let time = 100000;
  const service = createService({ ...DEFAULT_CONFIG, latencyMs: 0, primaryUsed: 4998, primaryResetSeconds: 180 }, () => time);
  const request = { method: 'GET', url: 'https://api.github.com/repos/liziyaaa/dashi-shuttle-data' };
  assert.equal((await service.handle(request, { id: 1 })).headers['x-ratelimit-remaining'], '1');
  assert.equal((await service.handle(request, { id: 2 })).headers['x-ratelimit-remaining'], '0');
  const denied = await service.handle(request, { id: 3 });
  assert.equal(denied.status, 403); assert.equal(denied.headers['x-ratelimit-reset'], '280');
  time += 180000;
  assert.equal((await service.handle(request, { id: 3 })).status, 200);
  assert.equal(service.metrics().earlyRetries, 0);
});

test('other projects consume shared requests and content budget; disabled model does not block', () => {
  let time = 0;
  const config = { ...DEFAULT_CONFIG, otherRequestsPerHour: 1200, otherWritesPerHour: 120, contentPerMinute: 2 };
  const quota = createQuotaModel(config, () => time);
  time = 60000;
  assert.equal(quota.state().remaining, 4980);
  assert.equal(quota.admit('PUT', 'ledger').reason, 'secondary');
  time = 1800000;
  assert.equal(quota.state().otherProjectRequests, 600);
  const disabled = createQuotaModel({ ...config, githubLimits: false, primaryUsed: 5000 }, () => time);
  assert.equal(disabled.admit('PUT', 'ledger'), null);
  assert.throws(() => validateConfig({ otherRequestsPerHour: 100, otherWritesPerHour: 101 }));
  assert.throws(() => validateConfig({ primaryUsed: 5001 }));
});

test('content minute and hour windows expire separately; endpoint points and concurrency are checked', () => {
  let time = 0;
  const quota = createQuotaModel({ ...DEFAULT_CONFIG, contentPerMinute: 2, contentPerHour: 3 }, () => time);
  assert.equal(quota.admit('PUT', 'ledger'), null); assert.equal(quota.admit('PUT', 'ledger'), null);
  assert.equal(quota.admit('PUT', 'ledger').reason, 'secondary');
  time = 61000;
  assert.equal(quota.admit('PUT', 'ledger'), null);
  time = 122000;
  assert.equal(quota.admit('PUT', 'ledger').reason, 'secondary');
  time = 3662000;
  assert.equal(quota.admit('PUT', 'ledger'), null);
  const points = createQuotaModel({ ...DEFAULT_CONFIG, contentPerMinute: 1000 }, () => time);
  for (let i = 0; i < 180; i++) assert.equal(points.admit('PUT', 'same-endpoint'), null);
  assert.equal(points.admit('PUT', 'same-endpoint').reason, 'secondary');
  assert.equal(points.admit('GET', 'other', 101).reason, 'secondary');
});
