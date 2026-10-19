import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, DEFAULT_CONFIG, randomGenerator } from '../simulator/config.mjs';
import { createService } from '../simulator/service.mjs';
import { createLabServer } from '../simulator/server.mjs';
import { Simulation } from '../simulator/engine.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const api = 'https://api.github.com/repos/liziyaaa/dashi-shuttle-data';
test('simulator validates workload, date, booleans and injection parameters', () => {
  assert.deepEqual(validateConfig(), DEFAULT_CONFIG);
  for (const value of [{ drivers: 0 }, { drivers: '5' }, { drivers: 20, bookingsPerDriver: 30 }, { startTime: '2026-02-30T07:00' }, { startTime: '2019-01-01T07:00' }, { browser: 'shell' }, { recordTrace: 'true' }, { errorPercent: 100 }, { unknown: 1 }]) assert.throws(() => validateConfig(value));
  assert.equal(validateConfig({ startTime: '2028-02-29T07:00', drivers: 20, bookingsPerDriver: 10 }).drivers, 20);
});
test('scenario seeds generate reproducible schedules', () => {
  const a = randomGenerator(42), b = randomGenerator(42), c = randomGenerator(43);
  const first = Array.from({ length: 10 }, a);
  assert.deepEqual(first, Array.from({ length: 10 }, b)); assert.notDeepEqual(first, Array.from({ length: 10 }, c));
});
test('fake service performs SHA writes and blocks other destinations', async () => {
  const service = createService({ ...DEFAULT_CONFIG, latencyMs: 0 }, () => 100000);
  const driver = { id: 1, offline: false };
  assert.equal((await service.handle({ method: 'GET', url: api }, driver)).json.private, true);
  const payload = { ...service.files.get('ledger.json').data, bookings: [] };
  const body = { sha: '1', content: Buffer.from(JSON.stringify(payload)).toString('base64') };
  assert.equal((await service.handle({ method: 'PUT', url: api + '/contents/ledger.json', body }, driver)).status, 200);
  assert.equal((await service.handle({ method: 'PUT', url: api + '/contents/ledger.json', body }, driver)).status, 409);
  assert.equal((await service.handle({ method: 'GET', url: 'https://example.com' }, driver)).abort, true);
  assert.equal(service.metrics().savedWrites, 1); assert.equal(service.active, 0);
});
test('fake rate limits follow simulated time, not wall time', async () => {
  let now = 100000; const service = createService({ ...DEFAULT_CONFIG, latencyMs: 0, rateLimitEvery: 2, retryAfterSeconds: 60 }, () => now); const phone = { id: 1 };
  assert.equal((await service.handle({ method: 'GET', url: api }, phone)).status, 200);
  assert.equal((await service.handle({ method: 'GET', url: api }, phone)).status, 429);
  now += 30000; assert.equal((await service.handle({ method: 'GET', url: api }, phone)).status, 429);
  now += 31000; await service.handle({ method: 'GET', url: api }, { id: 2 });
  assert.equal(service.metrics().rateLimits, 2);
});
test('a lost write response can leave committed data; retries must preserve it', async () => {
  // Force the transport branch deterministically; public parameter validation
  // separately caps this probability at 30%.
  const service = createService({ ...DEFAULT_CONFIG, latencyMs: 0, lostResponsePercent: 100 }, () => 100000);
  const data = { ...service.files.get('ledger.json').data, bookings: [{ id: 'committed', updatedAt: '2026-10-19T00:00:00Z' }] };
  const result = await service.handle({ method: 'PUT', url: api + '/contents/ledger.json', body: { sha: '1', content: Buffer.from(JSON.stringify(data)).toString('base64') } }, { id: 1 });
  assert.equal(result.abort, true); assert.equal(service.allRecords()[0].id, 'committed'); assert.equal(service.metrics().lostResponses, 1);
});
test('diagnostics flag missing fields and pending devices without counting rescue as automatic success', () => {
  const sim = new Simulation('test', DEFAULT_CONFIG, 'http://127.0.0.1/app/', '.');
  const row = { id: 'a', date: '2026-10-19', name: '模拟', fare: 4000, passengers: 1, paid: true };
  sim.expected.set('a', row); sim.coverage.created = 9;
  sim.service.files.get('ledger.json').data.bookings = [{ ...row, paid: false }];
  sim.phones.push({ id: 1, rows: [row], view: { pending: 1 } });
  const automatic = sim.check(); assert.equal(automatic.passed, false); assert.ok(automatic.issues.some(issue => issue.message.includes('paid')));
  sim.service.files.get('ledger.json').data.bookings = [row]; sim.phones[0].view.pending = 0;
  assert.equal(sim.check().passed, true); assert.equal(automatic.passed, false);
  sim.phones[0].rows.push({ ...row, id: 'unexpected-local' });
  assert.equal(sim.check().passed, false, 'extra local active rows must not pass convergence');
});
test('local controller serves the panel and rejects cross-origin or invalid runs', async () => {
  const output = await mkdtemp(join(tmpdir(), 'shuttle-lab-test-'));
  const lab = await createLabServer({ port: 0, output });
  try {
    const state = await (await fetch(lab.origin + '/api/state')).json();
    assert.equal((await fetch(lab.origin)).status, 200);
    assert.equal((await fetch(lab.origin + '/app/.git/config')).status, 404);
    const badOrigin = await fetch(lab.origin + '/api/start', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'X-Lab-Token': state.token }, body: '{}' });
    assert.equal(badOrigin.status, 403);
    const invalid = await fetch(lab.origin + '/api/start', { method: 'POST', headers: { Origin: lab.origin, 'X-Lab-Token': state.token }, body: JSON.stringify({ drivers: 0 }) });
    assert.equal(invalid.status, 400); assert.equal((await (await fetch(lab.origin + '/api/state')).json()).running, false);
  } finally {
    await lab.close();
    assert.equal(dirname(resolve(output)), resolve(tmpdir()));
    assert.ok(basename(output).startsWith('shuttle-lab-test-'));
    await rm(output, { recursive: true, force: true });
  }
});
