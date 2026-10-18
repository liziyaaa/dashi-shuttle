import test from 'node:test';
import assert from 'node:assert/strict';
import { freshData, mergeData, summarize, validateData } from '../core.js';
import { createSyncClient, activeCutoff, encodeData, pendingRows, reconcileActive } from '../sync.js';
import { emptyPending, allPending, markPending, acknowledgePending, createUploadScheduler } from '../scheduler.js';
const booking = (id, date = '2026-10-18', patch = {}) => ({ id, date, hour: '07:00', direction: 'outbound', stop: '马岭', pickup: '测试地点', phone: '13800000000', name: '测试乘客', passengers: 1, fare: 4000, paid: false, status: 'booked', note: '', updatedAt: '2026-10-18T00:00:00.000Z', ...patch });
const dataWith = (...rows) => ({ ...freshData(), bookings: rows });
const config = { repo: 'owner/private', token: 'github_pat_test' };
function fixture(t, initial = freshData()) {
  const original = global.fetch, files = new Map([['ledger.json', { data: structuredClone(initial), sha: '1' }]]), calls = [];
  let revision = 1, hook;
  global.fetch = async (url, options) => {
    const path = url.includes('/contents/') ? decodeURIComponent(url.split('/contents/')[1]) : '';
    calls.push({ path, method: options.method });
    const intercepted = await hook?.(path, options, files);
    if (intercepted) return intercepted;
    if (!path) return Response.json({ private: true, default_branch: 'main' });
    const file = files.get(path);
    if (options.method === 'GET') return file ? Response.json({ sha: file.sha, content: encodeData(file.data) }) : Response.json({}, { status: 404 });
    const body = JSON.parse(options.body);
    if ((file?.sha || undefined) !== body.sha) return Response.json({}, { status: 409 });
    files.set(path, { sha: String(++revision), data: JSON.parse(Buffer.from(body.content, 'base64').toString()) });
    return Response.json({});
  };
  t.after(() => { global.fetch = original; });
  return { files, calls, client: createSyncClient(config), hook: fn => { hook = fn; }, get ledger() { return files.get('ledger.json').data; } };
}
async function full(f, data, pending = allPending(data), today = '2026-10-18') {
  let accepted = data;
  await f.client.sync(() => data, next => { accepted = mergeData(accepted, next); }, undefined, { pending, today });
  return accepted;
}
test('14-day cutoff respects calendar boundaries and retains future dates', () => {
  assert.equal(activeCutoff('2026-10-18'), '2026-10-04');
  assert.equal(activeCutoff('2027-01-05'), '2026-12-22');
  assert.equal(activeCutoff('2028-03-01'), '2028-02-16');
});
test('migration archives historical records before pruning; legacy apps reject schema 2', async t => {
  const f = fixture(t, dataWith(booking('old', '2026-09-30'), booking('edge', '2026-10-04'), booking('future', '2027-01-01')));
  await full(f, freshData(), emptyPending());
  assert.equal(f.ledger.schema, 2); assert.equal(f.ledger.protocol, 2);
  assert.deepEqual(f.ledger.bookings.map(r => r.id), ['edge', 'future']);
  assert.equal(f.files.get('archives/2026-09.json').data.bookings[0].id, 'old');
  const writes = f.calls.filter(c => c.method === 'PUT').map(c => c.path);
  assert.deepEqual(writes, ['archives/2026-09.json', 'ledger.json']);
  assert.throws(() => validateData(f.ledger));
});
test('archive failure never prunes active cloud or acknowledges the upload', async t => {
  const source = dataWith(booking('old', '2026-09-20'));
  const f = fixture(t, source);
  f.hook((path, options) => path.startsWith('archives/') && options.method === 'PUT' ? Response.json({}, { status: 403 }) : null);
  await assert.rejects(full(f, source), /权限不足/);
  assert.deepEqual(f.ledger, source);
  assert.equal(f.calls.filter(c => c.path === 'ledger.json' && c.method === 'PUT').length, 0);
});
test('idle polls fetch only the active file and never reupload cached history', async t => {
  const f = fixture(t, dataWith(booking('old', '2026-09-20')));
  await full(f, freshData(), emptyPending()); f.calls.length = 0;
  const cached = dataWith(booking('cached-only', '2026-08-10'));
  await full(f, cached, emptyPending());
  assert.deepEqual(f.calls, [{ path: 'ledger.json', method: 'GET' }]);
  assert.equal(f.ledger.bookings.length, 0);
});
test('requested historical month is loaded on demand and includes deleted markers', async t => {
  const f = fixture(t, dataWith(booking('september', '2026-09-20'), booking('august', '2026-08-20')));
  await full(f, freshData(), emptyPending()); f.calls.length = 0;
  const history = await f.client.history('2026-09', f.ledger.archives);
  assert.deepEqual(history.bookings.map(r => r.id), ['september']);
  assert.deepEqual(f.calls, [{ path: 'archives/2026-09.json', method: 'GET' }]);
});
test('an old-device pending edit cannot resurrect a newer archived deletion', async t => {
  const old = booking('id', '2026-09-20', { homeMonth: '2026-09' });
  const f = fixture(t, dataWith({ id: 'id', date: old.date, homeMonth: old.homeMonth, deleted: true, updatedAt: '2026-10-18T12:00:00.000Z' }));
  await full(f, freshData(), emptyPending());
  const stale = dataWith({ ...old, date: '2026-10-20' });
  await full(f, stale);
  assert.equal(f.ledger.bookings.length, 0);
  assert.equal(f.files.get('archives/2026-09.json').data.bookings[0].deleted, true);
});
test('historical booking moved to another month is discoverable and not duplicated in totals', async t => {
  const old = booking('move', '2026-08-20');
  const f = fixture(t, dataWith(old)); await full(f, freshData(), emptyPending());
  const moved = dataWith({ ...old, homeMonth: '2026-08', date: '2026-09-12', paid: true, updatedAt: '2026-10-18T02:00:00.000Z' });
  await full(f, moved);
  assert.deepEqual(f.ledger.archives['2026-08'], ['2026-08', '2026-09']);
  const history = await f.client.history('2026-09', f.ledger.archives);
  assert.equal(history.bookings.length, 1); assert.equal(summarize(history, '2026-09-12').received, 4000);
  const future = dataWith({ ...moved.bookings[0], date: '2026-11-10', updatedAt: '2026-10-18T03:00:00.000Z' });
  await full(f, future);
  assert.equal(f.ledger.bookings[0].date, '2026-11-10');
  assert.equal(mergeData(history, validateData({ ...f.ledger, schema: 1 })).bookings.length, 1);
});
test('concurrent archive writer and active SHA conflict are retried without losing another driver', async t => {
  const f = fixture(t, dataWith(booking('old', '2026-09-10')));
  let archiveConflict = false, ledgerConflict = false;
  f.hook((path, options, files) => {
    if (options.method !== 'PUT') return;
    if (path === 'archives/2026-09.json' && !archiveConflict) {
      archiveConflict = true; files.set(path, { sha: 'other-archive', data: dataWith(booking('other-history', '2026-09-12')) });
      return Response.json({}, { status: 409 });
    }
    if (path === 'ledger.json' && !ledgerConflict) {
      ledgerConflict = true; const file = files.get(path); file.data.bookings.push(booking('other-active')); file.sha = 'other-active';
      return Response.json({}, { status: 409 });
    }
  });
  await full(f, dataWith(booking('mine')));
  assert.deepEqual(f.ledger.bookings.map(r => r.id), ['mine', 'other-active']);
  assert.deepEqual(f.files.get('archives/2026-09.json').data.bookings.map(r => r.id), ['old', 'other-history']);
});
test('rolling to a later cutoff archives only expired rows and keeps locally dirty records', async t => {
  const f = fixture(t, dataWith(booking('edge', '2026-10-04')));
  await full(f, freshData(), emptyPending(), '2026-10-18');
  await full(f, freshData(), emptyPending(), '2026-10-19');
  assert.equal(f.ledger.bookings.length, 0);
  assert.equal(f.files.get('archives/2026-10.json').data.bookings.length, 1);
  const local = dataWith(booking('pending', '2026-11-01'), booking('stale', '2026-11-02'));
  const pending = emptyPending(); pending.bookings.pending = local.bookings[0].updatedAt;
  assert.deepEqual(reconcileActive(local, freshData(), pending, '2026-10-05').bookings.map(r => r.id), ['pending']);
});
test('pull-only poll does not upload a batch whose 30-second deadline has not arrived', async t => {
  const f = fixture(t); const local = dataWith(booking('not-due'));
  await f.client.sync(() => local, () => {}, undefined, { mode: 'pull', pending: allPending(local), today: '2026-10-18' });
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
});
test('server Retry-After blocks even manual retries until the cooldown expires', async t => {
  const f = fixture(t);
  f.hook(() => Response.json({ message: 'secondary rate limit' }, { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(full(f, freshData()), e => e.retryAt > Date.now() + 100000);
  const count = f.calls.length;
  await assert.rejects(full(f, freshData()), /限流/); assert.equal(f.calls.length, count);
});
test('privacy is checked again before uploading even when read verification was cached', async t => {
  const f = fixture(t); await full(f, freshData(), emptyPending());
  f.hook(path => !path ? Response.json({ private: false, default_branch: 'main' }) : null);
  await assert.rejects(full(f, dataWith(booking('new'))), /私有仓库/);
});
test('batch acknowledgement preserves newer changes made while upload is in flight', () => {
  const before = dataWith(booking('a')), batch = allPending(before);
  const after = dataWith(booking('a', '2026-10-18', { updatedAt: '2026-10-18T01:00:00.000Z' }), booking('b'));
  const pending = markPending(batch, before, after), remaining = acknowledgePending(pending, batch);
  assert.deepEqual(Object.keys(remaining.bookings).sort(), ['a', 'b']); assert.equal(remaining.settings, '');
  assert.equal(pendingRows(after, remaining).bookings.length, 2);
});
test('30-second fixed batch deadline is not postponed by more edits and overdue restart runs immediately', () => {
  let now = 0, id = 0, runs = 0; const tasks = new Map();
  const clock = { now: () => now, setTimeout: (fn, ms) => { tasks.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: id => tasks.delete(id) };
  const queue = createUploadScheduler(() => runs++, clock);
  queue.schedule(30000); now = 20000; queue.schedule(30000);
  assert.equal(tasks.size, 1); assert.equal([...tasks.values()][0].at, 30000);
  now = 30000; const task = [...tasks.values()][0]; tasks.clear(); task.fn(); assert.equal(runs, 1);
  now = 60000; queue.schedule(30000); assert.equal([...tasks.values()][0].at, 60000);
});

test('idle polling never downloads the archive even when current-month active rows share its home', async t => {
  const f = fixture(t, dataWith(booking('old', '2026-10-01'), booking('current', '2026-10-18')));
  await full(f, freshData(), emptyPending()); f.calls.length = 0;
  await full(f, freshData(), emptyPending());
  assert.deepEqual(f.calls, [{ path: 'ledger.json', method: 'GET' }]);
});

test('missing referenced archive stops rollover instead of recreating an incomplete month', async t => {
  const f = fixture(t, dataWith(booking('older', '2026-10-01'), booking('edge', '2026-10-04')));
  await full(f, freshData(), emptyPending());
  f.files.delete('archives/2026-10.json'); const before = structuredClone(f.ledger);
  await assert.rejects(full(f, freshData(), emptyPending(), '2026-10-19'), /归档缺失/);
  assert.deepEqual(f.ledger, before); assert.equal(f.files.has('archives/2026-10.json'), false);
});
test('failed active write after successful monthly copy recovers idempotently on retry', async t => {
  const original = dataWith(booking('old', '2026-09-12'));
  const f = fixture(t, original);
  f.hook((path, options) => path === 'ledger.json' && options.method === 'PUT' ? Response.json({}, { status: 500 }) : null);
  await assert.rejects(full(f, original), /500/);
  assert.deepEqual(f.ledger, original); assert.equal(f.files.get('archives/2026-09.json').data.bookings.length, 1);
  f.hook(null); await full(f, original);
  assert.equal(f.ledger.bookings.length, 0); assert.equal(f.files.get('archives/2026-09.json').data.bookings.length, 1);
});
test('large monthly archive falls back to raw content and retains SHA metadata', async t => {
  const f = fixture(t); let raw = false;
  f.hook((path, options) => {
    if (path !== 'archives/2026-09.json') return;
    if (options.headers.Accept === 'application/vnd.github.raw+json') { raw = true; return Response.json(dataWith(booking('big', '2026-09-12'))); }
    return Response.json({ sha: 'large', encoding: 'none', content: '' });
  });
  const archive = await f.client.history('2026-09', { '2026-09': ['2026-09'] });
  assert.equal(raw, true); assert.equal(archive.bookings[0].id, 'big');
});
