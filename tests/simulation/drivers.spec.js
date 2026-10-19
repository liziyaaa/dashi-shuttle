import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fakeGithub } from '../helpers/fake-github.js';

function count(name, fallback, min, max) {
  const value = process.env[name] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
const drivers = count('DRIVER_COUNT', 5, 2, 20);
const perDriver = count('BOOKINGS_PER_DRIVER', 2, 1, 10);
const pendingCount = page => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dashi-shuttle:v1'))._sync.pending.bookings).length);
const localCount = page => page.evaluate(() => JSON.parse(localStorage.getItem('dashi-shuttle:v1')).bookings.length);

async function add(page, name) {
  await test.step(`录入并保存预约：${name}`, async () => {
  await page.getByRole('button', { name: '新增预约', exact: true }).click();
  const form = page.locator('#booking-form');
  await form.locator('[name="hour"]').selectOption('09:00');
  await form.locator('[name="pickup"]').fill('模拟上车点');
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="phone"]').fill('13800000000');
  await form.locator('[name="paid"]').selectOption('yes');
  await form.locator('[name="note"]').fill('自动测试虚构数据');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#booking-dialog')).not.toBeVisible();
  });
}
async function manual(page) {
  await expect(page.locator('#sync-summary')).not.toContainText('正在');
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect(page.locator('#sync-summary')).toContainText('已同步');
}

test(`${drivers} isolated drivers: concurrent batches, SHA retries and offline restart converge`, async ({ browser }, testInfo) => {
  const started = performance.now();
  const service = fakeGithub();
  const phones = [];
  const recordings = [];
  const recording = testInfo.project.use.video === 'on';
  try {
    // These contexts have independent localStorage, tokens and upload queues.
    // Page clocks are paused: the production 30s batch interval is exercised
    // explicitly without real-time waiting or changing application constants.
    await test.step(`1. 建立 ${drivers} 台独立手机并连接模拟台账`, async () => {
    for (let i = 0; i < drivers; i++) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true,
        ...(recording ? { recordVideo: { dir: testInfo.outputPath(`driver-${i + 1}-video`), size: { width: 390, height: 844 } } } : {}),
      });
      const phone = { context, page: null }; phones.push(phone);
      await service.install(context, i + 1);
      const page = phone.page = await context.newPage();
      if (recording) recordings.push({ name: `司机 ${i + 1} 操作录像`, video: page.video() });
      await page.clock.install({ time: new Date('2026-10-19T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-19T00:00:01Z'));
      await page.goto('/');
      await page.locator('.bottom-nav [data-page="settings"]').click();
      await page.locator('[name="token"]').fill('github_pat_simulation_only');
      await page.locator('#sync-form button').click();
      await expect(page.locator('.sync-state')).toContainText('已同步');
      await page.locator('.bottom-nav [data-page="bookings"]').click();
    }
    });
    await test.step(`2. 同时录入，每位司机各 ${perDriver} 笔；检查本机记录互不混用`, async () => {
    await Promise.all(phones.map(async ({ page }, i) => {
      for (let j = 0; j < perDriver; j++) await add(page, `模拟司机${i + 1}-${j + 1}`);
      expect(await localCount(page)).toBe(perDriver);
      expect(await pendingCount(page)).toBe(perDriver);
    }));
    expect(service.ledger.bookings).toHaveLength(0);
    });
    await test.step('3. 推进 30 秒触发批量上传，制造 SHA 冲突并检查重试', async () => {
    service.injectConflictOnce();
    await Promise.all(phones.map(({ page }) => page.clock.runFor(30001)));
    // Four built-in SHA retries can be exhausted under contention. Pending
    // records must remain local and succeed when a driver retries later.
    for (const { page } of phones) {
      await expect(page.locator('#sync-summary')).not.toContainText('正在');
      if (await pendingCount(page)) await manual(page);
    }
    });
    const expected = drivers * perDriver;
    await test.step(`4. 刷新各台手机，确认 ${expected} 笔预约合并且不重复`, async () => {
    expect(service.ledger.bookings).toHaveLength(expected);
    expect(new Set(service.ledger.bookings.map(row => row.id)).size).toBe(expected);
    expect(service.metrics().shaConflicts).toBeGreaterThan(0);
    for (const { page } of phones) {
      await manual(page);
      expect(await localCount(page)).toBe(expected);
      expect(await pendingCount(page)).toBe(0);
    }
    });

    // One phone loses connectivity, records another booking, then closes its
    // page. Reopening after connectivity returns must retain and upload it.
    const offline = phones[0];
    await test.step('5. 司机 1 断网新增，再关闭页面；联网重开后恢复上传', async () => {
    await offline.context.setOffline(true);
    await add(offline.page, '离线后重开');
    expect(await pendingCount(offline.page)).toBe(1);
    expect(service.ledger.bookings).toHaveLength(expected);
    await offline.page.close();
    await offline.context.setOffline(false);
    offline.page = await offline.context.newPage();
    if (recording) recordings.push({ name: '司机 1 联网重开录像', video: offline.page.video() });
    await offline.page.clock.install({ time: new Date('2026-10-19T00:00:33Z') });
    await offline.page.clock.pauseAt(new Date('2026-10-19T00:00:34Z'));
    await offline.page.goto('/');
    await expect.poll(() => service.ledger.bookings.length).toBe(expected + 1);
    await expect(offline.page.locator('#sync-summary')).toContainText('已同步');
    });
    await test.step(`6. 核对所有手机均为 ${expected + 1} 笔，队列为空且实收一致`, async () => {
    for (const { page } of phones) {
      await manual(page);
      expect(await localCount(page)).toBe(expected + 1);
      expect(await pendingCount(page)).toBe(0);
      await expect(page.locator('.income-value')).toContainText(((expected + 1) * 40).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
    });
    const summary = {
      scope: 'Local in-memory GitHub API simulation; not a real GitHub load benchmark',
      browser: testInfo.project.name, drivers, bookingsPerDriver: perDriver,
      finalBookings: expected + 1, allDevicesConverged: true,
      wallTimeMs: Math.round(performance.now() - started), ...service.metrics(),
    };
    await writeFile(testInfo.outputPath('simulation-summary.json'), JSON.stringify(summary, null, 2));
    await testInfo.attach('simulation-summary', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    await testInfo.attach('模拟 API 请求明细（不含密钥）', { body: JSON.stringify(service.calls, null, 2), contentType: 'application/json' });
  } finally {
    await Promise.all(phones.map(({ context }) => context.close()));
    for (const { name, video } of recordings) if (video) await testInfo.attach(name, { path: await video.path(), contentType: 'video/webm' });
  }
});
