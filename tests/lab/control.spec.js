import { test, expect } from '@playwright/test';

async function startRun(page) {
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/start' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始仿真', exact: true }).click();
  const { id } = await (await created).json();
  await expect(page.locator('#drivers')).toHaveAttribute('data-signature', new RegExp('^' + id + ':'));
  return id;
}

test('secondary write limit resumes after Retry-After while primary budget remains', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => document.querySelector('[name="drivers"]').value !== '');
  const form = page.locator('#config-form');
  for (const summary of await form.locator('details > summary').all()) await summary.click();
  for (const [name, value] of Object.entries({ drivers: 1, bookingsPerDriver: 1, durationMinutes: 1, speed: 6000, offlinePercent: 0, paidPercent: 0, boardedPercent: 0, editPercent: 0, cancelPercent: 0, settleMinutes: 3, latencyMs: 0, contentPerMinute: 1, uploadSeconds: 1, pollSeconds: 5 })) await form.locator(`[name="${name}"]`).fill(String(value));
  await form.locator('[name="recordTrace"]').uncheck(); await form.locator('[name="recordVideo"]').uncheck();
  await startRun(page);
  await expect(page.locator('#run-status')).toHaveText('自动检查通过', { timeout: 90000 });
  const result = (await (await page.request.get('/api/state')).json()).selected;
  expect(result.application.version).toBe('1.3.4');
  expect(result.metrics.quota.secondaryLimitHits).toBeGreaterThan(0);
  expect(result.metrics.quota.remaining).toBeGreaterThan(0);
  expect(result.metrics.earlyRetries).toBe(0); expect(result.automaticCheck.passed).toBe(true);
});

test('shared GitHub account quota blocks, waits until reset and automatically recovers', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => document.querySelector('[name="drivers"]').value !== '');
  const form = page.locator('#config-form');
  for (const summary of await form.locator('details > summary').all()) await summary.click();
  for (const [name, value] of Object.entries({ drivers: 1, bookingsPerDriver: 1, durationMinutes: 3, speed: 6000, offlinePercent: 0, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0, settleMinutes: 3, latencyMs: 0, primaryUsed: 4999, primaryResetSeconds: 120 })) await form.locator(`[name="${name}"]`).fill(String(value));
  await form.locator('[name="recordTrace"]').uncheck(); await form.locator('[name="recordVideo"]').uncheck();
  await startRun(page);
  await expect(page.locator('#run-status')).toHaveText('自动检查通过', { timeout: 90000 });
  await expect(page.locator('#start')).toBeEnabled();
  const result = (await (await page.request.get('/api/state')).json()).selected;
  expect(result.metrics.quota.primaryLimitHits).toBeGreaterThan(0);
  expect(result.metrics.earlyRetries).toBe(0); expect(result.localIntegrity.passed).toBe(true);
  await page.goto('/?run=' + result.id);
  await expect(page.locator('#quota-summary')).toContainText('共享账号');
  await page.locator('#load-params').click(); await expect(form.locator('[name="primaryUsed"]')).toHaveValue('4999');
});

test('WebKit preserves archived history and exports real traces and video', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => document.querySelector('[name="drivers"]').value !== '');
  const form = page.locator('#config-form');
  for (const summary of await form.locator('details > summary').all()) await summary.click();
  for (const [name, value] of Object.entries({ drivers: 1, bookingsPerDriver: 1, durationMinutes: 2, speed: 6000, offlinePercent: 0, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0, settleMinutes: 3, latencyMs: 0, historyBookings: 3, uploadSeconds: 7, pollSeconds: 15 })) await form.locator(`[name="${name}"]`).fill(String(value));
  await form.locator('[name="browser"]').selectOption('webkit');
  await form.locator('[name="recordTrace"]').check(); await form.locator('[name="recordVideo"]').check();
  await startRun(page);
  await expect(page.locator('#run-status')).toHaveText('自动检查通过', { timeout: 120000 });
  await expect(page.locator('#start')).toBeEnabled({ timeout: 30000 });
  const result = (await (await page.request.get('/api/state')).json()).selected;
  expect(result.metrics.archives).toBeGreaterThan(0);
  expect(result.metrics.cloudRecords).toBe(4);
  const served = await (await page.request.get('/app/sync.js')).text();
  expect(served).toContain('export const UPLOAD_DELAY = 7000;');
  expect(served).toContain('export const PULL_INTERVAL = 15000;');
  const { files } = await (await page.request.get('/api/files?id=' + result.id)).json();
  expect(files).toContain('driver-1-trace.zip');
  const video = files.find(file => file.endsWith('.webm')); expect(video).toBeTruthy();
  for (const file of ['summary.json', 'driver-1-trace.zip', video]) {
    const response = await page.request.get(`/artifacts/${result.id}/${file}`);
    expect(response.ok()).toBe(true); expect((await response.body()).length).toBeGreaterThan(100);
  }
});

test('control page runs real drivers, pauses, steps time and exports independent automatic results', async ({ page }, testInfo) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: /仿真实验室/ })).toBeVisible();
  await page.waitForFunction(() => document.querySelector('[name="drivers"]').value !== '');
  const form = page.locator('#config-form');
  for (const summary of await form.locator('details > summary').all()) await summary.click();
  for (const [name, value] of Object.entries({ drivers: 2, bookingsPerDriver: 1, durationMinutes: 6, speed: 6000, offlinePercent: 50, offlineStartPercent: 20, offlineMinutes: 3, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0, settleMinutes: 2, latencyMs: 0 })) await form.locator(`[name="${name}"]`).fill(String(value));
  await form.locator('[name="recordTrace"]').uncheck();
  await form.locator('[name="recordVideo"]').uncheck();
  await startRun(page);
  await expect(page.locator('#pause')).toBeEnabled(); await page.locator('#pause').click();
  await expect(page.locator('#run-status')).toHaveText('已暂停');
  await page.locator('#step').click();
  await expect.poll(async () => {
    const state = await page.request.get('/api/state'); return (await state.json()).selected.elapsedMinutes;
  }, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  await page.locator('#resume').click();
  await expect(page.locator('#run-status')).toHaveText('自动检查通过', { timeout: 120000 });
  await expect(page.locator('#checks')).toContainText('自动检查：一致');
  await expect(page.locator('#m-created')).toHaveText('2 / 2');
  await expect(page.locator('#m-pending')).toHaveText('0');
  await expect(page.locator('#drivers .driver')).toHaveCount(2);
  await expect(page.locator('#download-summary')).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.selected.coverage.offlineBookings).toBeGreaterThan(0);
  expect(state.selected.coverage.restarted).toBe(1);
  expect(state.selected.automaticCheck.passed).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('simulation-control.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('fault conditions remain visible after automatic and manual checks; stop is not a pass', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => document.querySelector('[name="drivers"]').value !== '');
  const form = page.locator('#config-form');
  for (const summary of await form.locator('details > summary').all()) await summary.click();
  for (const [name, value] of Object.entries({ drivers: 1, bookingsPerDriver: 1, durationMinutes: 2, speed: 6000, offlinePercent: 0, paidPercent: 0, boardedPercent: 0, editPercent: 0, cancelPercent: 0, settleMinutes: 1, latencyMs: 0, rateLimitEvery: 1, retryAfterSeconds: 60 })) await form.locator(`[name="${name}"]`).fill(String(value));
  await form.locator('[name="recordTrace"]').uncheck(); await form.locator('[name="recordVideo"]').uncheck(); await form.locator('[name="liveFrames"]').uncheck();
  await startRun(page);
  await expect(page.locator('#run-status')).toHaveText('发现问题', { timeout: 90000 });
  await expect(page.locator('#checks')).toContainText('自动检查：发现差异');
  const result = (await (await page.request.get('/api/state')).json()).selected;
  expect(result.automaticCheck.passed).toBe(false); expect(result.recoveryCheck.passed).toBe(false);
  expect(result.metrics.rateLimits).toBeGreaterThan(0);
  expect(result.metrics.cloudRecords).toBe(0); expect(result.coverage.created).toBe(1);
  expect(result.drivers[0].pending).toBe(1);
  await expect(page.locator('#findings')).toContainText('云端缺少预约');
  await expect(page.locator('#start')).toBeEnabled();
  await form.locator('[name="rateLimitEvery"]').fill('0');
  await form.locator('[name="durationMinutes"]').fill('120'); await form.locator('[name="speed"]').fill('1');
  await startRun(page);
  await expect(page.locator('#stop')).toBeEnabled(); await page.locator('#stop').click();
  await expect(page.locator('#run-status')).toHaveText('已停止', { timeout: 30000 });
  await expect(page.locator('#findings')).toContainText('不能作为完整通过结果');
});
