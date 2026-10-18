import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { APP_VERSION, newerVersion, startUpdates } from '../updates.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  hidden = true;
  textContent = '';
  disabled = false;
  children = new Map();
  querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
  click() { this.dispatchEvent(new Event('click')); }
}
function setup(t, { version = APP_VERSION, offline = false, waiting = false, canReload = true, fail = false, noWorker = false, workerVersion = version } = {}) {
  const banner = new Element(), document = new EventTarget(), window = new EventTarget(), sw = new EventTarget();
  let checks = 0, reloads = 0, messages = 0, allowed = canReload;
  const status = [], notices = []; let serverVersion = version;
  const worker = new EventTarget(); worker.state = 'installed'; worker.postMessage = (message, ports) => { if (message.type === 'GET_VERSION') { ports[0].postMessage({ version: workerVersion }); return; } assert.equal(message.type, 'SKIP_WAITING'); messages++; };
  const reg = new EventTarget(); reg.waiting = waiting ? worker : null; reg.installing = null; reg.update = async () => { checks++; };
  sw.register = async (url, options) => { assert.equal(url, './sw.js'); assert.equal(options.updateViaCache, 'none'); return reg; };
  document.visibilityState = 'visible'; document.querySelector = selector => { assert.equal(selector, '#update-banner'); return banner; };
  const globals = { document, window, navigator: { onLine: !offline, ...(noWorker ? {} : { serviceWorker: sw }) }, location: { reload: () => reloads++ }, fetch: async (url, options) => { assert.match(url, /version.json\?t=/); assert.equal(options.cache, 'no-store'); if (fail) throw new Error('Offline'); return { ok: true, json: async () => ({ version: serverVersion }) }; } };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key]; } });
  const app = startUpdates({ notify: message => notices.push(message), canReload: () => allowed, onStatus: message => status.push(message) });
  return { app, banner, reg, sw, worker, document, window, status, notices, setAllowed: value => { allowed = value; }, setVersion: value => { serverVersion = value; }, get checks() { return checks; }, get reloads() { return reloads; }, get messages() { return messages; } };
}
test('semantic versions compare numerically and reject invalid releases', () => {
  for (const version of ['1.2.1', '1.10.0', '2.0.0']) assert.ok(newerVersion(version, '1.2.0'));
  for (const version of ['1.2.0', '1.1.9', 'bad', '', '1.2.0-beta']) assert.equal(newerVersion(version, '1.2.0'), false);
});
test('startup checks the server without caching and reports the current release', async t => {
  const f = setup(t); await tick(); await f.app.check(true);
  assert.ok(f.checks >= 1); assert.equal(f.banner.hidden, true);
  assert.match(f.status.at(-1), /最新版本/);
  assert.equal(f.reloads, 0);
});
test('waiting update requires explicit acceptance, can be postponed and never discards an open form', async t => {
  const f = setup(t, { waiting: true, version: '1.4.0', canReload: false });
  await tick(); assert.equal(f.banner.hidden, false); assert.equal(f.messages, 0);
  f.banner.querySelector('[data-update-later]').click(); assert.equal(f.banner.hidden, true);
  await f.app.check(true); assert.equal(f.banner.hidden, false);
  f.banner.querySelector('[data-update-now]').click(); await tick();
  assert.equal(f.messages, 0); assert.match(f.notices.at(-1), /先保存或关闭/);
  f.setAllowed(true); f.banner.querySelector('[data-update-now]').click(); await tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.messages, 1); assert.equal(f.reloads, 0);
  f.sw.dispatchEvent(new Event('controllerchange')); assert.equal(f.reloads, 1);
});
test('an update accepted in another tab does not refresh this tab', async t => {
  const f = setup(t, { waiting: true }); await tick();
  f.sw.dispatchEvent(new Event('controllerchange')); assert.equal(f.reloads, 0);
});
test('a release finishing installation prompts without activating automatically', async t => {
  const f = setup(t, { version: '1.4.0' }); await tick();
  f.reg.installing = f.worker; f.worker.state = 'installing'; f.reg.dispatchEvent(new Event('updatefound'));
  f.reg.waiting = f.worker; f.worker.state = 'installed'; f.worker.dispatchEvent(new Event('statechange')); await tick();
  assert.equal(f.banner.hidden, false); assert.equal(f.messages, 0);
});
test('foreground rechecks and restores a postponed update prompt', async t => {
  const f = setup(t, { version: '1.4.0', waiting: true }); await tick();
  f.banner.querySelector('[data-update-later]').click();
  f.document.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(f.banner.hidden, false);
});
test('offline startup and a failed check keep the app usable without refreshing', async t => {
  const f = setup(t, { offline: true }); await f.app.check(true);
  assert.match(f.status.at(-1), /离线/); assert.equal(f.reloads, 0);
});
test('network errors are caught and leave a retry status', async t => {
  const f = setup(t, { fail: true }); await tick(); await f.app.check(true);
  assert.match(f.status.at(-1), /稍后重试/); assert.equal(f.reloads, 0);
});
test('an unsupported service worker still offers a normal refresh for a newer release', async t => {
  const f = setup(t, { noWorker: true, version: '1.4.0' }); await tick();
  f.banner.querySelector('[data-update-now]').click(); await tick(); assert.equal(f.reloads, 1);
});
test('release references and offline assets agree, with project subdirectory support', async () => {
  const [source, html, manifest, release, pkg] = await Promise.all(['sw.js', 'index.html', 'manifest.webmanifest', 'version.json', 'package.json'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));
  assert.equal(JSON.parse(release).version, APP_VERSION); assert.equal(JSON.parse(pkg).version, APP_VERSION);
  assert.ok(source.includes(`const VERSION = '${APP_VERSION}'`));
  assert.ok(html.includes(`app.js?v=${APP_VERSION}`));
  for (const icon of JSON.parse(manifest).icons) assert.ok(icon.src.endsWith(`?v=${APP_VERSION}`));
  const handlers = {}; let skipped = 0, claimed = 0;
  const cache = { add: async () => {}, match: async request => String(request).includes('/dashi-shuttle/') ? { cached: true } : undefined };
  const sandbox = { URL, Request, console, caches: { open: async name => { assert.equal(name, `dashi-shuttle-v${APP_VERSION}`); return cache; }, keys: async () => [`dashi-shuttle-v${APP_VERSION}`], delete: async () => true }, self: { location: { origin: 'https://example.com' }, registration: { scope: 'https://example.com/dashi-shuttle/' }, addEventListener: (name, handler) => { handlers[name] = handler; }, skipWaiting: () => skipped++, clients: { claim: () => claimed++ } } };
  // Browsers resolve relative Request URLs against the worker scope.
  sandbox.Request = class { constructor(url, options) { this.url = new URL(url, sandbox.self.registration.scope).href; this.cache = options.cache; } };
  vm.runInNewContext(source, sandbox);
  let install; handlers.install({ waitUntil: promise => { install = promise; } }); await install; assert.equal(skipped, 0);
  handlers.message({ data: { type: 'SKIP_WAITING' } }); assert.equal(skipped, 1);
  let activation; handlers.activate({ waitUntil: promise => { activation = promise; } }); await activation; assert.equal(claimed, 1);
  for (const url of ['https://example.com/dashi-shuttle/version.json?t=1', 'https://api.github.com/repos/private/data', 'https://example.com/dashi-shuttle/sw.js']) {
    let intercepted = false; handlers.fetch({ request: { url, method: 'GET' }, respondWith: () => { intercepted = true; } }); assert.equal(intercepted, false);
  }
  let response; handlers.fetch({ request: { url: 'https://example.com/dashi-shuttle/?v=1.2.0', method: 'GET', mode: 'navigate' }, respondWith: promise => { response = promise; } });
  assert.equal((await response).cached, true);
});

test('same-version and older waiting caches never prompt, including foreground rechecks', async t => {
  const f = setup(t, { waiting: true }); await tick();
  assert.equal(f.banner.hidden, true);
  f.worker.state = 'installed'; f.reg.installing = f.worker;
  f.reg.dispatchEvent(new Event('updatefound')); f.worker.dispatchEvent(new Event('statechange')); await tick();
  f.document.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(f.banner.hidden, true); assert.equal(f.messages, 0);
});
test('a stale waiting cache is never activated as the advertised newer release', async t => {
  const f = setup(t, { waiting: true, version: '1.4.0', workerVersion: APP_VERSION }); await tick();
  f.banner.querySelector('[data-update-now]').click(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.messages, 0); assert.match(f.notices.at(-1), /正在准备/);
});

test('a stale banner is cleared when a fresh check no longer advertises a newer release', async t => {
  const f = setup(t, { waiting: true, version: '1.4.0' }); await tick();
  assert.equal(f.banner.hidden, false);
  f.setVersion(APP_VERSION); await f.app.check();
  assert.equal(f.banner.hidden, true); assert.match(f.status.at(-1), /最新版本/);
});
