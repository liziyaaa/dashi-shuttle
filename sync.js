import { freshData, mergeData, validateData, localDate, validDate } from './core.js?v=1.3.4';
export const DATA_REPO = 'liziyaaa/dashi-shuttle-data';
export const UPLOAD_DELAY = 30000;
export const PULL_INTERVAL = 120000;
const FILE = 'ledger.json';
const monthPattern = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;
export function encodeData(data) { const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2)); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function decodeJSON(content) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0)))); }
export function decodeData(content) { const input = decodeJSON(content); return validateData({ ...input, schema: input.schema === 2 && input.protocol === 2 ? 1 : input.schema }); }
export function activeCutoff(today = localDate()) { const date = new Date(today + 'T12:00:00'); date.setDate(date.getDate() - 14); return localDate(date); }
export function validateConnection(config) {
  const repo = config?.repo || DATA_REPO;
  const token = (config?.token || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('请粘贴管理员提供的完整连接密钥（github_pat_ 开头）');
  return { repo, token };
}
export function pendingRows(data, pending) {
  const result = freshData();
  for (const key of ['bookings', 'extras']) result[key] = data[key].filter(row => pending[key]?.[row.id] === row.updatedAt);
  result.settings = data.settings;
  return result;
}
export function hasPending(pending) { return !!pending.settings || ['bookings', 'extras'].some(key => Object.keys(pending[key] || {}).length); }
export function reconcileActive(local, remote, pending, cutoff) {
  const kept = freshData(); kept.settings = local.settings;
  for (const key of ['bookings', 'extras']) kept[key] = local[key].filter(row => (row.date && row.date < cutoff) || pending[key]?.[row.id]);
  return mergeData(kept, remote);
}
function normalize(row, homes) {
  const homeMonth = homes[row.id] || row.homeMonth || row.date?.slice(0, 7);
  return { ...row, ...(homeMonth ? { homeMonth } : {}) };
}
function canonical(value) {
  if (Array.isArray(value)) {
    const entries = value.map(canonical);
    return entries.every(entry => entry && typeof entry === 'object' && typeof entry.id === 'string') ? entries.sort((a, b) => a.id.localeCompare(b.id)) : entries;
  }
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

// One instance per connection: privacy is rechecked before every write, while
// read-only polls reuse a recent successful repository verification.
export function createSyncClient(config) {
  config = validateConnection(config);
  const root = `https://api.github.com/repos/${config.repo}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  let verifiedAt = 0, cooldownUntil = 0;
  async function request(method, path, signal, body, extraHeaders = {}) {
    if (Date.now() < cooldownUntil) { const error = new Error('同步服务暂时限流，稍后自动重试；记录已保存在本机'); error.retryAt = cooldownUntil; throw error; }
    const response = await fetch(root + path, { method, headers: { ...headers, ...extraHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
    if (!response.ok) {
      if (method === 'PUT' && response.status === 409) return { conflict: true };
      if (method === 'GET' && response.status === 404 && path.startsWith('/contents/archives/')) return { missing: true };
      if (response.status === 401) throw new Error('连接密钥无效或已过期，请重新设置');
      const detail = await response.json().catch(() => ({}));
      if (method === 'PUT' && response.status === 422 && /sha|already exists/i.test(detail.message || '')) return { conflict: true };
      if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse/i.test(detail.message || '') || response.headers.get('retry-after')))) {
        const retry = Number(response.headers.get('retry-after'));
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        // Secondary limits also include the primary reset header. Respect that
        // reset only when the hourly quota is actually exhausted.
        const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
        cooldownUntil = Math.max(Date.now() + (retry > 0 ? retry * 1000 : 60000), exhausted ? reset || 0 : 0);
        const error = new Error('同步请求过于频繁，稍后自动重试；记录已保存在本机'); error.retryAt = cooldownUntil; throw error;
      }
      if (response.status === 403) throw new Error('连接密钥权限不足，请联系管理员为数据仓库开启 Contents 读写权限');
      if (response.status === 404) throw new Error(path === '' ? '连接密钥无法访问私有数据仓库，请联系管理员授权 liziyaaa/dashi-shuttle-data' : '无法读取云端台账（ledger.json），请联系管理员检查文件及密钥的 Contents 读取权限');
      throw new Error(`同步未完成（${response.status}），记录已保留在本机`);
    }
    return response.json();
  }
  async function verify(signal, force = false) {
    if (!force && verifiedAt && Date.now() - verifiedAt < 600000) return;
    const repository = await request('GET', '', signal);
    if (repository.private !== true) throw new Error('只允许同步到私有仓库，已停止上传，避免公开乘客信息');
    if (repository.default_branch !== 'main' || repository.archived) throw new Error('数据仓库必须可写，且默认分支为 main');
    verifiedAt = Date.now();
  }
  async function read(path, signal) {
    const file = await request('GET', `/contents/${path}`, signal);
    if (file.missing) return file;
    if (!file.sha || typeof file.content !== 'string') throw new Error('云端数据文件无法读取');
    const payload = file.encoding === 'none' ? await request('GET', `/contents/${path}`, signal, undefined, { Accept: 'application/vnd.github.raw+json' }) : decodeJSON(file.content);
    return { sha: file.sha, payload };
  }
  async function write(path, value, sha, signal) {
    await verify(signal, true);
    return request('PUT', `/contents/${path}`, signal, { message: 'Sync shuttle ledger', content: encodeData(value), ...(sha ? { sha } : {}), branch: 'main' });
  }
  function ledger(file) {
    const payload = file.payload;
    if (![1, 2].includes(payload.schema) || (payload.schema === 2 && (payload.protocol !== 2 || !validDate(payload.cutoff)))) throw new Error('云端同步格式不受支持，请更新应用');
    const archives = payload.schema === 2 ? payload.archives : {};
    const homes = payload.schema === 2 ? payload.legacyHomes : {};
    if (!archives || typeof archives !== 'object' || Array.isArray(archives) || !homes || typeof homes !== 'object' || Array.isArray(homes)) throw new Error('云端归档索引无效');
    for (const [month, routes] of Object.entries(archives)) if (!monthPattern.test(month) || !Array.isArray(routes) || routes.some(route => !monthPattern.test(route))) throw new Error('云端归档月份无效');
    for (const month of Object.values(homes)) if (!monthPattern.test(month)) throw new Error('云端历史位置无效');
    return { data: validateData({ ...payload, schema: 1 }), archives, homes, cutoff: payload.cutoff || '', schema: payload.schema };
  }
  async function saveArchive(month, additions, signal, expected = false) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const file = await read(`archives/${month}.json`, signal);
      if (file.missing && expected) throw new Error('云端历史归档缺失，已停止覆盖台账');
      const remote = file.missing ? freshData() : validateData(file.payload);
      const merged = mergeData(remote, additions);
      if (same(remote, merged)) return merged;
      const result = await write(`archives/${month}.json`, merged, file.sha, signal);
      if (!result.conflict) return merged;
    }
    throw new Error('历史归档正在被其他设备更新，请稍后重试；本机记录已保留');
  }
  async function sync(getCurrent, accept, signal, options = {}) {
    await verify(signal);
    // Capture one upload batch. Changes made while requests are in flight belong
    // to the next batch and must not be acknowledged by this one.
    const local = validateData(getCurrent());
    const changes = options.pending ? pendingRows(local, options.pending) : local;
    for (let attempt = 0; attempt < 4; attempt++) {
      const file = await read(FILE, signal);
      const cloud = ledger(file);
      const cutoff = [activeCutoff(options.today), cloud.cutoff].sort().at(-1);
      if (options.mode === 'pull') { accept(cloud.data, { cutoff, archives: cloud.archives }); return { cutoff, archives: cloud.archives }; }
      const homes = { ...cloud.homes };
      if (cloud.schema === 1) for (const key of ['bookings', 'extras']) for (const row of cloud.data[key]) if (row.date) homes[row.id] = row.homeMonth || row.date.slice(0, 7);
      const archives = structuredClone(cloud.archives);
      const monthData = new Map();
      const ensureMonth = month => { if (!monthData.has(month)) monthData.set(month, freshData()); return monthData.get(month); };
      // Locate dirty records by their immutable home month even after their
      // ride date has moved. A stale device cannot bypass an archived deletion.
      const dirtyHomes = new Set();
      for (const key of ['bookings', 'extras']) for (const row of changes[key]) { const normalized = normalize(row, homes); if (normalized.homeMonth && archives[normalized.homeMonth]) dirtyHomes.add(normalized.homeMonth); }
      let combined = cloud.data;
      for (const month of dirtyHomes) {
        const archive = await read(`archives/${month}.json`, signal);
        if (archive.missing) throw new Error('云端历史归档缺失，已停止覆盖台账');
        const history = validateData(archive.payload);
        monthData.set(month, history);
        combined = mergeData(combined, history);
      }
      // Only explicitly pending local rows are uploaded, never the entire
      // historical cache from an old phone.
      const updates = freshData();
      for (const key of ['bookings', 'extras']) updates[key] = changes[key].map(row => normalize(row, homes));
      updates.settings = options.pending && !options.pending.settings ? combined.settings : changes.settings;
      combined = mergeData(combined, updates);
      const active = freshData(); active.settings = combined.settings;
      const changedIds = new Set(['bookings', 'extras'].flatMap(key => changes[key].map(row => row.id)));
      for (const key of ['bookings', 'extras']) for (const original of combined[key]) {
        const row = normalize(original, homes);
        if (!row.date || row.date >= cutoff) active[key].push(row);
        if (row.homeMonth && (row.date < cutoff || (archives[row.homeMonth] && changedIds.has(row.id)))) ensureMonth(row.homeMonth)[key].push(row);
      }
      // Write and verify monthly copies BEFORE removing anything from the
      // active file. A crash/409 leaves either duplicates (safe) or the old file.
      for (const [month, entries] of monthData) {
        const saved = await saveArchive(month, entries, signal, !!archives[month]);
        const routes = new Set(archives[month] || [month]);
        for (const key of ['bookings', 'extras']) for (const row of saved[key]) if (row.date) routes.add(row.date.slice(0, 7));
        archives[month] = [...routes].sort();
        accept(saved, { history: true });
      }
      const payload = { ...active, schema: 2, protocol: 2, cutoff, archives, legacyHomes: homes };
      if (!same(file.payload, payload)) {
        const result = await write(FILE, payload, file.sha, signal);
        if (result.conflict) continue;
      }
      accept(active, { cutoff, archives });
      return { cutoff, archives };
    }
    throw new Error('其他司机正在更新，请稍后重试；本机记录已保留');
  }
  async function history(month, archives, signal) {
    if (!monthPattern.test(month)) throw new Error('历史月份无效');
    await verify(signal);
    let result = freshData();
    for (const [home, routes] of Object.entries(archives)) if (home === month || routes.includes(month)) {
      const file = await read(`archives/${home}.json`, signal);
      if (file.missing) throw new Error('云端历史归档缺失，请稍后重试');
      result = mergeData(result, validateData(file.payload));
    }
    return result;
  }
  return { sync, history };
}
// Compatibility entry point for integration tests and maintenance callers.
export async function synchronize(config, getCurrent, accept, signal, options) { return createSyncClient(config).sync(getCurrent, accept, signal, options); }
