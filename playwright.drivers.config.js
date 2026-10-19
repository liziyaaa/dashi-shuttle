import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig(base, {
  testDir: './tests/simulation',
  workers: 1,
  timeout: 180000,
  outputDir: 'test-results/drivers',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-drivers', open: 'never' }],
    ['json', { outputFile: 'test-results/drivers/results.json' }],
  ],
});
