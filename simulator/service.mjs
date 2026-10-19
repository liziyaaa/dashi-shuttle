import { freshData } from '../core.js';
import { randomGenerator, shanghaiDate } from './config.mjs';

export function createService(config, now, log = () => {}) {
  const random = randomGenerator(config.seed + 991);
  const initial = freshData();
  for (let i = 0; i < config.historyBookings; i++) {
    const date = shanghaiDate(Date.parse(config.startTime + ':00+08:00') - (45 - i % 20) * 86400000);
    initial.bookings.push({ id: `history-${i}`, date, hour: '09:00', direction: 'outbound', stop: '马岭', pickup: '模拟历史上车点', phone: '13800000000', name: `历史模拟${i + 1}`, passengers: 1, fare: 4000, paid: true, status: 'boarded', note: '虚构历史记录', updatedAt: date + 'T00:00:00.000Z' });
  }
  const expectedHistory = structuredClone(initial.bookings);
  const files = new Map([['ledger.json', { sha: '1', data: initial }]]);
  const calls = [], cooldowns = new Map(), driverRequests = new Map();
  let revision = 1, active = 0;
  const counters = { requests: 0, reads: 0, writes: 0, savedWrites: 0, conflicts: 0, serverErrors: 0, rateLimits: 0, lostResponses: 0, blockedExternal: 0 };
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, Cache-Control, Pragma' };
  function allRecords() {
    const map = new Map();
    for (const { data } of files.values()) for (const row of data.bookings || []) {
      const old = map.get(row.id);
      if (!old || Date.parse(row.updatedAt) >= Date.parse(old.updatedAt)) map.set(row.id, structuredClone(row));
    }
    return [...map.values()];
  }
  async function handle(request, driver) {
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com' || !(url.pathname === '/repos/liziyaaa/dashi-shuttle-data' || url.pathname.startsWith('/repos/liziyaaa/dashi-shuttle-data/contents/'))) {
      counters.blockedExternal++; return { abort: true };
    }
    if (request.method === 'OPTIONS') return { status: 204, headers };
    active++;
    const path = decodeURIComponent(url.pathname.split('/contents/')[1] || '');
    const entry = { at: now(), driver: driver.id, method: request.method, path: path || 'repository', status: 0 };
    calls.push(entry); if (calls.length > 20000) calls.splice(0, 1000);
    counters.requests++;
    request.method === 'GET' ? counters.reads++ : counters.writes++;
    const reply = (status, json, extra = {}) => { entry.status = status; return { status, json, headers: { ...headers, ...extra } }; };
    try {
      if (config.latencyMs) await new Promise(resolve => setTimeout(resolve, config.latencyMs));
      if (driver.offline) { entry.status = 0; return { abort: true }; }
      const count = (driverRequests.get(driver.id) || 0) + 1; driverRequests.set(driver.id, count);
      if ((cooldowns.get(driver.id) || 0) > now() || (config.rateLimitEvery && count % config.rateLimitEvery === 0)) {
        counters.rateLimits++;
        const until = Math.max(cooldowns.get(driver.id) || 0, now() + config.retryAfterSeconds * 1000);
        cooldowns.set(driver.id, until);
        log('warning', `司机 ${driver.id} 收到模拟限流`, { driver: driver.id });
        return reply(429, { message: 'Simulated rate limit' }, { 'Retry-After': String(Math.ceil((until - now()) / 1000)) });
      }
      if (random() * 100 < config.errorPercent) { counters.serverErrors++; return reply(503, { message: 'Simulated network service failure' }); }
      if (!path) return reply(200, { private: true, default_branch: 'main', archived: false });
      const file = files.get(path);
      if (request.method === 'GET') return file ? reply(200, { sha: file.sha, content: Buffer.from(JSON.stringify(file.data)).toString('base64') }) : reply(404, {});
      if (request.method !== 'PUT') return reply(405, {});
      if (request.body?.sha !== file?.sha || random() * 100 < config.conflictPercent) {
        counters.conflicts++; return reply(409, { message: 'Simulated SHA conflict' });
      }
      let data;
      try { data = JSON.parse(Buffer.from(request.body.content, 'base64').toString()); } catch { return reply(422, { message: 'Invalid content' }); }
      files.set(path, { sha: String(++revision), data }); counters.savedWrites++;
      if (random() * 100 < config.lostResponsePercent) {
        counters.lostResponses++; entry.status = 0; log('warning', `司机 ${driver.id} 写入已成功，但模拟丢失响应`); return { abort: true };
      }
      return reply(200, {});
    } finally { active--; }
  }
  return {
    handle, allRecords, files, calls, expectedHistory,
    get active() { return active; },
    metrics() { const records = allRecords(); return { ...counters, cloudRecords: records.filter(row => !row.deleted).length, archives: files.size - 1, bytes: [...files.values()].reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file.data)), 0) }; },
  };
}
