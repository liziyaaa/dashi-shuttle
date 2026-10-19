import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../../updates.js';

for (const previousRelease of [{ version: '1.2.0', ref: '9b26f14' }, { version: '1.3.3', ref: '4370b6a' }]) test(`installed v${previousRelease.version} upgrades once, keeps local bookings and has no repeated update banner`, async ({ page }) => {
  let upgraded = false;
  const names = ['index.html', 'app.js', 'core.js', 'ui.js', 'updates.js', 'sync.js', 'sw.js', 'scheduler.js', 'styles.css', 'manifest.webmanifest', 'version.json'];
  const previous = new Map(names.filter(name => name !== 'scheduler.js' || previousRelease.version !== '1.2.0').map(name => [name, execFileSync('git', ['show', `${previousRelease.ref}:${name}`])]));
  const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json', webmanifest: 'application/manifest+json', png: 'image/png' };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/dashi-shuttle\//, '') || 'index.html';
      if (!names.includes(path) && !/^icons\/[\w-]+\.png$/.test(path)) throw new Error('bad path');
      const content = !upgraded && previous.has(path) ? previous.get(path) : await readFile(new URL('../../' + path, import.meta.url));
      res.writeHead(200, { 'Content-Type': types[path.split('.').at(-1)], 'Cache-Control': 'no-store' }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/dashi-shuttle/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.getByRole('button', { name: '新增预约', exact: true }).click();
    await page.locator('[name="pickup"]').fill('升级前记录');
    await page.locator('[name="phone"]').fill('13800000000');
    await page.locator('#booking-form button[type="submit"]').click();
    await page.reload();
    upgraded = true;
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
    await expect(page.locator('#update-banner')).toBeVisible();
    // The banner can appear while assets are still installing. Confirm this is
    // an installed waiting worker, then observe the actual accepted reload.
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
    await Promise.all([page.waitForEvent('load'), page.locator('[data-update-now]').click()]);
    await expect(page.locator('#page-scroll')).toBeVisible();
    await expect.poll(() => page.evaluate(async version => (await import('./updates.js?v=' + version)).APP_VERSION, APP_VERSION)).toBe(APP_VERSION);
    await expect(page.locator('#update-banner')).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dashi-shuttle:v1')).bookings[0].pickup)).toBe('升级前记录');
    await page.reload();
    await expect(page.locator('#update-banner')).toBeHidden();
    await expect(page.locator('#page-scroll')).toBeVisible();
  } finally { await page.goto('about:blank'); await new Promise(resolve => server.close(resolve)); }
});
