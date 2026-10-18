import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4173', reuseExistingServer: true },
});
