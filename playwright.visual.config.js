import { defineConfig } from '@playwright/test';
import base from './playwright.drivers.config.js';

export default defineConfig(base, {
  outputDir: 'test-results/visual',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-visual', open: 'never' }],
    ['json', { outputFile: 'test-results/visual/results.json' }],
  ],
  use: { trace: 'on', video: 'on', screenshot: 'on' },
  projects: base.projects.map(project => ({
    ...project,
    use: {
      ...project.use,
      ...(project.name === 'chromium' ? { launchOptions: { ...project.use.launchOptions, slowMo: 80 } } : {}),
    },
  })),
});
