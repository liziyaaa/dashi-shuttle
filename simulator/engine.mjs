import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { createService } from './service.mjs';
import { randomGenerator, shanghaiDate, shanghaiTime } from './config.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const fields = ['date', 'hour', 'direction', 'stop', 'pickup', 'phone', 'name', 'passengers', 'fare', 'paid', 'status', 'note'];
const receipt = rows => rows.filter(row => !row.deleted && row.paid && row.status !== 'cancelled').reduce((sum, row) => sum + row.fare * row.passengers, 0);

export class Simulation {
  constructor(id, config, appURL, directory) {
    this.id = id; this.config = config; this.appURL = appURL; this.directory = directory;
    this.startMs = Date.parse(config.startTime + ':00+08:00'); this.elapsed = 0;
    this.random = randomGenerator(config.seed); this.expected = new Map(); this.phones = []; this.frames = new Map();
    this.stopRequested = false; this.paused = false; this.stepBudget = 0; this.speed = config.speed;
    this.logs = []; this.samples = []; this.events = []; this.lastFrame = 0;
    this.coverage = { created: 0, paid: 0, boarded: 0, edited: 0, cancelled: 0, offlineBookings: 0, restarted: 0, skippedActions: 0 };
    this.service = createService(config, () => this.now(), (level, message) => this.log(level, message));
    for (const row of this.service.expectedHistory) this.expected.set(row.id, row);
    this.state = { id, config, status: 'starting', phase: '准备浏览器', startedAt: new Date().toISOString(), progress: 0, findings: [], automaticCheck: null, recoveryCheck: null };
  }
  now() { return this.startMs + this.elapsed; }
  log(level, message) {
    this.logs.push({ at: shanghaiTime(this.now()), wallAt: new Date().toISOString(), level, message });
    if (this.logs.length > 300) this.logs.shift();
  }
  snapshot() {
    const localRows = new Map();
    for (const phone of this.phones) for (const row of phone.rows) { const copies = localRows.get(row.id) || []; copies.push(row); localRows.set(row.id, copies); }
    const missingLocal = [], mismatchedLocal = [];
    for (const [id, expected] of this.expected) if (!id.startsWith('history-')) {
      const copies = localRows.get(id) || [];
      if (!copies.length) missingLocal.push(id);
      else if (!copies.some(row => fields.every(field => row[field] === expected[field]))) mismatchedLocal.push(expected.name);
    }
    return { ...this.state, paused: this.paused, speed: this.speed, virtualTime: shanghaiTime(this.now()), elapsedMinutes: this.elapsed / 60000,
      localIntegrity: { passed: !missingLocal.length && !mismatchedLocal.length, missingIds: missingLocal, mismatchedNames: mismatchedLocal },
      coverage: { ...this.coverage }, metrics: this.service.metrics(), plannedBookings: this.config.drivers * this.config.bookingsPerDriver,
      expectedRecords: this.expected.size, expectedReceipt: receipt([...this.expected.values()]), cloudReceipt: receipt(this.service.allRecords()),
      drivers: this.phones.map(phone => ({ id: phone.id, offline: phone.offline, ...phone.view, frame: this.frames.get(phone.id)?.sequence || 0 })),
      samples: this.samples, logs: this.logs, calls: this.service.calls.slice(-100),
    };
  }
  control(action, value) {
    if (!['starting', 'running'].includes(this.state.status)) throw new Error('这轮仿真已经结束');
    if (action === 'pause') { this.paused = true; this.log('info', '已暂停推进模拟时间，正在进行的操作会先完成'); }
    else if (action === 'resume') { this.paused = false; this.stepBudget = 0; this.log('info', '继续运行'); }
    else if (action === 'step') {
      if (!this.paused) throw new Error('请先暂停，再单步推进');
      if (!Number.isInteger(value) || value < 1 || value > 60) throw new Error('单步为 1—60 分钟');
      this.stepBudget += value * 60000; this.log('info', `单步推进 ${value} 分钟`);
    } else if (action === 'speed') {
      if (!Number.isInteger(value) || value < 1 || value > 6000) throw new Error('速度必须为 1—6000');
      this.speed = value; this.log('info', `时间速度改为 ${value} 倍`);
    } else if (action === 'stop') { this.stopRequested = true; this.paused = false; this.log('warning', '收到停止请求'); }
    else throw new Error('未知操作');
  }
  guard() {
    if (this.stopRequested) throw new Error('STOP_REQUESTED');
    if (performance.now() - this.wallStart > this.config.maxRealMinutes * 60000) throw new Error('已达到本轮真实运行时长上限');
  }
  async gate() { while (this.paused && this.stepBudget <= 0 && !this.stopRequested) { this.guard(); await sleep(100); } this.guard(); }
  async newPage(phone) {
    const page = phone.page = await phone.context.newPage();
    page.setDefaultTimeout(6000);
    await page.clock.install({ time: new Date(this.now() - 1000) });
    await page.clock.pauseAt(new Date(this.now()));
    await page.goto(this.appURL, { waitUntil: 'load', timeout: 20000 });
    return page;
  }
  async setup() {
    this.browser = await ({ chromium, webkit }[this.config.browser]).launch({ headless: true });
    for (let i = 1; i <= this.config.drivers; i++) {
      await this.gate();
      const context = await this.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block',
        ...(this.config.recordVideo ? { recordVideo: { dir: join(this.directory, `driver-${i}-video`), size: { width: 390, height: 844 } } } : {}),
      });
      const phone = { id: i, context, page: null, offline: false, rows: [], view: { records: 0, pending: 0, sync: '连接中', lastAction: '' } }; this.phones.push(phone);
      await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin === new URL(this.appURL).origin && url.pathname.startsWith('/app/')) return route.continue();
        const response = await this.service.handle({ url: request.url(), method: request.method(), headers: request.headers(), body: request.method() === 'PUT' ? request.postDataJSON() : undefined }, phone);
        try { if (response.abort) await route.abort('failed'); else await route.fulfill({ status: response.status, headers: response.headers, ...(response.status === 204 ? {} : { json: response.json }) }); }
        catch (error) { if (!this.stopRequested && this.state.status === 'running') this.log('warning', `司机 ${i} 的请求连接被关闭`); }
      });
      if (this.config.recordTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await this.newPage(phone);
      await page.locator('.bottom-nav [data-page="settings"]').click();
      await page.locator('[name="token"]').fill('github_pat_local_simulation_only');
      await page.locator('#sync-form button').click();
      await this.settleNetwork();
      await page.locator('.bottom-nav [data-page="bookings"]').click();
      this.log('info', `司机 ${i} 已打开独立应用环境`);
      await this.refresh(true);
    }
  }
  plan() {
    const duration = this.config.durationMinutes * 60000;
    for (let i = 0; i < this.config.drivers; i++) for (let j = 0; j < this.config.bookingsPerDriver; j++) {
      const fraction = (j + 1) / (this.config.bookingsPerDriver + 1);
      const jitter = (this.random() - .5) * Math.min(duration / (this.config.bookingsPerDriver + 2) * .3, 60000);
      this.events.push({ at: Math.max(1000, Math.round(duration * fraction + jitter)), type: 'add', driver: i, number: j + 1 });
    }
    const count = this.config.offlinePercent ? Math.max(1, Math.round(this.config.drivers * this.config.offlinePercent / 100)) : 0;
    for (let i = 0; i < count; i++) {
      const at = duration * this.config.offlineStartPercent / 100;
      this.events.push({ at, type: 'offline', driver: i });
      this.events.push({ at: Math.min(duration - 1, at + this.config.offlineMinutes * 60000), type: 'online', driver: i });
    }
  }
  async settleNetwork() {
    const until = performance.now() + Math.max(2000, this.config.latencyMs * 20 + 2000);
    while (performance.now() < until) {
      this.guard();
      const busy = await Promise.all(this.phones.filter(phone => phone.page && !phone.page.isClosed()).map(phone => phone.page.locator('#sync-summary').textContent().then(text => /正在/.test(text || '')).catch(() => false)));
      if (!this.service.active && !busy.some(Boolean)) return;
      await sleep(30);
    }
    this.log('warning', '本步仍有请求处理中，将继续观察');
  }
  async refresh(frames = false, forceFrames = false) {
    await Promise.all(this.phones.map(async phone => {
      if (!phone.page || phone.page.isClosed()) return;
      try {
        const snapshot = await phone.page.evaluate(() => {
          const data = JSON.parse(localStorage.getItem('dashi-shuttle:v1') || '{"bookings":[]}');
          return { rows: data.bookings, pending: Object.keys(data._sync?.pending?.bookings || {}).length + Object.keys(data._sync?.pending?.extras || {}).length,
            sync: document.querySelector('#sync-summary')?.textContent || '', error: document.querySelector('#sync-error')?.textContent || '' };
        });
        phone.rows = snapshot.rows; phone.view = { ...phone.view, records: snapshot.rows.filter(row => !row.deleted).length, pending: snapshot.pending, sync: snapshot.sync, error: snapshot.error };
      } catch { /* A restart may close the old page while sampling. */ }
    }));
    if (frames && this.config.liveFrames && (forceFrames || performance.now() - this.lastFrame > 800)) {
      this.lastFrame = performance.now();
      for (const phone of this.phones.slice(0, 6)) if (phone.page && !phone.page.isClosed()) {
        try { const bytes = await phone.page.screenshot({ type: 'jpeg', quality: 50, scale: 'css', timeout: 3000 }); this.frames.set(phone.id, { bytes, sequence: (this.frames.get(phone.id)?.sequence || 0) + 1 }); } catch {}
      }
    }
    const metrics = this.service.metrics();
    this.samples.push({ minute: this.elapsed / 60000, expected: this.expected.size, cloud: metrics.cloudRecords, pending: this.phones.reduce((sum, phone) => sum + phone.view.pending, 0), requests: metrics.requests, conflicts: metrics.conflicts });
    if (this.samples.length > 500) this.samples = this.samples.filter((_, index) => index % 2 === 0);
    this.state.progress = Math.min(99, this.elapsed / ((this.config.durationMinutes + this.config.settleMinutes) * 60000) * 100);
  }
  scheduleActions(record, driver) {
    const remaining = this.config.durationMinutes * 60000 - this.elapsed;
    const definitions = [['pay', 'paidPercent', .15], ['board', 'boardedPercent', .3], ['edit', 'editPercent', .5], ['cancel', 'cancelPercent', .75]];
    for (const [type, percent, fraction] of definitions) if (this.random() * 100 < this.config[percent]) {
      const actor = type === 'edit' && this.random() * 100 < this.config.crossEditPercent ? (driver + 1) % this.phones.length : driver;
      this.events.push({ at: this.elapsed + Math.max(1, remaining * fraction), type, driver: actor, id: record.id, attempts: 0 });
    }
  }
  async add(phone, event) {
    const page = phone.page;
    const direction = this.random() < .2 ? 'return' : 'outbound';
    const stop = direction === 'return' ? '兴文高铁站' : this.random() < .5 ? '马岭' : '江门';
    const fare = stop === '兴文高铁站' ? 6000 : stop === '马岭' ? 4000 : 2000;
    const date = shanghaiDate(this.now());
    const hour = String(7 + Math.floor(this.random() * 15)).padStart(2, '0') + ':00';
    const name = `司机${phone.id}-预约${event.number}`;
    const record = { date, hour, direction, stop, fare, name, passengers: 1 + Math.floor(this.random() * 3), pickup: `${stop}模拟接人点`, phone: '138000' + String(phone.id * 100 + event.number).padStart(5, '0'), note: '仿真测试虚构乘客', paid: false, status: 'booked' };
    await page.locator('.bottom-nav [data-page="bookings"]').click();
    await page.getByRole('button', { name: '新增预约', exact: true }).click();
    const form = page.locator('#booking-form');
    await form.locator('[name="direction"]').selectOption(direction);
    await form.locator(`[name="stop"][value="${stop}"]`).check({ force: true });
    await form.locator('[name="date"]').fill(date);
    await form.locator('[name="hour"]').selectOption(hour);
    for (const key of ['name', 'pickup', 'phone', 'note']) await form.locator(`[name="${key}"]`).fill(record[key]);
    await form.locator('[name="passengers"]').fill(String(record.passengers));
    await form.locator('[name="fare"]').fill((fare / 100).toFixed(2));
    await form.locator('button[type="submit"]').click();
    await page.locator('#booking-dialog').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(name => JSON.parse(localStorage.getItem('dashi-shuttle:v1')).bookings.find(row => row.name === name), name);
    if (!saved?.id) throw new Error('点击保存后没有找到新预约');
    record.id = saved.id; this.expected.set(record.id, record); this.scheduleActions(record, event.driver);
    this.coverage.created++; if (phone.offline) this.coverage.offlineBookings++;
    phone.view.lastAction = `录入 ${name}`; this.log('info', `司机 ${phone.id} 录入 ${name}，${record.passengers} 人`);
  }
  async showRecord(phone, record) {
    const found = await phone.page.evaluate(id => JSON.parse(localStorage.getItem('dashi-shuttle:v1') || '{"bookings":[]}').bookings.some(row => row.id === id && !row.deleted), record.id);
    if (!found) return null;
    const page = phone.page;
    await page.locator('.bottom-nav [data-page="bookings"]').click();
    await page.locator('#selected-date').fill(record.date); await page.locator('#selected-date').press('Tab');
    await page.locator(`[data-direction="${record.direction}"]`).click();
    const hour = page.locator(`[data-hour="${record.hour}"]`);
    if (await hour.getAttribute('aria-pressed') !== 'true') await hour.click();
    const all = page.locator('[data-filter="all"]'); if (await all.getAttribute('aria-pressed') !== 'true') await all.click();
    const card = page.locator(`[data-record="${record.id}"]`);
    return await card.count() ? card : null;
  }
  async action(event) {
    const phone = this.phones[event.driver]; this.guard();
    if (event.type === 'offline') {
      phone.offline = true; await phone.context.setOffline(true); phone.view.lastAction = '网络断开'; this.log('warning', `司机 ${phone.id} 进入断网区间`); return;
    }
    if (event.type === 'online') {
      if (this.config.restartOnReconnect) await phone.page.close();
      phone.offline = false; await phone.context.setOffline(false);
      if (this.config.restartOnReconnect) { await this.newPage(phone); this.coverage.restarted++; }
      phone.view.lastAction = '恢复网络'; this.log('info', `司机 ${phone.id} 恢复联网${this.config.restartOnReconnect ? '并重开应用' : ''}`); return;
    }
    if (event.type === 'add') { await this.add(phone, event); return; }
    const record = this.expected.get(event.id);
    if (!record || record.status === 'cancelled') return;
    const card = await this.showRecord(phone, record);
    if (!card) {
      if (event.attempts < 5 && this.elapsed + this.config.pollSeconds * 500 < this.config.durationMinutes * 60000) {
        this.events.push({ ...event, attempts: event.attempts + 1, at: this.elapsed + Math.max(10000, this.config.pollSeconds * 500) });
        this.log('warning', `司机 ${phone.id} 尚未收到目标预约，稍后重试 ${event.type}`);
      } else { this.coverage.skippedActions++; this.log('warning', `目标预约仍不可见，未覆盖操作 ${event.type}（司机 ${phone.id}）`); }
      return;
    }
    if (event.type === 'pay') {
      const button = card.getByRole('button', { name: '收款', exact: true });
      if (await button.count()) { await button.click(); await phone.page.locator('#confirm-action').click(); }
      record.paid = true; this.coverage.paid++;
    } else if (event.type === 'board') {
      const button = card.getByRole('button', { name: '标记上车', exact: true });
      if (await button.count()) await button.click();
      record.status = 'boarded'; this.coverage.boarded++;
    } else {
      await card.locator('[data-edit]').click();
      const form = phone.page.locator('#booking-form');
      if (event.type === 'edit') await form.locator('[name="note"]').fill(`司机${phone.id} 于 ${shanghaiTime(this.now())} 修改备注`);
      else await form.locator('[name="status"]').selectOption('cancelled');
      const note = await form.locator('[name="note"]').inputValue();
      await form.locator('button[type="submit"]').click();
      if (await phone.page.locator('#confirm-dialog').isVisible()) await phone.page.locator('#confirm-action').click();
      await phone.page.locator('#booking-dialog').waitFor({ state: 'hidden' });
      if (event.type === 'edit') { record.note = note; this.coverage.edited++; }
      else { record.status = 'cancelled'; this.coverage.cancelled++; }
    }
    phone.view.lastAction = ({ pay: '确认收款', board: '标记上车', edit: '修改备注', cancel: '取消预约' })[event.type];
    this.log('info', `司机 ${phone.id} ${phone.view.lastAction}：${record.name}`);
  }
  async advance(delta) {
    this.elapsed += delta;
    await Promise.all(this.phones.map(phone => phone.page.clock.runFor(delta)));
    if (this.paused) this.stepBudget = Math.max(0, this.stepBudget - delta);
    await this.settleNetwork();
  }
  async timeline(until, business = true) {
    while (this.elapsed < until) {
      this.guard(); const wall = performance.now();
      if (business) {
        this.events.sort((a, b) => a.at - b.at);
        const due = this.events.filter(event => event.at <= this.elapsed); this.events = this.events.filter(event => event.at > this.elapsed);
        // Same-time operations on different drivers are genuinely concurrent.
        const groups = new Map(); for (const event of due) { const group = groups.get(event.driver) || []; group.push(event); groups.set(event.driver, group); }
        await Promise.all([...groups.values()].map(async group => { for (const event of group) {
          try { await this.action(event); } catch (error) {
            if (this.stopRequested) throw error;
            this.coverage.skippedActions++; this.log('error', `司机 ${event.driver + 1} 操作 ${event.type} 失败：${error.message.slice(0, 3000)}`);
            this.state.findings.push({ severity: 'error', message: `页面操作失败：${event.type}，司机 ${event.driver + 1}` });
            const dialog = this.phones[event.driver].page.locator('#booking-dialog');
            if (await dialog.isVisible().catch(() => false)) {
              await this.phones[event.driver].page.locator('[data-close="booking-dialog"]').click().catch(() => {});
              if (await this.phones[event.driver].page.locator('#confirm-dialog').isVisible().catch(() => false)) await this.phones[event.driver].page.locator('#confirm-action').click().catch(() => {});
            }
          }
        } }));
        if (due.length) await this.refresh(true);
      }
      await this.gate();
      this.events.sort((a, b) => a.at - b.at);
      let delta = Math.min(10000, until - this.elapsed);
      if (business && this.events[0]?.at > this.elapsed) delta = Math.min(delta, this.events[0].at - this.elapsed);
      if (this.paused) delta = Math.min(delta, this.stepBudget);
      if (delta <= 0) continue;
      await this.advance(delta); await this.refresh(true);
      const wait = delta / this.speed - (performance.now() - wall);
      if (wait > 0) { const end = performance.now() + wait; while (performance.now() < end && !this.stopRequested && !this.paused) { this.guard(); await sleep(Math.min(100, end - performance.now())); } }
    }
  }
  check() {
    const rows = this.service.allRecords(); const cloud = new Map(rows.map(row => [row.id, row])); const issues = [];
    for (const [id, expected] of this.expected) {
      const actual = cloud.get(id);
      if (!actual) { issues.push({ severity: 'error', message: `云端缺少预约 ${expected.name}` }); continue; }
      const mismatched = fields.filter(field => actual[field] !== expected[field]);
      if (mismatched.length) issues.push({ severity: 'error', message: `${expected.name} 与操作意图不符：${mismatched.join('、')}` });
    }
    for (const row of rows) if (!this.expected.has(row.id)) issues.push({ severity: 'error', message: `云端存在计划外预约 ${row.id}` });
    const cutoff = this.service.files.get('ledger.json').data.cutoff || '';
    const active = rows.filter(row => !row.date || row.date >= cutoff);
    let agreed = 0;
    for (const phone of this.phones) {
      const local = new Map(phone.rows.map(row => [row.id, row]));
      const activeIds = new Set(active.map(row => row.id));
      const mismatch = active.some(row => !local.has(row.id) || fields.some(field => local.get(row.id)[field] !== row[field]))
        || phone.rows.some(row => (!row.date || row.date >= cutoff) && !activeIds.has(row.id));
      if (mismatch || phone.view.pending) issues.push({ severity: 'error', message: `司机 ${phone.id} ${phone.view.pending ? `仍有 ${phone.view.pending} 笔待上传` : '尚未与活跃台账一致'}` });
      else agreed++;
    }
    if (this.coverage.created !== this.config.drivers * this.config.bookingsPerDriver) issues.push({ severity: 'error', message: `计划 ${this.config.drivers * this.config.bookingsPerDriver} 笔，实际只录入 ${this.coverage.created} 笔` });
    if (this.service.metrics().earlyRetries) issues.push({ severity: 'error', message: `收到限流后提前请求 ${this.service.metrics().earlyRetries} 次，未遵守服务等待时间` });
    return { passed: issues.length === 0, agreedDrivers: agreed, drivers: this.phones.length, issues: issues.slice(0, 100), checkedAt: shanghaiTime(this.now()), cloudRecords: rows.length, pending: this.phones.reduce((sum, phone) => sum + phone.view.pending, 0) };
  }
  async run() {
    this.wallStart = performance.now(); await mkdir(this.directory, { recursive: true });
    try {
      await this.setup(); this.plan(); this.state.status = 'running'; this.state.phase = '按计划模拟司机使用';
      this.log('info', `开始 ${this.config.durationMinutes} 分钟业务仿真，上传 ${this.config.uploadSeconds} 秒 / 刷新 ${this.config.pollSeconds} 秒`);
      await this.timeline(this.config.durationMinutes * 60000);
      // All network outages end before the automatic observation period.
      for (const phone of this.phones) if (phone.offline) await this.action({ type: 'online', driver: phone.id - 1 });
      this.state.phase = '等待应用自动上传与刷新（不点立即同步）';
      await this.timeline((this.config.durationMinutes + this.config.settleMinutes) * 60000, false);
      await this.refresh(true); this.state.automaticCheck = this.check();
      if (!this.state.automaticCheck.passed && this.config.manualRescue) {
        this.state.phase = '单独检查手动同步能否恢复'; this.log('warning', '自动检查未完全一致，开始独立的手动恢复检查；不会把它算作自动通过');
        for (const phone of this.phones) {
          await this.gate(); await phone.page.getByRole('button', { name: '立即同步', exact: true }).click(); await this.settleNetwork();
        }
        await this.timeline(this.elapsed + 120000, false); await this.refresh(true); this.state.recoveryCheck = this.check();
      }
      this.state.findings.push(...this.state.automaticCheck.issues);
      if (this.coverage.skippedActions) this.state.findings.push({ severity: 'warning', message: `${this.coverage.skippedActions} 个计划操作未覆盖，查看日志确认原因` });
      if (this.config.offlinePercent && !this.coverage.offlineBookings) this.state.findings.push({ severity: 'warning', message: '本轮断网区间没有发生新增预约，尚未覆盖离线新增；请延长断网或调整预约量' });
      this.state.status = 'completed'; this.state.phase = '仿真结束'; this.state.progress = 100;
      this.state.verdict = this.state.findings.some(issue => issue.severity === 'error') ? 'issues' : this.state.findings.length ? 'coverage' : 'passed';
      this.log(this.state.verdict === 'passed' ? 'info' : 'warning', '仿真完成，可查看自动检查、覆盖情况和导出报告');
    } catch (error) {
      this.state.status = this.stopRequested ? 'stopped' : 'failed'; this.state.phase = this.stopRequested ? '已停止' : '运行中断';
      this.state.findings.push({ severity: 'error', message: this.stopRequested ? '用户停止：本轮不能作为完整通过结果' : error.message.split('\n')[0] });
      this.log('error', this.state.findings.at(-1).message);
    } finally {
      this.state.phase += ' · 正在保存记录';
      await bounded(this.refresh(true, true), 10000, '最终快照超时').catch(() => {});
      // Preserve the evidence even if recording finalization or the process is interrupted.
      await writeFile(join(this.directory, 'summary.json'), JSON.stringify({ ...this.snapshot(), status: 'failed', phase: '保存过程未完成', findings: [...this.state.findings, { severity: 'error', message: '记录保存尚未完成；若服务中断，这不是完整通过结果' }] }, null, 2));
      for (const phone of this.phones) {
        if (this.config.recordTrace) await bounded(phone.context.tracing.stop({ path: join(this.directory, `driver-${phone.id}-trace.zip`) }), 15000, '回放保存超时').catch(error => {
          this.state.findings.push({ severity: 'warning', message: `司机 ${phone.id} 的回放未完整保存：${error.message.split('\n')[0]}` });
          if (this.state.verdict === 'passed') this.state.verdict = 'coverage';
        });
        await bounded(phone.context.close(), 10000, '关闭司机环境超时').catch(() => {});
      }
      if (this.browser) await bounded(this.browser.close(), 10000, '关闭测试浏览器超时').catch(() => {});
      this.state.phase = this.state.phase.replace(' · 正在保存记录', ''); this.state.finishedAt = new Date().toISOString();
      this.state.wallSeconds = Math.round((performance.now() - this.wallStart) / 1000);
      const summary = this.snapshot();
      await writeFile(join(this.directory, 'summary.json'), JSON.stringify(summary, null, 2));
      await writeFile(join(this.directory, 'requests.json'), JSON.stringify(this.service.calls, null, 2));
      await writeFile(join(this.directory, 'expected.json'), JSON.stringify([...this.expected.values()], null, 2));
      await writeFile(join(this.directory, 'cloud.json'), JSON.stringify(this.service.allRecords(), null, 2));
      return summary;
    }
  }
}
