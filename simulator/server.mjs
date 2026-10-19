import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, sep, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, validateConfig } from './config.mjs';
import { Simulation } from './engine.mjs';
import { renderStressReport } from './stress-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.zip': 'application/zip', '.webm': 'video/webm' };
const appFiles = new Set(['index.html', 'styles.css', 'app.js', 'core.js', 'ui.js', 'sync.js', 'scheduler.js', 'updates.js', 'version.json', 'sw.js', 'manifest.webmanifest']);
const jobPattern = /^run-[a-f0-9-]{36}$/;

export async function createLabServer({ port = 9340, output = join(root, 'simulation-results') } = {}) {
  await mkdir(output, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const jobs = new Map(); let active = null;
  const restored = await Promise.all((await readdir(output, { withFileTypes: true })).filter(entry => entry.isDirectory() && jobPattern.test(entry.name)).map(async entry => {
    try { return { saved: JSON.parse(await readFile(join(output, entry.name, 'summary.json'), 'utf8')), directory: join(output, entry.name), id: entry.name }; } catch { return null; }
  }));
  for (const job of restored.filter(Boolean).sort((a, b) => Date.parse(a.saved.startedAt) - Date.parse(b.saved.startedAt)).slice(-30)) jobs.set(job.id, job);
  const value = job => job.sim ? job.sim.snapshot() : job.saved;
  const running = () => active && !active.sim.state.finishedAt;
  let origin;
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) return send(403, { error: '仅允许本机访问' });
      const url = new URL(req.url, origin);
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-lab-token'] !== token) return send(403, { error: '请从仿真控制页发起操作' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 16000) return send(413, { error: '参数过大' }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'JSON 格式错误' }); }
        if (url.pathname === '/api/start') {
          if (running()) return send(409, { error: '已有仿真运行中，请先停止或等待完成' });
          const config = validateConfig(body);
          const id = 'run-' + randomUUID();
          const sim = new Simulation(id, config, origin + '/app/', join(output, id));
          // Reserve before reading metadata: concurrent start requests must not
          // launch separate jobs against one shared interval-injection endpoint.
          active = { sim, directory: join(output, id) }; jobs.set(id, active);
          try {
            const sources = await Promise.all(['version.json', 'sync.js', 'app.js', 'core.js'].map(name => readFile(join(root, name))));
            sim.state.application = { version: JSON.parse(sources[0]).version, hashes: Object.fromEntries(['sync.js', 'app.js', 'core.js'].map((name, index) => [name, createHash('sha256').update(sources[index + 1]).digest('hex')])) };
          } catch (error) { sim.state.status = 'failed'; sim.state.phase = error.message; sim.state.finishedAt = new Date().toISOString(); throw error; }
          sim.run().catch(error => { sim.state.status = 'failed'; sim.state.phase = error.message; sim.state.finishedAt = new Date().toISOString(); });
          return send(202, { id });
        }
        if (url.pathname === '/api/control') {
          if (!running()) return send(409, { error: '当前没有运行中的仿真' });
          active.sim.control(body.action, body.value); return send(200, { ok: true });
        }
        return send(404, { error: '接口不存在' });
      }
      if (req.method !== 'GET') return send(405, { error: '不支持该方法' });
      if (url.pathname === '/stress') {
        const batches = (await readdir(output, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^stress-[\dTZ-]+$/.test(entry.name)).map(entry => entry.name).sort();
        const requested = url.searchParams.get('batch');
        const directory = requested ? batches.find(name => name === requested) : batches.at(-1);
        if (!directory) return send(404, { error: '还没有压力测试记录，请先运行 npm run test:stress' });
        let report;
        try { report = JSON.parse(await readFile(join(output, directory, 'results.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; report = { startedAt: '测试刚开始', updatedAt: new Date().toISOString(), results: [] }; }
        const profiles = JSON.parse(await readFile(join(output, directory, 'profiles.json'), 'utf8'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(renderStressReport(report, profiles));
      }
      if (url.pathname === '/api/state') {
        const id = url.searchParams.get('id'); const selected = id ? jobs.get(id) : active || [...jobs.values()].at(-1);
        return send(200, { token, defaults: DEFAULT_CONFIG, running: !!running(), activeId: active?.sim.id || null,
          selected: selected ? value(selected) : null,
          history: [...jobs.entries()].reverse().slice(0, 20).map(([id, job]) => { const state = value(job); return { id, startedAt: state.startedAt, config: state.config, status: state.status, verdict: state.verdict }; }),
        });
      }
      const frame = /^\/api\/frame\/(run-[a-f0-9-]{36})\/(\d+)$/.exec(url.pathname);
      if (frame) {
        const image = jobs.get(frame[1])?.sim?.frames.get(Number(frame[2]));
        if (!image) return send(404, { error: '暂无快照' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(image.bytes);
      }
      if (url.pathname.startsWith('/artifacts/')) {
        const [, , id, ...parts] = url.pathname.split('/');
        if (!jobPattern.test(id || '') || !jobs.has(id)) return send(404, { error: '记录不存在' });
        const directory = jobs.get(id).directory; const path = resolve(directory, ...parts);
        if (!path.startsWith(directory + sep) || !['.json', '.zip', '.webm', '.png'].includes(extname(path))) return send(403, { error: '文件不可访问' });
        const data = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store', 'Content-Disposition': extname(path) === '.webm' ? 'inline' : 'attachment' }); return res.end(data);
      }
      if (url.pathname === '/api/files') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return send(404, { error: '记录不存在' });
        const files = [];
        async function walk(directory, prefix = '') {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const name = prefix + entry.name;
            if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/');
            else if (['.json', '.zip', '.webm'].includes(extname(entry.name))) files.push(name);
          }
        }
        await walk(job.directory); return send(200, { files });
      }
      if (url.pathname.startsWith('/app/')) {
        const name = decodeURIComponent(url.pathname.slice(5)) || 'index.html';
        if (!appFiles.has(name) && !/^icons\/[a-z0-9-]+\.(png|svg)$/.test(name)) return send(404, { error: '资源不存在' });
        let bytes = await readFile(join(root, name));
        if (name === 'sync.js' && active) {
          const config = active.sim.config;
          bytes = Buffer.from(bytes.toString().replace(/export const UPLOAD_DELAY = \d+;/, `export const UPLOAD_DELAY = ${config.uploadSeconds * 1000};`).replace(/export const PULL_INTERVAL = \d+;/, `export const PULL_INTERVAL = ${config.pollSeconds * 1000};`));
        }
        res.writeHead(200, { 'Content-Type': mime[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); return res.end(bytes);
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'lab.js', 'lab.css'].includes(name)) return send(404, { error: '页面不存在' });
      const bytes = await readFile(join(root, 'simulator', 'web', name));
      res.writeHead(200, { 'Content-Type': mime[extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); res.end(bytes);
    } catch (error) { if (!res.headersSent) send(error.code === 'ENOENT' ? 404 : 400, { error: error.message }); else res.end(); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, async close() { if (running()) { active.sim.stopRequested = true; active.sim.paused = false; } await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lab = await createLabServer();
  console.log('专线仿真实验室：' + lab.origin);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.close(); process.exit(0); });
}
