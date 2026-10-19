import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({
  ...base,
  testDir: './tests/lab', workers: 1, timeout: 180000,
  outputDir: 'test-results/lab',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-lab', open: 'never' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:9340', viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false },
  webServer: { command: 'node simulator/server.mjs', url: 'http://127.0.0.1:9340', reuseExistingServer: true },
});
