import { test, expect } from '@playwright/test';
test('phone booking, collect, daily totals, return fare, and persistence', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今天的行程' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-home.png') });
  await page.locator('[data-hour="07:00"]').click();
  await page.getByRole('button', { name: '新增预约' }).click();
  const form = page.locator('#booking-form');
  await expect(form.locator('[name="fare"]')).toHaveValue('40.00');
  await form.locator('[name="pickup"]').fill('马岭农贸市场门口');
  await form.locator('[name="phone"]').fill('13800000000');
  await form.locator('[name="name"]').fill('测试乘客');
  await form.locator('[name="passengers"]').fill('2');
  await expect(page.locator('#form-total')).toHaveText('¥80.00');
  await form.getByRole('button', { name: '保存预约' }).click();
  await expect(page.locator('.booking-card')).toHaveCount(1);
  await expect(page.locator('.booking-card a[href="tel:13800000000"]')).toBeVisible();
  await page.getByRole('button', { name: '收款', exact: true }).click();
  await page.locator('#confirm-action').click();
  await expect(page.locator('.income-value')).toContainText('80.00');
  await page.getByRole('button', { name: '标记上车' }).click();
  await expect(page.locator('.booking-card .status')).toHaveText('已上车');
  await page.reload();
  await page.locator('[data-hour="07:00"]').click();
  await expect(page.locator('.booking-card')).toHaveCount(1);
  await page.locator('.bottom-nav [data-page="income"]').click();
  await page.getByRole('button', { name: '补记收入', exact: true }).click();
  await page.locator('#extra-form [name="amount"]').fill('20');
  await page.locator('#extra-form [name="note"]').fill('临时上车 1 人');
  await page.locator('#extra-form button[type="submit"]').click();
  await expect(page.locator('.income-value')).toContainText('100.00');
  await page.locator('.bottom-nav [data-page="bookings"]').click();
  await page.getByRole('button', { name: '返回大石 ↙' }).click();
  await page.getByRole('button', { name: '新增预约' }).click();
  await expect(form.locator('[name="fare"]')).toHaveValue('60.00');
  await expect(form.locator('[name="stop"][value="兴文高铁站"]')).toBeChecked();
  await page.locator('[data-close="booking-dialog"]').click();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('cancelled bookings excluded, paid reversal and deletion', async ({ page }) => {
  await page.goto('/'); await page.locator('[data-hour="08:00"]').click();
  await page.getByRole('button', { name: '新增预约' }).click();
  await page.locator('#booking-form [name="pickup"]').fill('江门桥头');
  await page.locator('#booking-form [name="phone"]').fill('13900000000');
  await page.locator('#booking-form [value="江门"]').check({ force: true });
  await page.locator('#booking-form [name="paid"]').selectOption('yes');
  await page.locator('#booking-form button[type="submit"]').click();
  await expect(page.locator('.income-value')).toContainText('20.00');
  await page.getByRole('button', { name: '已收款', exact: true }).click(); await page.locator('#confirm-action').click();
  await expect(page.locator('.income-value')).toContainText('0.00');
  await page.locator('[data-edit]').click(); await page.locator('#booking-form [name="status"]').selectOption('cancelled'); await page.locator('#booking-form button[type="submit"]').click();
  await expect(page.locator('.booking-card .status')).toHaveText('已取消');
  await page.locator('[data-edit]').click(); await page.locator('#delete-booking').click(); await page.locator('#confirm-action').click();
  await expect(page.locator('.booking-card')).toHaveCount(0);
});
test('offline cache, settings backup export and narrow viewport', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('heading', { name: '今天的行程' })).toBeVisible();
  await page.locator('.bottom-nav [data-page="settings"]').click();
  await expect(page.locator('#fares-form [name="马岭"]')).toHaveValue('40.00');
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出全部记录（JSON）' }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.json$/);
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await context.setOffline(false);
});
test('two independent phones sync through private GitHub API and offline additions merge', async ({ browser }) => {
  let cloud = { schema: 1, bookings: [], extras: [], settings: { fares: { 大石: 0, 马岭: 4000, 江门: 2000, 兴文高铁站: 6000 }, returnEnabled: true, updatedAt: '2020-01-01T00:00:00.000Z' } }; let revision = 1;
  const phones = [];
  for (let i = 0; i < 2; i++) {
    // API mocks must bypass service workers. Offline caching is tested separately.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('https://api.github.com/**', async route => {
      const req = route.request();
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, Cache-Control, Pragma' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (!req.url().includes('/contents/')) return route.fulfill({ headers, json: { private: true, default_branch: 'main', archived: false } });
      if (req.method() === 'GET') return route.fulfill({ headers, json: { content: Buffer.from(JSON.stringify(cloud)).toString('base64'), sha: String(revision) } });
      const body = req.postDataJSON();
      if (body.sha !== String(revision)) return route.fulfill({ status: 409, headers, json: {} });
      cloud = JSON.parse(Buffer.from(body.content, 'base64').toString()); revision++; return route.fulfill({ headers, json: {} });
    });
    const phone = await context.newPage();
    await phone.goto('/'); await phone.locator('.bottom-nav [data-page="settings"]').click(); await phone.locator('#sync-form [name="token"]').fill('github_pat_test'); await phone.locator('#sync-form button[type="submit"]').click();
    await expect(phone.locator('.sync-state')).toContainText('已同步'); phones.push({ context, phone });
  }
  const first = phones[0].phone; await first.locator('.bottom-nav [data-page="bookings"]').click(); await first.locator('[data-hour="09:00"]').click(); await first.getByRole('button', { name: '新增预约' }).click(); await first.locator('#booking-form [name="pickup"]').fill('测试同步地点'); await first.locator('#booking-form [name="phone"]').fill('13800000001'); await first.locator('#booking-form button[type="submit"]').click();
  await expect.poll(() => cloud.bookings.length).toBe(1);
  const second = phones[1].phone; await second.getByRole('button', { name: '立即同步 ↗' }).click(); await expect(second.locator('.sync-state')).toContainText('已同步'); await second.locator('.bottom-nav [data-page="bookings"]').click(); await second.locator('[data-hour="09:00"]').click(); await expect(second.locator('.booking-card')).toHaveCount(1);
  await phones[1].context.setOffline(true); await second.getByRole('button', { name: '新增预约' }).click(); await second.locator('#booking-form [name="pickup"]').fill('离线录入地点'); await second.locator('#booking-form [name="phone"]').fill('13800000002'); await second.locator('#booking-form button[type="submit"]').click(); await expect(second.locator('.booking-card')).toHaveCount(2); await phones[1].context.setOffline(false); await expect.poll(() => cloud.bookings.length).toBe(2);
  for (const { context } of phones) await context.close();
});
test('booking sheet prevents date overlap and keeps save visible on small phones', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('兴文高铁站专线 · 司机台账');
  await expect(page.locator('.brand')).toContainText('兴文高铁站专线');
  await page.getByRole('button', { name: '新增预约', exact: true }).click();
  const dialog = page.locator('#booking-dialog');
  const save = dialog.getByRole('button', { name: '保存预约' });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 430, height: 932 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(viewport);
    await expect(save).toBeInViewport({ ratio: 1 });
    const date = await dialog.locator('[name="date"]').boundingBox();
    const hour = await dialog.locator('[name="hour"]').boundingBox();
    expect(date.x + date.width <= hour.x + 1 || date.y + date.height <= hour.y + 1).toBeTruthy();
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    expect(await dialog.locator('.sheet-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBeTruthy();
    await dialog.locator('[name="note"]').fill('滚动到表单底部，保存按钮仍应可见');
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(dialog.locator('#form-title')).toBeInViewport({ ratio: 1 });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator('[name="date"]').focus();
  await dialog.locator('.sheet-body').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('mobile-booking.png') });
});


test('note focus survives a visual-only keyboard resize and iOS viewport panning', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = new EventTarget(); viewport.height = 844; viewport.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新增预约', exact: true }).click();
  const form = page.locator('#booking-form');
  await form.locator('[name="pickup"]').fill('备注键盘回归测试点');
  await form.locator('[name="phone"]').fill('13800000009');
  const note = form.locator('[name="note"]');
  await note.fill('带两件行李\n请在门口接人🚄');
  for (const [height, offsetTop] of [[420, 0], [350, 80], [300, 120], [420, 0], [844, 0]]) {
    await note.focus();
    await page.evaluate(({ height, offsetTop }) => {
      Object.assign(visualViewport, { height, offsetTop });
      visualViewport.dispatchEvent(new Event('resize'));
    }, { height, offsetTop });
    await expect.poll(() => page.evaluate(() => {
      const body = document.querySelector('.sheet-body').getBoundingClientRect();
      const note = document.querySelector('[name="note"]').getBoundingClientRect();
      const dialog = document.querySelector('#booking-dialog').getBoundingClientRect();
      return note.top >= body.top && note.bottom <= body.bottom && dialog.top >= visualViewport.offsetTop && dialog.bottom <= visualViewport.offsetTop + visualViewport.height + 1;
    })).toBeTruthy();
    await expect(note).toBeFocused();
    await expect(note).toHaveValue('带两件行李\n请在门口接人🚄');
  }
  await form.getByRole('button', { name: '保存预约' }).click();
  await page.locator('[data-edit]').click();
  await expect(note).toHaveValue('带两件行李\n请在门口接人🚄');
});

test('home date display has one line, navigates across years and opens booking on selected day', async ({ page }) => {
  await page.goto('/');
  await page.locator('#selected-date').fill('2026-12-31');
  await page.getByRole('button', { name: '后一天', exact: true }).click();
  await expect(page.locator('#selected-date')).toHaveValue('2027-01-01');
  await expect(page.locator('.home-date .date-display')).toHaveText('2027/01/01');
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const box = await page.locator('.home-date').boundingBox();
    expect(box.height).toBeLessThanOrEqual(48);
  }
  await page.getByRole('button', { name: '新增预约', exact: true }).click();
  await expect(page.locator('#booking-form [name="date"]')).toHaveValue('2027-01-01');
  await expect(page.locator('#booking-form .date-display')).toHaveText('2027年1月1日');
});
