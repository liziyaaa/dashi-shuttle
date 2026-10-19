import { test, expect } from '@playwright/test';
test.use({ timezoneId: 'Asia/Shanghai' });
const row = (id, hour, stop = '马岭', patch = {}) => ({ id, date: '2026-10-18', hour, direction: 'outbound', stop, pickup: `${stop}测试点`, phone: '13800000000', name: id, passengers: 1, fare: 2000, paid: false, status: 'booked', note: '', updatedAt: '2026-10-18T00:00:00.000Z', ...patch });
async function setup(page, time = '2026-10-18T07:30:00Z') {
  await page.clock.install({ time: new Date(time) });
  // Seed one real local ledger; no production sync or passenger data is used.
  await page.addInitScript(data => localStorage.setItem('dashi-shuttle:v1', JSON.stringify(data)), {
    schema: 1,
    bookings: [row('next17', '17:00', '大石'), row('past14', '14:00', '江门'), row('next16a', '16:00'), row('early09', '09:00', '大石'), row('next16b', '16:00', '江门'), row('tomorrow', '17:00', '马岭', { date: '2026-10-19' }), row('yesterday', '17:00', '马岭', { date: '2026-10-17' }), row('return', '16:00', '兴文高铁站', { direction: 'return' })],
    extras: [], settings: { fares: { 大石: 0, 马岭: 4000, 江门: 2000, 兴文高铁站: 6000 }, returnEnabled: true, updatedAt: '2020-01-01T00:00:00.000Z' }
  });
  await page.goto('/');
}
const ids = page => page.locator('.booking-card').evaluateAll(cards => cards.map(card => card.dataset.record));
test('hour click filters, second click returns to today, and all-day rows keep chronological order and time badges', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.list-title h2')).toHaveText('今日乘客');
  expect(await ids(page)).toEqual(['early09', 'past14', 'next16a', 'next16b', 'next17']);
  await expect(page.locator('.booking-card.past-departure')).toHaveCount(2);
  await expect(page.locator('.departure-time')).toHaveText(['09:00', '14:00', '16:00', '16:00', '17:00']);
  await page.locator('[data-hour="16:00"]').click();
  expect(await ids(page)).toEqual(['next16a', 'next16b']);
  await expect(page.locator('[data-hour="16:00"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.departure-time')).toHaveCount(0);
  await page.locator('[data-hour="16:00"]').click();
  await expect(page.locator('.list-title h2')).toHaveText('今日乘客');
  expect(await ids(page)).toEqual(['early09', 'past14', 'next16a', 'next16b', 'next17']);
  await expect(page.locator('.hour.active')).toHaveCount(0);
  expect(await page.locator('[data-record="past14"]').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(await page.locator('[data-record="next17"]').evaluate(el => getComputedStyle(el).backgroundColor));
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
test('deselecting a trip on a different date resets to the phone local today', async ({ page }) => {
  await setup(page);
  await page.locator('#selected-date').fill('2026-10-19');
  await page.locator('[data-hour="17:00"]').click();
  expect(await ids(page)).toEqual(['tomorrow']);
  await page.locator('[data-hour="17:00"]').click();
  await expect(page.locator('#selected-date')).toHaveValue('2026-10-18');
  await expect(page.locator('.booking-card')).toHaveCount(5);
});
test('departed styling follows local time as the next trip passes', async ({ page }) => {
  await setup(page, '2026-10-18T07:59:30Z');
  await expect(page.locator('[data-record="next16a"]')).not.toHaveClass(/past-departure/);
  await page.clock.runFor(61000);
  await expect(page.locator('[data-record="next16a"]')).toHaveClass(/past-departure/);
  await expect(page.locator('[data-record="next17"]')).not.toHaveClass(/past-departure/);
  await expect(page.locator('.booking-card.past-departure')).toHaveCount(4);
});
test('today all-day view follows local midnight while browsing a historical date remains intentional', async ({ page }) => {
  await setup(page, '2026-10-18T15:59:30Z');
  await expect(page.locator('#selected-date')).toHaveValue('2026-10-18');
  await page.clock.runFor(61000);
  await expect(page.locator('#selected-date')).toHaveValue('2026-10-19');
  expect(await ids(page)).toEqual(['tomorrow']);
  await page.locator('#selected-date').fill('2026-10-17'); await page.locator('.brand').focus();
  await page.clock.runFor(61000);
  await expect(page.locator('#selected-date')).toHaveValue('2026-10-17');
});
test('day-wide search and direction work, income trip drilldown forces one trip, and the redundant income note is removed', async ({ page }) => {
  await setup(page);
  await page.locator('#passenger-search').fill('next17');
  expect(await ids(page)).toEqual(['next17']);
  await page.locator('#passenger-search').fill('');
  await page.locator('[data-direction="return"]').click();
  expect(await ids(page)).toEqual(['return']);
  await page.locator('[data-direction="outbound"]').click();
  await page.locator('.bottom-nav [data-page="income"]').click();
  await expect(page.locator('#app')).not.toContainText('实收 =');
  await page.locator('[data-view-trip="17:00"]').click();
  await expect(page.locator('.list-title h2')).toHaveText('17:00 乘客');
  expect(await ids(page)).toEqual(['next17']);
  await page.locator('[data-hour="17:00"]').click();
  await expect(page.locator('.booking-card')).toHaveCount(5);
});

test('compact phone home removes redundant captions and fits one passenger above navigation with safe areas', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dashi-shuttle:connection:v1', JSON.stringify({ token: 'github_pat_test' })));
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 401, json: {} }));
  await setup(page);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addStyleTag({ content: '.page-scroll { padding-top: 59px; } .bottom-nav { padding-bottom: 42px; }' });
  await page.locator('#page-scroll').evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('.route-pill, .route-line, .toolbar-note, .list-title > span, .sync-toolbar')).toHaveCount(0);
  await expect(page.locator('#sync-summary')).toHaveCount(1);
  const header = await page.locator('.app-header').boundingBox();
  const sync = await page.locator('.header-sync').boundingBox();
  expect(sync.y).toBeGreaterThanOrEqual(header.y);
  expect(sync.y + sync.height).toBeLessThanOrEqual(header.y + header.height);
  const cards = await page.locator('.overview').boundingBox(); expect(cards.height).toBeLessThan(110);
  const passenger = await page.locator('.booking-card').first().boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(passenger.y + passenger.height).toBeLessThanOrEqual(nav.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.schedule-wrap [data-direction]')).toHaveText(['开往高铁', '开往大石']);
  await expect(page.locator('.schedule-wrap small')).not.toContainText(['时间为始发站发车时间']);
  await expect(page.locator('.footnote')).toHaveCount(0);
  await page.locator('.bottom-nav [data-page="income"]').click();
  const incomeCards = await page.locator('.income-overview').boundingBox();
  expect(Math.abs(incomeCards.height - cards.height)).toBeLessThan(2);
  expect(Math.abs(incomeCards.width - cards.width)).toBeLessThan(2);
});
