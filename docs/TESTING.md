# Playwright 测试环境

代码目录为本 Git 仓库根目录。不要在 ChatGPT 项目的 `sources/` 镜像中安装依赖或修改资料。

## 一次性准备

需要 Node.js 20 或更高版本、npm 和完整 Git 历史。推荐使用 Node.js 24。

```sh
npm ci
npm run test:setup
npm run test:check
```

`npm ci` 根据 lockfile 安装固定依赖；`test:setup` 从 Playwright 官方源下载 Chromium 和 WebKit。环境检查会核对 Node、浏览器文件及升级测试所需的 v1.2.0、v1.3.3 Git 提交。测试浏览器独立于日常 Chrome，默认不使用个人浏览器资料或登录状态。

浅克隆需要先运行 `git fetch --unshallow`，否则升级测试无法读取旧版文件。在 Linux CI 中还需运行 `npx playwright install --with-deps chromium webkit` 安装系统库。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run test:check` | 检查环境是否齐备 |
| `npm test` | 逻辑、同步、归档、更新与 DOM 测试 |
| `npm run test:e2e` | 同时运行 Chromium 和 WebKit 浏览器回归 |
| `npm run test:all` | 环境检查、逻辑测试及浏览器回归 |
| `npm run test:e2e:chromium` | 只测 Chromium |
| `npm run test:e2e:webkit` | 只测 WebKit |
| `npm run test:e2e:headed` | 显示测试浏览器，按 1 个 worker 顺序运行 |
| `npm run test:e2e:ui` | 打开 Playwright 交互式测试界面 |
| `npm run test:report` | 打开最近一次 HTML 回归报告 |
| `npm run test:drivers` | 默认模拟 5 位独立司机，各新增 2 笔预约 |
| `npm run test:drivers:report` | 打开多司机模拟报告 |
| `npm run test:drivers:visual` | 录制 Chromium、WebKit 的操作回放及每位司机视频 |
| `npm run test:drivers:watch` | 显示司机窗口并录制，适合观看自动操作 |
| `npm run test:visual:report` | 打开带中文阶段、回放及视频的报告 |
| `npm run simulator` | 打开可自行改参数、暂停与单步推进的本机仿真实验室 |
| `npm run test:lab` | 检查实验室控制页面、故障判定和录制产物 |
| `npm run test:stress` | 在已启动的实验室中依次执行八个压力场景 |

可视化的参数仿真详见 [仿真实验室使用说明](SIMULATOR.md)。实验室独立使用 9340 端口。

不需要提前启动服务：Playwright 会运行 `node scripts/serve.mjs`，在 `http://127.0.0.1:4173/` 测试，结束后关闭自己启动的服务。若本机已有同地址的开发服务器，非 CI 模式会复用；应确认它是本仓库版本，遇到旧页面时先关闭旧服务器。只想预览页面时用 `npm run dev`。

默认手机尺寸为 390×844、中文界面、`Asia/Shanghai` 时区、触屏模式。普通回归最多 2 个 worker，CI 为 1；没有自动失败重跑掩盖不稳定结果。

## 多司机模拟

每位司机使用独立 **BrowserContext**，分别保存 localStorage、连接和待上传队列。同一 context 内的多个普通标签页共享 localStorage，不能用于模拟不同手机。

默认场景依次检查：

1. 各司机通过页面连接模拟 API，在各自手机中新增预约；上传前本机数据隔离。
2. 使用 Playwright 时钟经过真实配置的 30 秒批量间隔，让多个司机同时上传。
3. 注入 SHA 冲突，并验证重试后记录合并；若并发耗尽内置重试，本机队列必须保留并可再次同步。
4. 一台手机离线新增后关闭页面，联网重开时恢复待上传记录。
5. 全体司机刷新后记录数量、唯一 ID、待上传队列及实收金额一致。

PowerShell 中可调整规模：

```powershell
$env:DRIVER_COUNT = '10'
$env:BOOKINGS_PER_DRIVER = '3'
npm run test:drivers
Remove-Item Env:DRIVER_COUNT, Env:BOOKINGS_PER_DRIVER
```

支持 2—20 台模拟手机，每台 1—10 笔预约；默认较小，避免大量测试窗口拖慢电脑。显示窗口观察可用 `npm run test:drivers -- --headed`。如需 WebKit：

```sh
npx playwright test --config=playwright.drivers.config.js --project=webkit
```

模拟中 API 请求均由内存 fixture 接管，其他外部地址阻断，凭证固定为虚构测试值。模拟 API 的测试 context 禁用 Service Worker，防止网络拦截被它绕过；离线缓存与实际 Service Worker 升级由普通回归单独测试。

报告包含 `simulation-summary.json`，统计司机数、最终预约数、模拟 API 请求、读取、写入、SHA 冲突及台账字节数。计时是本机自动化执行时间，**不能换算成 GitHub 真实服务吞吐量**，也不能证明中国大陆网络稳定性。真实额度、限流、长时间容量和 iPhone 真机键盘表现需分别验证。

## 报告及故障排查

### 怎么可视化查看

`npm run test:visual:report` 打开后，先点击测试名称，再展开「1. 建立独立手机」至「6. 核对所有手机」的中文阶段。

- **Trace / 回放**：点击轨迹缩略图进入时间线，逐项选择点击、填表、保存和网络动作，查看对应页面快照、请求和响应。时间线可以来回检查，不只是看一段视频。
- **视频**：测试附件包含「司机 1 操作录像」到「司机 5 操作录像」以及「司机 1 联网重开录像」。每位司机单独录制。
- **请求与结果**：附件包含无密钥的模拟 API 请求明细和 `simulation-summary`，可核对记录数、请求数、冲突及最终一致性。
- **想看测试现场**：在代码目录运行 `npm run test:drivers:watch`；或用 `npm run test:e2e:ui` 打开交互式界面，选择需要的普通回归场景运行。

普通回归只在失败时保留完整 Trace；要查看通过场景的完整回放，应使用 `test:drivers:visual` 重新录制。这不会覆盖原来的普通回归报告或未录制的多司机报告。

录制报告位于 `playwright-report-visual/`，原始视频与 Trace 位于 `test-results/visual/`。报告是本机产物，`show-report` 给出的 localhost 地址仅能在运行报告服务的这台电脑访问。

30 秒批量时间通过模拟时钟推进，录像不会故意等待 30 秒；应用本身的同步间隔没有为录屏而缩短。所有画面都是自动化运行的真实测试页面，台账数据为虚构数据。

### 输出位置

- 普通 HTML 报告：`playwright-report/index.html`；机器可读结果：`test-results/results.json`。
- 多司机报告：`playwright-report-drivers/index.html`；运行产物：`test-results/drivers/`。
- 失败时保留截图和 `trace.zip`，可在 HTML 报告中查看，或运行 `npx playwright show-trace <trace.zip 路径>`。
- `Executable doesn't exist`：运行 `npm run test:setup`，之后 `npm run test:check`。
- 自定义 Chrome：设置 `CHROME_PATH` 为完整可执行文件路径；不设置时用 Playwright 管理的 Chromium。
- 端口被占用：确认 4173 是本项目，避免连接到旧版本。
- 升级测试旧提交不存在：获取完整 Git 历史，不要删除升级测试来让结果变绿。
- 报告和截图均被 `.gitignore` 排除，不提交浏览器资料或真实密钥。

参考：[Playwright 浏览器安装](https://playwright.dev/docs/browsers)、[BrowserContext 隔离](https://playwright.dev/docs/browser-contexts)、[命令行](https://playwright.dev/docs/test-cli)。
