export const DEFAULT_CONFIG = {
  drivers: 3, bookingsPerDriver: 3, durationMinutes: 60, speed: 600,
  startTime: '2026-10-19T07:00', uploadSeconds: 30, pollSeconds: 120,
  paidPercent: 70, boardedPercent: 60, editPercent: 20, cancelPercent: 10, crossEditPercent: 0,
  offlinePercent: 33, offlineStartPercent: 35, offlineMinutes: 10, restartOnReconnect: true,
  latencyMs: 30, errorPercent: 0, conflictPercent: 0, lostResponsePercent: 0,
  rateLimitEvery: 0, retryAfterSeconds: 60, historyBookings: 0,
  settleMinutes: 5, manualRescue: true, seed: 42, browser: 'chromium',
  recordTrace: true, recordVideo: false, liveFrames: true, maxRealMinutes: 15,
  githubLimits: true, primaryLimit: 5000, primaryUsed: 0, primaryResetSeconds: 3600,
  contentPerMinute: 80, contentPerHour: 500, otherRequestsPerHour: 0, otherWritesPerHour: 0,
};
const bounds = {
  drivers: [1, 20], bookingsPerDriver: [1, 30], durationMinutes: [1, 1440], speed: [1, 6000],
  uploadSeconds: [1, 600], pollSeconds: [5, 1800],
  paidPercent: [0, 100], boardedPercent: [0, 100], editPercent: [0, 100], cancelPercent: [0, 100], crossEditPercent: [0, 100],
  offlinePercent: [0, 100], offlineStartPercent: [0, 90], offlineMinutes: [1, 1440],
  latencyMs: [0, 1000], errorPercent: [0, 50], conflictPercent: [0, 50], lostResponsePercent: [0, 30],
  rateLimitEvery: [0, 10000], retryAfterSeconds: [1, 3600], historyBookings: [0, 200],
  settleMinutes: [1, 30], seed: [1, 2147483647], maxRealMinutes: [1, 30],
  primaryLimit: [1, 50000], primaryUsed: [0, 50000], primaryResetSeconds: [1, 3600],
  contentPerMinute: [1, 1000], contentPerHour: [1, 10000], otherRequestsPerHour: [0, 50000], otherWritesPerHour: [0, 10000],
};
export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是 JSON 对象');
  for (const key of Object.keys(input)) if (!(key in DEFAULT_CONFIG)) throw new Error(`未知参数：${key}`);
  const config = { ...DEFAULT_CONFIG, ...input };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} 必须为 ${min}—${max} 的整数`);
  }
  for (const key of ['restartOnReconnect', 'manualRescue', 'recordTrace', 'recordVideo', 'liveFrames', 'githubLimits']) if (typeof config[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
  if (config.primaryUsed > config.primaryLimit) throw new Error('账号已用额度不能超过小时额度');
  if (config.otherWritesPerHour > config.otherRequestsPerHour) throw new Error('其他项目的写入数不能超过它的总请求数');
  if (!['chromium', 'webkit'].includes(config.browser)) throw new Error('请选择 Chromium 或 WebKit');
  if (typeof config.startTime !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(config.startTime)) throw new Error('请填写有效的开始时间');
  const date = new Date(config.startTime + ':00+08:00');
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 28800000).toISOString().slice(0, 16) !== config.startTime) throw new Error('开始日期或时间不存在');
  if (config.startTime < '2020-01-01T00:00') throw new Error('模拟日期需在 2020 年或之后');
  if (config.drivers * config.bookingsPerDriver > 200) throw new Error('每轮最多计划 200 笔新预约，请减少司机数或每人预约数');
  return config;
}
export function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let n = value; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
export function shanghaiDate(ms) { return new Date(ms + 28800000).toISOString().slice(0, 10); }
export function shanghaiTime(ms) { return new Date(ms + 28800000).toISOString().slice(0, 19).replace('T', ' '); }
