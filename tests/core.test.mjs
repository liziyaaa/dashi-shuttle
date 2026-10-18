import test from 'node:test';
import assert from 'node:assert/strict';
import { HOURS, freshData, localDate, toCents, validateData, mergeData, summarize, csvCell, incomeCSV, validDate } from '../core.js';
import { encodeData, decodeData, synchronize } from '../sync.js';

const booking = (id, patch = {}) => ({ id, date: '2026-10-18', hour: '07:00', direction: 'outbound', stop: '马岭', pickup: '市场门口', phone: '13800000000', name: '测试乘客', passengers: 2, fare: 4000, paid: false, status: 'booked', note: '', updatedAt: '2026-10-18T00:00:00.000Z', ...patch });
test('15 hourly departures include 07:00 and 21:00', () => { assert.equal(HOURS.length, 15); assert.equal(HOURS[0], '07:00'); assert.equal(HOURS.at(-1), '21:00'); });
test('amounts are exact integer cents with strict validation', () => { assert.equal(toCents('40'), 4000); assert.equal(toCents('0.29'), 29); assert.equal(toCents('1.01'), 101); assert.throws(() => toCents('1.001')); assert.throws(() => toCents('-1')); assert.throws(() => toCents('NaN')); });
test('income separates expected, unpaid and received; cancelled records do not count', () => {
  const data = freshData(); data.bookings = [booking('a', { paid: true }), booking('b', { fare: 2000, passengers: 1 }), booking('c', { paid: true, status: 'cancelled' }), booking('d', { paid: true, direction: 'return', fare: 6000, passengers: 1 })];
  data.extras = [{ id: 'e', date: '2026-10-18', hour: '07:00', direction: 'outbound', amount: 3000, note: '临时客', updatedAt: '2026-10-18T00:00:00.000Z' }];
  assert.deepEqual(summarize(data, '2026-10-18'), { count: 3, passengers: 4, waiting: 4, expected: 16000, received: 17000, unpaid: 2000, extra: 3000 });
  assert.equal(summarize(data, '2026-10-18', '07:00', 'outbound').received, 11000);
  assert.equal(summarize(data, '2026-10-19').received, 0);
});
test('merged concurrent additions and deletion tombstones survive repeated sync', () => {
  const a = freshData(); const b = freshData(); a.bookings = [booking('a'), booking('b')]; b.bookings = [booking('c'), { id: 'b', deleted: true, updatedAt: '2026-10-18T01:00:00.000Z' }];
  const merged = mergeData(a, b); assert.equal(merged.bookings.length, 3); assert.equal(merged.bookings.find(row => row.id === 'b').deleted, true); assert.deepEqual(mergeData(merged, a), merged); assert.deepEqual(mergeData(a,b), mergeData(b,a)); assert.equal(summarize(merged, '2026-10-18').passengers, 4);
});
test('validation rejects malformed backups, invalid phone, date, amount and duplicate IDs', () => {
  assert.throws(() => validateData({ schema: 2 }));
  for (const patch of [{ date: '2026-02-30' }, { fare: -1 }, { passengers: 0 }, { phone: '<script>' }, { hour: '22:00' }, { updatedAt: 'bad' }]) { const data = freshData(); data.bookings.push(booking('a', patch)); assert.throws(() => validateData(data)); }
  const data = freshData(); data.bookings = [booking('a'), booking('a')]; assert.throws(() => validateData(data));
  assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2025-02-29'), false);
});
test('UTF-8 cloud serialization round-trips Chinese and emoji without exposing keys', () => { const data = freshData(); data.bookings.push(booking('a', { note: '行李 🧳' })); assert.deepEqual(decodeData(encodeData(data)), validateData(data)); });
test('CSV includes all 30 trips and correct totals, and escapes spreadsheet formulas', () => { const data = freshData(); data.bookings.push(booking('a', { paid: true })); const csv = incomeCSV(data, '2026-10-18'); assert.equal(csv.split('\r\n').length, 32); assert.ok(csv.includes('80.00')); assert.equal(csvCell('=1+2'), '"\'=1+2"'); });
test('local date does not use UTC rollover', () => { const now = new Date(2026, 9, 18, 0, 30); assert.equal(localDate(now), '2026-10-18'); });
test('GitHub sync retries SHA conflicts, preserving other drivers additions', async () => {
  const original = global.fetch; let gets = 0; let puts = 0; let accepted = freshData(); accepted.bookings.push(booking('local'));
  global.fetch = async (url, options) => {
    if (!url.includes('/contents/')) return new Response(JSON.stringify({ private: true, default_branch: 'main', archived: false }));
    if (options.method === 'GET') { gets++; const remote = freshData(); remote.bookings.push(booking(gets === 1 ? 'remote' : 'remote2')); return new Response(JSON.stringify({ content: encodeData(remote), sha: 'sha-' + gets })); }
    puts++; if (puts === 1) return new Response('{}', { status: 409 }); const written = decodeData(JSON.parse(options.body).content); assert.equal(written.bookings.length, 3); return new Response('{}');
  };
  try { await synchronize({ repo: 'owner/private', token: 'github_pat_test' }, () => accepted, next => { accepted = next; }); assert.equal(gets, 2); assert.equal(puts, 2); } finally { global.fetch = original; }
});
test('sync refuses unreadable private data and never overwrites it', async () => { const original = global.fetch; global.fetch = async () => new Response('{}', { status: 404 }); try { await assert.rejects(synchronize({ repo: 'owner/private', token: 'github_pat_test' }, freshData, () => {}), /私有数据仓库/); } finally { global.fetch = original; } });
test('public repositories are rejected before any passenger data upload', async () => { const original = global.fetch; let calls = 0; global.fetch = async () => { calls++; return new Response(JSON.stringify({ private: false, default_branch: 'main' })); }; try { await assert.rejects(synchronize({ repo: 'owner/public', token: 'github_pat_test' }, freshData, () => {}), /私有仓库/); assert.equal(calls, 1); } finally { global.fetch = original; } });
