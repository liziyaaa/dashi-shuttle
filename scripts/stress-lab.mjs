import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, validateConfig } from '../simulator/config.mjs';

const origin = 'http://127.0.0.1:9340';
const output = resolve('simulation-results', 'stress-' + new Date().toISOString().replace(/[:.]/g, '-'));
const base = { ...DEFAULT_CONFIG, speed: 6000, liveFrames: false, recordTrace: false, recordVideo: false, offlinePercent: 0, latencyMs: 30, settleMinutes: 8, maxRealMinutes: 15 };
export const profiles = [
  { name: '日常团队与历史归档', key: 'daily', config: { drivers: 5, bookingsPerDriver: 6, durationMinutes: 20, historyBookings: 100 } },
  { name: '10人并发登记与修改', key: 'busy', config: { drivers: 10, bookingsPerDriver: 10, durationMinutes: 20, paidPercent: 80, boardedPercent: 80, editPercent: 40, conflictPercent: 10, latencyMs: 50 } },
  { name: '20人200笔峰值', key: 'peak', config: { drivers: 20, bookingsPerDriver: 10, durationMinutes: 20, paidPercent: 100, boardedPercent: 100, editPercent: 30, latencyMs: 50 } },
  { name: '弱网离线与写入丢响应', key: 'weak', config: { drivers: 5, bookingsPerDriver: 6, durationMinutes: 20, offlinePercent: 60, offlineStartPercent: 20, offlineMinutes: 8, latencyMs: 150, errorPercent: 10, conflictPercent: 10, lostResponsePercent: 10, settleMinutes: 10 } },
  { name: '共享账号耗尽后重置恢复', key: 'reset', config: { drivers: 4, bookingsPerDriver: 3, durationMinutes: 8, primaryUsed: 4975, primaryResetSeconds: 240, otherRequestsPerHour: 1200, otherWritesPerHour: 100, paidPercent: 100, boardedPercent: 100, cancelPercent: 0 } },
  { name: '额度持续耗尽时本机保留', key: 'blocked', expectBlocked: true, config: { drivers: 3, bookingsPerDriver: 3, durationMinutes: 6, primaryUsed: 5000, primaryResetSeconds: 3600, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0, settleMinutes: 3 } },
  { name: '跨司机编辑与整条覆盖风险', key: 'cross', config: { drivers: 5, bookingsPerDriver: 6, durationMinutes: 12, paidPercent: 100, boardedPercent: 100, editPercent: 100, crossEditPercent: 100, cancelPercent: 0 } },
  { name: 'WebKit跨日与归档', key: 'midnight', config: { browser: 'webkit', drivers: 2, bookingsPerDriver: 3, durationMinutes: 8, startTime: '2026-10-19T23:57', historyBookings: 20, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0 } },
  { name: '20人200笔延长合并间隔', key: 'batched', extra: true, config: { drivers: 20, bookingsPerDriver: 10, durationMinutes: 20, paidPercent: 100, boardedPercent: 100, editPercent: 30, latencyMs: 50, uploadSeconds: 120, pollSeconds: 300 } },
];
const chosen = process.argv.slice(2);
const selected = chosen.length ? profiles.filter(row => chosen.includes(row.key)) : profiles.filter(row => !row.extra);
if (!selected.length || chosen.some(key => !profiles.some(row => row.key === key))) throw new Error('未知场景，可选：' + profiles.map(row => row.key).join(', '));
await mkdir(output, { recursive: true });
const results = []; const startedAt = new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, body, token) {
  const response = await fetch(origin + path, body ? { method: 'POST', headers: { Origin: origin, 'X-Lab-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || String(response.status)); return data;
}
await writeFile(resolve(output, 'profiles.json'), JSON.stringify(selected.map(row => ({ ...row, config: validateConfig({ ...base, ...row.config }) })), null, 2));
console.log('压力测试报告目录：' + output);
for (const profile of selected) {
  const initial = await request('/api/state'); if (initial.running) throw new Error('请等待当前仿真结束后再启动压力测试');
  const config = validateConfig({ ...base, ...profile.config });
  const { id } = await request('/api/start', config, initial.token);
  console.log('开始：' + profile.name + ' · ' + config.drivers + ' 人 / ' + config.drivers * config.bookingsPerDriver + ' 笔 · ' + id);
  let job, lastProgress = -1;
  do {
    await sleep(2000); job = (await request('/api/state?id=' + id)).selected;
    if (Math.floor(job.progress / 20) > lastProgress) {
      lastProgress = Math.floor(job.progress / 20);
      console.log(`  ${profile.key}: ${job.progress.toFixed(0)}% 新增${job.coverage.created} 云端${job.metrics.cloudRecords} 待上传${job.drivers.reduce((sum, driver) => sum + driver.pending, 0)} ${job.phase}`);
    }
  } while (!job.finishedAt);
  const pending = job.drivers.reduce((sum, driver) => sum + driver.pending, 0);
  const retained = job.coverage.created === job.plannedBookings && job.coverage.skippedActions === 0 && job.localIntegrity?.passed;
  const safetyPass = profile.expectBlocked ? job.status === 'completed' && job.automaticCheck?.passed === false && job.metrics.cloudRecords === 0 && pending === job.plannedBookings && retained && job.metrics.earlyRetries === 0 : job.verdict === 'passed';
  results.push({ name: profile.name, key: profile.key, id, config, application: job.application, expected: profile.expectBlocked ? '限流可见、本机保留、冷却期间不重试' : '全部操作覆盖且自动一致', safetyPass, verdict: job.verdict, status: job.status, coverage: job.coverage, metrics: job.metrics, pending, localIntegrity: job.localIntegrity, expectedRecords: job.expectedRecords, expectedReceipt: job.expectedReceipt, cloudReceipt: job.cloudReceipt, automaticCheck: job.automaticCheck, recoveryCheck: job.recoveryCheck, findings: job.findings, wallSeconds: job.wallSeconds });
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), results }, null, 2));
  console.log('完成：' + profile.name + ' · 场景验收' + (safetyPass ? '通过' : '发现问题') + ' · 自动检查' + (job.automaticCheck?.passed ? '一致' : '不一致') + ' · ' + job.wallSeconds + ' 秒');
}
console.log('全部结束：' + results.filter(row => row.safetyPass).length + '/' + results.length + ' 场景符合预期。');
process.exitCode = results.every(row => row.safetyPass) ? 0 : 1;
