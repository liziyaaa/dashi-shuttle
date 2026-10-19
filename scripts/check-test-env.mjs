import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
if (Number(process.versions.node.split('.')[0]) < 20) problems.push('请安装 Node.js 20 或更高版本');
let runtime;
try { runtime = await import('@playwright/test'); }
catch { problems.push('测试依赖尚未安装，请先运行 npm ci'); }
if (runtime) {
  for (const name of ['chromium', 'webkit']) {
    const path = name === 'chromium' && process.env.CHROME_PATH ? process.env.CHROME_PATH : runtime[name].executablePath();
    const found = existsSync(path);
    console.log(`${found ? 'OK' : 'MISSING'} ${name}: ${path}`);
    if (!found) problems.push(`${name} 缺失：运行 npm run test:setup${process.env.CHROME_PATH && name === 'chromium' ? '，或检查 CHROME_PATH' : ''}`);
    else {
      let browser;
      try {
        browser = await runtime[name].launch({ headless: true, timeout: 15000, ...(name === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
        console.log(`OK ${name} 实际启动：${browser.version()}`);
      } catch (error) { problems.push(`${name} 无法启动：${error.message.split('\n')[0]}。请运行 npm run test:setup；Linux 还需安装系统库。`); }
      finally { await browser?.close(); }
    }
  }
}
try {
  execFileSync('git', ['cat-file', '-e', '9b26f14:index.html'], { cwd: root, stdio: 'pipe' });
  console.log('OK 升级测试所需的 v1.2.0 Git 历史');
} catch { problems.push('升级测试需要完整 Git 历史，请运行 git fetch --unshallow（浅克隆时）或 git fetch origin'); }
for (const path of ['playwright.config.js', 'scripts/serve.mjs', 'tests/browser/upgrade.spec.js']) {
  if (!existsSync(resolve(root, path))) problems.push(`缺少项目文件：${path}`);
}
console.log('测试日期/时区：Asia/Shanghai；本地地址：http://127.0.0.1:4173/');
if (problems.length) { console.error(problems.map(text => `- ${text}`).join('\n')); process.exitCode = 1; }
else console.log('Playwright 环境检查通过。');
