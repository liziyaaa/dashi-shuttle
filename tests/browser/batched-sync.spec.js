import { test, expect } from '@playwright/test';
const empty = () => ({ schema: 1, bookings: [], extras: [], settings: { fares: { 大石: 0, 马岭: 4000, 江门: 2000, 兴文高铁站: 6000 }, returnEnabled: true, updatedAt: '2020-01-01T00:00:00.000Z' } });
const row = (id, date) => ({ id, date, hour: '07:00', direction: 'outbound', stop: '马岭', pickup: '历史测试点', phone: '13800000000', name: '历史乘客', passengers: 1, fare: 4000, paid: true, status: 'booked', note: '', updatedAt: '2026-10-18T00:00:00.000Z' });
async function api(context, initial = empty()) {
  const files = new Map([['ledger.json', { sha: '1', data: initial }]]); const calls = []; let revision = 1;
  await context.route('https://api.github.com/**', async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, Cache-Control, Pragma' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = request.url().split('/contents/')[1] || ''; calls.push({ path, method: request.method() });
    if (!path) return route.fulfill({ headers, json: { private: true, default_branch: 'main' } });
    const file = files.get(path);
    if (request.method() === 'GET') return file ? route.fulfill({ headers, json: { sha: file.sha, content: Buffer.from(JSON.stringify(file.data)).toString('base64') } }) : route.fulfill({ headers, status: 404, json: {} });
    const body = request.postDataJSON();
    if (body.sha !== file?.sha) return route.fulfill({ headers, status: 409, json: {} });
    files.set(path, { sha: String(++revision), data: JSON.parse(Buffer.from(body.content, 'base64').toString()) });
    return route.fulfill({ headers, json: {} });
  });
  return { files, calls, get writes() { return calls.filter(c => c.method === 'PUT'); } };
}
async function connect(page) {
  await page.clock.install({ time: new Date('2026-10-18T08:00:00Z') });
  await page.goto('/'); await page.locator('.bottom-nav [data-page="settings"]').click();
  await page.locator('[name="token"]').fill('github_pat_test'); await page.locator('#sync-form button').click();
  await expect(page.locator('.sync-state')).toContainText('已同步');
  await page.locator('.bottom-nav [data-page="bookings"]').click();
  await page.locator('[data-hour="07:00"]').click();
}
async function add(page, pickup) {
  await page.getByRole('button', { name: '新增预约', exact: true }).click();
  await page.locator('#booking-form [name="pickup"]').fill(pickup);
  await page.locator('#booking-form [name="phone"]').fill('13800000000');
  await page.locator('#booking-form button[type="submit"]').click();
}
test('30-second upload batch is durable and continuous edits do not postpone its deadline', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  try {
    const service = await api(context); const page = await context.newPage(); await connect(page);
    const before = service.writes.length;
    await add(page, '第一笔');
    await expect(page.locator('#sync-summary')).toContainText('待上传');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dashi-shuttle:v1')).bookings.length)).toBe(1);
    await page.clock.runFor(20000); await add(page, '第二笔');
    expect(service.writes.length).toBe(before);
    await page.clock.runFor(10500);
    await expect.poll(() => service.files.get('ledger.json').data.bookings.length).toBe(2);
    expect(service.writes.length - before).toBe(1);
    await expect(page.locator('#sync-summary')).toContainText('已同步');
  } finally { await context.close(); }
});
test('manual sync immediately uploads a pending batch and refreshes other drivers', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const service = await api(context); const page = await context.newPage(); await connect(page);
    await add(page, '急用立即上传');
    await page.getByRole('button', { name: '立即同步', exact: true }).click();
    await expect.poll(() => service.files.get('ledger.json').data.bookings.length).toBe(1);
    await expect(page.locator('#sync-summary')).toContainText('已同步');
    expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dashi-shuttle:v1'))._sync.pending.bookings).length)).toBe(0);
  } finally { await context.close(); }
});
test('120-second poll fetches other drivers without a write or an archive download', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const service = await api(context); const page = await context.newPage(); await connect(page);
    const remote = service.files.get('ledger.json'); remote.data.bookings.push({ ...row('remote', '2026-10-18'), homeMonth: '2026-10' }); remote.sha = 'new';
    const before = service.calls.length;
    await page.clock.runFor(118000); expect(service.calls.length).toBe(before);
    await page.clock.runFor(2500);
    await expect(page.locator('.booking-card')).toHaveCount(1);
    const calls = service.calls.slice(before);
    expect(calls).toEqual([{ path: 'ledger.json', method: 'GET' }]);
  } finally { await context.close(); }
});
test('closing an offline phone retains its queue and reopening uploads it before waiting for the batch timer', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const service = await api(context); let page = await context.newPage(); await connect(page);
    await context.setOffline(true); await add(page, '离线重开保留');
    expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dashi-shuttle:v1'))._sync.pending.bookings).length)).toBe(1);
    await page.close(); await context.setOffline(false);
    page = await context.newPage(); await page.clock.install({ time: new Date('2026-10-18T08:00:10Z') }); await page.goto('/');
    await expect.poll(() => service.files.get('ledger.json').data.bookings.length).toBe(1);
    await expect(page.locator('#sync-summary')).toContainText('已同步');
    expect(service.files.get('ledger.json').data.bookings[0].pickup).toBe('离线重开保留');
  } finally { await context.close(); }
});
test('new phone reads a historical month only when selected and preserves income totals', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const initial = empty(); initial.bookings.push(row('historical', '2026-08-20'));
    const service = await api(context, initial); const page = await context.newPage(); await connect(page);
    expect(service.files.get('ledger.json').data.bookings.length).toBe(0);
    expect(service.files.has('archives/2026-08.json')).toBe(true);
    await page.evaluate(() => localStorage.removeItem('dashi-shuttle:v1'));
    service.calls.length = 0; await page.reload();
    await expect(page.locator('#sync-summary')).toContainText('已同步');
    expect(service.calls.filter(c => c.path.startsWith('archives/'))).toHaveLength(0);
    await page.locator('#selected-date').fill('2026-08-20'); await page.locator('[data-hour="07:00"]').click();
    await expect(page.locator('.booking-card')).toHaveCount(1);
    await expect(page.locator('.income-value')).toContainText('40.00');
    expect(service.calls.filter(c => c.path === 'archives/2026-08.json' && c.method === 'GET')).toHaveLength(1);
    await context.setOffline(true); await page.locator('.bottom-nav [data-page="income"]').click();
    await expect(page.locator('.income-value')).toContainText('40.00');
  } finally { await context.close(); }
});

test('a scheduled poll can pull remote changes without prematurely uploading a not-yet-due batch', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const service = await api(context); const page = await context.newPage(); await connect(page);
    await page.clock.runFor(110000); await add(page, '未到上传时间');
    const remote = service.files.get('ledger.json'); remote.data.bookings.push({ ...row('other', '2026-10-18'), homeMonth: '2026-10' }); remote.sha = 'other-revision';
    const before = service.writes.length;
    await page.clock.runFor(11000);
    await expect(page.locator('.booking-card')).toHaveCount(2);
    expect(service.writes.length).toBe(before); expect(service.files.get('ledger.json').data.bookings.length).toBe(1);
    await page.clock.runFor(20000);
    await expect.poll(() => service.files.get('ledger.json').data.bookings.length).toBe(2);
    await expect(page.locator('#sync-summary')).toContainText('已同步');
  } finally { await context.close(); }
});

test('missing historical file shows a persistent error without an automatic request loop', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const initial = { ...empty(), schema: 2, protocol: 2, cutoff: '2026-10-04', archives: { '2026-08': ['2026-08'] }, legacyHomes: {} };
    const service = await api(context, initial); const page = await context.newPage(); await connect(page);
    await page.locator('#selected-date').fill('2026-08-20');
    await expect(page.locator('#history-status')).toContainText('历史加载未完成');
    await page.clock.runFor(1000);
    expect(service.calls.filter(c => c.path.startsWith('archives/'))).toHaveLength(1);
  } finally { await context.close(); }
});
