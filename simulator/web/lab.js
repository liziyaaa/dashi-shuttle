const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let token = '', defaults, selectedId = '', current, chartMode = 'records', loadedFiles = '', lastHistory = '', starting = false;
const form = $('#config-form');
const statusNames = { starting: '准备中', running: '运行中', completed: '已完成', stopped: '已停止', failed: '运行中断' };
const money = value => '¥' + ((value || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); setTimeout(() => $('#toast').classList.remove('visible'), 3500); }
function fill(config) {
  for (const [name, fallback] of Object.entries(defaults)) {
    const input = form.elements[name]; if (!input) continue;
    if (input.type === 'checkbox') input.checked = config[name] ?? fallback;
    else input.value = config[name] ?? fallback;
  }
  $('#planned').textContent = Number(form.elements.drivers.value) * Number(form.elements.bookingsPerDriver.value);
}
function values() {
  const result = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const input = form.elements[name];
    result[name] = typeof fallback === 'boolean' ? input.checked : typeof fallback === 'number' ? Number(input.value) : input.value;
  }
  return result;
}
function todayConfig() {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { ...defaults, startTime: day + 'T07:00' };
}
async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': token }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求未完成'); return result;
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function drawChart(job) {
  const points = job?.samples || [];
  const series = chartMode === 'records' ? [['expected', '已知记录（含历史）', '#9ba8bb'], ['cloud', '云端记录', '#1671f5'], ['pending', '待上传队列', '#edab48']] : [['requests', '累计 API 请求', '#1671f5'], ['conflicts', '累计 SHA 冲突', '#d97870']];
  $('#chart-legend').innerHTML = series.map(([, label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');
  if (!points.length) { $('#chart').innerHTML = '<p class="empty">时间推进后在这里显示变化。横轴是模拟分钟。</p>'; return; }
  const maxX = Math.max(1, points.at(-1).minute), maxY = Math.max(1, ...points.flatMap(point => series.map(([key]) => point[key])));
  const yMax = Math.ceil(maxY / 5) * 5;
  const plot = series.map(([key, label, color]) => `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${points.map(point => `${48 + point.minute / maxX * 790},${164 - point[key] / yMax * 140}`).join(' ')}"><title>${label}</title></polyline>`).join('');
  const grid = [0, .5, 1].map(value => `<line x1="48" y1="${164 - value * 140}" x2="838" y2="${164 - value * 140}" stroke="#e9edf3"/><text x="38" y="${168 - value * 140}" text-anchor="end" fill="#8b98aa" font-size="11">${Math.round(yMax * value)}</text>`).join('');
  $('#chart').innerHTML = `<svg viewBox="0 0 880 200" role="img" aria-label="横轴模拟分钟，纵轴条数或请求次数">${grid}${plot}<text x="48" y="192" fill="#8b98aa" font-size="11">0 分钟</text><text x="838" y="192" text-anchor="end" fill="#8b98aa" font-size="11">${maxX.toFixed(1)} 分钟</text></svg>`;
}
function renderDrivers(job) {
  const root = $('#drivers'); const phones = job?.drivers || [];
  const signature = (job?.id || '') + ':' + phones.map(phone => phone.id).join(',');
  if (root.dataset.signature !== signature) {
    root.dataset.signature = signature;
    root.innerHTML = phones.length ? phones.map(phone => `<article class="driver" id="driver-${phone.id}"><div class="driver-head">司机 ${phone.id}<span class="connection"></span></div><div class="driver-stat"><div>本机 <b class="count"></b> · 待上传 <b class="pending"></b></div><div class="driver-status"></div><div class="last-action"></div></div><div class="frame empty-frame">等待快照</div></article>`).join('') : '<p class="empty">开始后显示独立司机环境。</p>';
  }
  for (const phone of phones) {
    const card = $(`#driver-${phone.id}`);
    card.querySelector('.connection').textContent = phone.offline ? '离线' : '联网'; card.querySelector('.connection').classList.toggle('offline', phone.offline);
    card.querySelector('.count').textContent = phone.records; card.querySelector('.pending').textContent = phone.pending;
    card.querySelector('.driver-status').textContent = phone.sync || '尚未连接';
    card.querySelector('.last-action').textContent = phone.lastAction || '等待操作';
    const frame = card.querySelector('.frame');
    if (phone.frame && frame.dataset.sequence !== String(phone.frame)) {
      frame.dataset.sequence = String(phone.frame); frame.classList.remove('empty-frame');
      if (!frame.querySelector('img')) frame.innerHTML = `<a target="_blank" rel="noopener" aria-label="查看司机 ${phone.id} 完整快照"><img alt="司机 ${phone.id} 的真实测试页面" loading="lazy"></a>`;
      const url = `/api/frame/${job.id}/${phone.id}?sequence=${phone.frame}`;
      frame.querySelector('img').src = url; frame.querySelector('a').href = url;
    } else if (!phone.frame) frame.textContent = job.config.liveFrames && phone.id <= 6 ? '等待快照（历史运行重开后不保留实时画面）' : '未启用快照';
  }
}
function checkCard(label, check) {
  if (!check) return `<div class="check-result"><b>${label}</b>尚未检查</div>`;
  return `<div class="check-result ${check.passed ? 'ok' : 'bad'}"><b>${label}：${check.passed ? '一致' : '发现差异'}</b>${check.agreedDrivers}/${check.drivers} 台与活跃台账一致 · ${check.pending} 笔待上传</div>`;
}
async function render(state) {
  token = state.token; current = state.selected;
  const job = current; const controlling = !!job && job.id === state.activeId && state.running && ['starting', 'running'].includes(job.status);
  $('#parameters').disabled = state.running; $('#start').disabled = state.running || starting;
  $('#pause').disabled = !controlling || job.paused; $('#pause').hidden = !!(controlling && job.paused);
  $('#resume').hidden = !(controlling && job.paused); $('#stop').disabled = !controlling;
  $('#apply-speed').disabled = !controlling; $('#step').disabled = !controlling || !job.paused;
  const paused = controlling && job.paused;
  $('#run-status').textContent = job ? paused ? '已暂停' : job.verdict === 'passed' ? '自动检查通过' : job.verdict === 'issues' ? '发现问题' : job.verdict === 'coverage' ? '有未覆盖项' : statusNames[job.status] || job.status : '等待开始';
  $('#run-status').className = 'status ' + (job?.verdict || job?.status || '');
  $('#phase').textContent = job?.phase || '设定参数，观察应用如何同步';
  $('#clock').textContent = job ? `模拟时间 ${job.virtualTime} · 已推进 ${job.elapsedMinutes.toFixed(1)} 分钟 · 当前 ${job.speed} 倍速${job.wallSeconds ? ` · 实际运行 ${job.wallSeconds} 秒` : ''}` : '尚未开始';
  $('#progress-fill').style.width = `${job?.progress || 0}%`;
  $('#m-created').textContent = job ? `${job.coverage.created} / ${job.plannedBookings}` : '—';
  $('#m-records').textContent = job ? `${job.metrics.cloudRecords} / ${job.expectedRecords}` : '—';
  $('#m-pending').textContent = job ? job.drivers.reduce((sum, phone) => sum + phone.pending, 0) : '—';
  $('#m-requests').textContent = job?.metrics.requests ?? '—';
  if (job) {
    $('#checks').innerHTML = checkCard('自动检查', job.automaticCheck) + checkCard('手动恢复（另计）', job.recoveryCheck) + `<div class="check-result"><b>实收：云端 ${money(job.cloudReceipt)}</b>操作意图合计 ${money(job.expectedReceipt)}（含历史）</div>`;
    $('#findings').innerHTML = job.findings.map(issue => `<div class="finding ${esc(issue.severity)}">${esc(issue.message)}</div>`).join('');
    const c = job.coverage;
    $('#coverage').textContent = `新增 ${c.created} · 收款 ${c.paid} · 上车 ${c.boarded} · 修改 ${c.edited} · 取消 ${c.cancelled} · 离线新增 ${c.offlineBookings} · 重开 ${c.restarted} · 未覆盖 ${c.skippedActions}`;
    const filter = $('#log-filter').value;
    const logs = job.logs.filter(row => filter === 'all' || filter === 'warning' && row.level !== 'info' || filter === 'error' && row.level === 'error');
    const old = $('#logs'); const bottom = old.scrollHeight - old.scrollTop - old.clientHeight < 30;
    old.innerHTML = logs.map(row => `<div class="log ${esc(row.level)}"><time>${esc(row.at)}</time><span>${esc(row.message)}</span></div>`).join('') || '<p class="empty">暂无匹配记录</p>';
    if (bottom) old.scrollTop = old.scrollHeight;
    $('#network-summary').textContent = `SHA 冲突 ${job.metrics.conflicts} · 服务错误 ${job.metrics.serverErrors} · 限流 ${job.metrics.rateLimits} · 响应丢失 ${job.metrics.lostResponses} · 归档 ${job.metrics.archives} · ${(job.metrics.bytes / 1024).toFixed(1)} KB`;
    $('#requests').innerHTML = [...job.calls].reverse().map(row => `<tr><td>${new Date(row.at + 28800000).toISOString().slice(11, 19)}</td><td>${row.driver}</td><td>${esc(row.method)}</td><td>${esc(row.path)}</td><td class="${row.status >= 400 || !row.status ? 'bad' : ''}">${row.status || '中断 / 处理中'}</td></tr>`).join('');
  }
  drawChart(job); renderDrivers(job);
  const historySignature = JSON.stringify(state.history.map(row => [row.id, row.status]));
  if (historySignature !== lastHistory) {
    lastHistory = historySignature;
    $('#history').innerHTML = '<option value="">当前 / 最近运行</option>' + state.history.map(row => `<option value="${row.id}">${esc(new Date(row.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))} · ${row.config.drivers} 人 · ${statusNames[row.status] || row.status}</option>`).join('');
    $('#history').value = selectedId;
  }
  $('#download-summary').hidden = !job?.finishedAt;
  if (job?.finishedAt) $('#download-summary').href = `/artifacts/${job.id}/summary.json`;
  if (job?.finishedAt && loadedFiles !== job.id) {
    loadedFiles = job.id;
    try {
      const result = await request('/api/files?id=' + job.id);
      $('#files').innerHTML = result.files.map(name => `<a href="/artifacts/${job.id}/${name}" target="_blank" rel="noopener">${esc(name)}</a>`).join('');
    } catch { loadedFiles = ''; }
  } else if (!job?.finishedAt) { $('#files').textContent = '结束后保存参数、结果、请求明细和所选回放文件。'; loadedFiles = ''; }
}
async function poll() {
  try { await render(await request('/api/state' + (selectedId ? '?id=' + selectedId : ''))); }
  catch (error) { $('#time-help').textContent = '控制服务暂时不可达，请检查本机服务是否仍在运行'; }
  setTimeout(poll, document.hidden ? 1800 : 800);
}
form.addEventListener('submit', async event => {
  event.preventDefault(); starting = true; $('#start').disabled = true; $('#form-error').textContent = '';
  try { const config = values(); localStorage.setItem('shuttle-lab:config:v1', JSON.stringify(config)); const result = await request('/api/start', config); selectedId = result.id; $('#live-speed').value = config.speed; lastHistory = ''; loadedFiles = ''; }
  catch (error) { $('#form-error').textContent = error.message; }
  finally { starting = false; }
});
form.addEventListener('input', () => $('#planned').textContent = Number(form.elements.drivers.value) * Number(form.elements.bookingsPerDriver.value));
for (const action of ['pause', 'resume', 'stop']) $('#' + action).addEventListener('click', async () => {
  try { await request('/api/control', { action }); } catch (error) { toast(error.message); }
});
$('#step').addEventListener('click', async () => { try { await request('/api/control', { action: 'step', value: Number($('#step-minutes').value) }); } catch (error) { toast(error.message); } });
$('#apply-speed').addEventListener('click', async () => { try { await request('/api/control', { action: 'speed', value: Number($('#live-speed').value) }); } catch (error) { toast(error.message); } });
$('#reset').addEventListener('click', () => fill(todayConfig()));
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const base = todayConfig();
  const preset = { daily: {}, busy: { drivers: 10, bookingsPerDriver: 5, durationMinutes: 30, speed: 1800, offlinePercent: 0, conflictPercent: 10, editPercent: 50, crossEditPercent: 40 },
    weak: { drivers: 3, bookingsPerDriver: 3, durationMinutes: 30, offlinePercent: 67, offlineStartPercent: 20, offlineMinutes: 8, latencyMs: 150, errorPercent: 10, conflictPercent: 5, lostResponsePercent: 10, rateLimitEvery: 30 },
    quick: { drivers: 2, bookingsPerDriver: 1, durationMinutes: 6, speed: 6000, offlinePercent: 50, offlineStartPercent: 20, offlineMinutes: 3, paidPercent: 100, boardedPercent: 100, editPercent: 100, cancelPercent: 0, settleMinutes: 2 },
  }[button.dataset.preset]; fill({ ...base, ...preset });
}));
$('#export-config').addEventListener('click', () => download(values(), '专线仿真参数.json'));
$('#import-config').addEventListener('click', () => $('#config-file').click());
$('#config-file').addEventListener('change', async event => {
  try { const file = event.target.files?.[0]; if (!file) return; if (file.size > 16000) throw new Error('参数文件过大'); const config = JSON.parse(await file.text()); if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !(key in defaults))) throw new Error('参数文件格式不正确'); fill(config); toast('已填入参数，开始前仍会检查取值范围'); } catch (error) { toast(error.message); }
  event.target.value = '';
});
$('#history').addEventListener('change', event => { selectedId = event.target.value; loadedFiles = ''; });
document.querySelectorAll('[data-chart]').forEach(button => button.addEventListener('click', () => { chartMode = button.dataset.chart; document.querySelectorAll('[data-chart]').forEach(el => el.classList.toggle('selected', el === button)); drawChart(current); }));
try {
  const state = await request('/api/state'); token = state.token; defaults = state.defaults;
  let saved; try { saved = JSON.parse(localStorage.getItem('shuttle-lab:config:v1')); } catch {}
  fill(saved || todayConfig()); await render(state); poll();
} catch (error) { $('#form-error').textContent = '无法连接本机控制服务：' + error.message; }
