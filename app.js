import { HOURS, STORAGE_KEY, SYNC_KEY, DEFAULT_SETTINGS, freshData, localDate, money, toCents, nextHour, validateData, mergeData, live, summarize, incomeCSV } from './core.js?v=1.3.4';
import { createSyncClient, validateConnection, DATA_REPO, UPLOAD_DELAY, PULL_INTERVAL, hasPending, reconcileActive } from './sync.js?v=1.3.4';
import { sheetGeometry, scrollDelta, displayDate, departurePassed } from './ui.js?v=1.3.4';
import { APP_VERSION, startUpdates } from './updates.js?v=1.3.4';

import { emptyPending, allPending, markPending, acknowledgePending, createUploadScheduler } from './scheduler.js?v=1.3.4';

const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  notebook: '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4m6-9h4m-4 4h4"/>',
  chart: '<path d="M4 4v16h17M8 15v-4m5 4V6m5 9v-6"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h5l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="11.5" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="m5 3 4 4-2 3a15 15 0 0 0 7 7l3-2 4 4-2 3C10 22 2 14 2 5z"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  wallet: '<path d="M20 8H5a3 3 0 0 1 0-6h13v6M3 5v14a2 2 0 0 0 2 2h15V8m0 5h-5v4h5"/>',
  shield: '<path d="M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6zM8 12l3 3 5-6"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11M9 14l3-3 3 3m-3-3v10"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  bus: '<rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 12h14M8 7h8M8 19v3m8-3v3M8 16h1m6 0h1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.notebook}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
let data = freshData();
let storageIssue = '';
let connection = null;
try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) data = validateData(JSON.parse(raw)); } catch { storageIssue = '本机旧记录无法读取，已保留原始内容。请先导出原始备份，再处理数据。当前已停止写入，避免覆盖。'; }
try { const raw = localStorage.getItem(SYNC_KEY); if (raw) connection = validateConnection({ ...JSON.parse(raw), repo: DATA_REPO }); } catch { /* Invalid connection never blocks local records. */ }
let state = { page: 'bookings', date: localDate(), hour: nextHour(), allDay: true, direction: 'outbound', filter: 'all', search: '' };
let lastLocalDay = localDate();
let syncStatus = connection ? '等待同步' : '未连接云端';
let lastSynced = '';
let syncError = '';
let syncing = false;
let syncRequested = false;
let syncClient = connection ? createSyncClient(connection) : null;
let retryNotBefore = 0;
let syncFailures = 0;
let historyError = '';
let loadingMonth = '';
let historyController;
let connectionEpoch = 0;
const historyChecked = new Map();
const uploadScheduler = createUploadScheduler(() => runSync(false, 'full'));
let syncGeneration = 0;
let activeSyncController;
let installPrompt;
let confirmAction;
let toastTimer;
let formDirty = false;
let editingSnapshot = null;

function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3600); }
function currentData() {
  if (storageIssue) return data;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? mergeData(data, validateData(JSON.parse(raw))) : data;
}
function localSyncState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const saved = raw ? JSON.parse(raw) : null;
  const stored = saved?._sync;
  if (stored && stored.pending && ['bookings', 'extras'].every(key => stored.pending[key] && typeof stored.pending[key] === 'object' && !Array.isArray(stored.pending[key])) && typeof stored.pending.settings === 'string') return stored;
  const pending = saved ? allPending(validateData(saved)) : emptyPending();
  return { pending, since: hasPending(pending) ? Date.now() : 0, archives: {}, cutoff: '' };
}
function persist(next, options = {}) {
  if (storageIssue) throw new Error(storageIssue);
  const safe = validateData(next);
  const meta = localSyncState();
  if (options.changed) meta.pending = markPending(meta.pending, currentData(), safe);
  if (options.ack) meta.pending = acknowledgePending(meta.pending, options.ack);
  if (options.archives) { if (JSON.stringify(meta.archives) !== JSON.stringify(options.archives)) historyChecked.clear(); meta.archives = options.archives; }
  if (options.cutoff) meta.cutoff = options.cutoff;
  meta.since = hasPending(meta.pending) ? (meta.since || Date.now()) : 0;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...safe, _sync: meta })); } catch { throw new Error('手机存储空间不足或不允许保存，本次修改未保存。请保留当前手机记录并检查存储设置。'); }
  data = safe;
}
function change(update) {
  try {
    const next = structuredClone(currentData()); update(next);
    // Immutable origin month makes historical date changes findable across phones.
    for (const key of ['bookings', 'extras']) for (const row of next[key]) if (row.date && !row.homeMonth) row.homeMonth = row.date.slice(0, 7);
    persist(next, { changed: true }); render(); queueSync(); return true;
  } catch (error) { toast(error.message); return false; }
}
function stamp(previous) { return new Date(Math.max(Date.now(), Date.parse(previous || '2000-01-01') + 1)).toISOString(); }
function updateRecord(key, id, patch) {
  return change(next => { const row = next[key].find(row => row.id === id); if (!row || row.deleted) throw new Error('这条记录已被删除，请刷新查看'); Object.assign(row, patch, { updatedAt: stamp(row.updatedAt) }); });
}
function queueSync() {
  if (!connection || storageIssue) return;
  const meta = localSyncState();
  if (!hasPending(meta.pending)) { uploadScheduler.clear(); return; }
  syncStatus = navigator.onLine ? '已存本机 · 待上传' : '离线 · 等待上传'; updateBadge(); renderSyncState();
  if (!syncing && navigator.onLine) uploadScheduler.schedule(Math.max((meta.since || Date.now()) + UPLOAD_DELAY, retryNotBefore));
}
async function runSync(manual = false, mode = 'full') {
  if (!connection || storageIssue) return;
  if (syncing) { if (manual) syncRequested = true; return; }
  if (!navigator.onLine) { syncStatus = '离线 · 等待上传'; updateBadge(); renderSyncState(); if (manual) toast('当前离线，记录已保存在本机'); return; }
  if (!manual && Date.now() < retryNotBefore) { queueSync(); return; }
  const generation = syncGeneration;
  const batch = structuredClone(localSyncState().pending);
  const client = syncClient;
  syncing = true; syncRequested = false; syncError = ''; syncStatus = mode === 'pull' ? '正在刷新…' : '正在同步…'; updateBadge(); renderSyncState();
  if (mode === 'full') uploadScheduler.clear();
  const controller = new AbortController(); activeSyncController = controller;
  const timeout = setTimeout(() => controller.abort(), 25000);
  let succeeded = false;
  try {
    await client.sync(currentData, (next, scope) => {
      if (generation !== syncGeneration) throw new Error('连接已更改');
      const merged = scope.history ? mergeData(currentData(), next) : reconcileActive(currentData(), next, localSyncState().pending, scope.cutoff);
      persist(merged, scope);
    }, controller.signal, { mode, pending: batch });
    if (generation !== syncGeneration) return;
    if (mode === 'full') persist(currentData(), { ack: batch });
    syncFailures = 0; retryNotBefore = 0; succeeded = true;
    lastSynced = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    syncStatus = hasPending(localSyncState().pending) ? '已存本机 · 待上传' : '已同步 ' + lastSynced;
    if (manual) toast(hasPending(localSyncState().pending) ? '本批已同步，新修改将继续上传' : '已与云端同步');
  } catch (error) {
    if (generation !== syncGeneration) return;
    syncStatus = '同步未完成'; syncFailures++;
    retryNotBefore = Math.max(error.retryAt || 0, Date.now() + Math.min(30000 * 2 ** (syncFailures - 1), 600000));
    syncError = error.name === 'AbortError' ? '网络连接超时，记录已保留在本机' : error instanceof TypeError ? '无法连接同步服务，请检查网络后重试' : error.message;
    if (manual) toast(syncError);
  } finally {
    clearTimeout(timeout); syncing = false; if (activeSyncController === controller) activeSyncController = null;
    if (generation === syncGeneration) {
      const requested = syncRequested; syncRequested = false;
      updateBadge(); render();
      if (requested && succeeded) runSync(true);
      else if (hasPending(localSyncState().pending)) {
        const meta = localSyncState();
        if (navigator.onLine) uploadScheduler.schedule(Math.max((meta.since || Date.now()) + UPLOAD_DELAY, retryNotBefore));
      }
      loadSelectedHistory(manual);
    } else if (connection) { queueMicrotask(() => runSync()); }
  }
}
async function loadSelectedHistory(force = false) {
  if (!connection || storageIssue || state.page === 'settings' || !localSyncState().cutoff || state.date >= localSyncState().cutoff) return;
  const month = state.date.slice(0, 7);
  if (loadingMonth === month || (!force && Date.now() - (historyChecked.get(month) || 0) < PULL_INTERVAL)) return;
  if (!navigator.onLine) { historyError = '当前离线，显示本机已缓存的历史记录'; renderHistoryStatus(); return; }
  historyController?.abort(); const controller = new AbortController(); historyController = controller;
  const epoch = connectionEpoch; const client = syncClient;
  loadingMonth = month; historyChecked.set(month, Date.now()); historyError = ''; renderHistoryStatus();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const archived = await client.history(month, localSyncState().archives || {}, controller.signal);
    if (epoch !== connectionEpoch || controller.signal.aborted) return;
    persist(mergeData(currentData(), archived)); historyChecked.set(month, Date.now());
  } catch (error) { if (epoch === connectionEpoch && historyController === controller) historyError = '历史加载未完成，显示本机缓存；可点立即同步重试'; }
  finally {
    clearTimeout(timeout);
    if (historyController === controller) { loadingMonth = ''; historyController = null; render(); }
  }
}
function renderHistoryStatus() {
  const status = $('#history-status'); if (status) status.textContent = loadingMonth ? '正在加载历史月份…' : historyError;
}
function updateBadge() {
  const badge = $('#connection-status');
  const offline = !navigator.onLine;
  badge.classList.toggle('error', !!storageIssue || (connection && (syncStatus === '同步未完成' || offline)));
  badge.innerHTML = `<i></i><span id="sync-summary">${esc(storageIssue ? '存储异常' : connection ? (offline ? '离线 · 本机保存' : syncStatus) : '本机保存')}</span>`;
  $('#header-sync-button').hidden = !connection;
}
function dateControls() { return `<div class="date-control"><button class="icon-button" data-action="previous-date" aria-label="前一天" ${state.date === '2020-01-01' ? 'disabled' : ''}>‹</button><label class="date-picker home-date"><span class="date-display" aria-hidden="true">${displayDate(state.date, true)}</span><input type="date" id="selected-date" aria-label="查看日期" min="2020-01-01" max="2100-12-31" value="${state.date}"></label><button class="icon-button" data-action="next-date" aria-label="后一天" ${state.date === '2100-12-31' ? 'disabled' : ''}>›</button><button class="today-button" data-action="today">今天</button></div>`; }
function refreshDateDisplays() {
  document.querySelectorAll('.date-picker').forEach(picker => {
    picker.querySelector('.date-display').textContent = displayDate(picker.querySelector('input').value, picker.classList.contains('home-date'));
  });
}
function dayName() { const date = new Date(state.date + 'T12:00:00'); const today = state.date === localDate(); return `${date.getMonth() + 1}月${date.getDate()}日 · ${today ? '今天，' : ''}${['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]}`; }
function heading(title, subtitle = '') { return `<div class="page-heading"><div><h1>${title}</h1><p class="subtitle">${subtitle || dayName()}</p></div>${dateControls()}</div>`; }
function directionControls() { return `<div class="segmented" aria-label="行车方向"><button data-direction="outbound" class="${state.direction === 'outbound' ? 'active' : ''}" aria-pressed="${state.direction === 'outbound'}">开往高铁</button>${data.settings.returnEnabled ? `<button data-direction="return" class="${state.direction === 'return' ? 'active' : ''}" aria-pressed="${state.direction === 'return'}">开往大石</button>` : ''}</div>`; }
function incomeCard(summary, label = '今日实收', action = true) { return `<section class="income-card" aria-label="${label}"><div class="card-label">${label}</div><div class="income-value"><span class="currency">¥</span>${money(summary.received)}</div><div class="income-foot"><span>待收 ¥${money(summary.unpaid)}</span>${action ? '<button data-page="income">明细 ›</button>' : '<span>含补记收入</span>'}</div></section>`; }
function bookingsPage() {
  const day = summarize(data, state.date);
  const trip = summarize(data, state.date, state.allDay ? undefined : state.hour, state.direction);
  const now = new Date();
  let rows = live(data.bookings).filter(row => row.date === state.date && (state.allDay || row.hour === state.hour) && row.direction === state.direction);
  if (state.filter !== 'all') rows = rows.filter(row => row.status === state.filter);
  const query = state.search.trim().toLowerCase();
  if (query) rows = rows.filter(row => [row.name, row.phone, row.pickup, row.stop, row.note].some(value => value.toLowerCase().includes(query)));
  rows.sort((a, b) => a.hour.localeCompare(b.hour) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  return `${heading(state.date === localDate() ? '今天的行程' : '预约台账')}
  ${!connection ? `<div class="sync-hint"><span>${icon('cloud')} 尚未开启多人同步</span><button class="text-button" data-page="settings">设置 ›</button></div>` : ''}
  <div class="overview">${incomeCard(day, state.date === localDate() ? '今日实收' : '当日实收')}<section class="day-card"><div class="day-card-head"><h3>当日预约</h3></div><div class="day-counts"><div><strong>${day.passengers}<small>人</small></strong><p>预约乘客</p></div><div><strong>${day.waiting}<small>人</small></strong><p>等待上车</p></div></div></section></div>
  <section class="schedule-wrap"><div class="section-caption">${directionControls()}<span>选择班次</span></div><div class="hours" aria-label="班次">${HOURS.map(hour => { const s = summarize(data, state.date, hour, state.direction); return `<button class="hour ${!state.allDay && state.hour === hour ? 'active' : ''} ${s.count ? 'has-bookings' : ''}" data-hour="${hour}" aria-pressed="${!state.allDay && state.hour === hour}"><strong>${hour}</strong><small>${s.passengers ? s.passengers + ' 人预约' : '暂无预约'}</small></button>`; }).join('')}</div></section>
  <div class="list-heading"><div class="list-title"><h2>${state.allDay ? (state.date === localDate() ? '今日乘客' : '当日乘客') : state.hour + ' 乘客'}</h2></div><button class="button primary compact" data-action="add">${icon('plus')} 新增预约</button></div>
  <div class="search-bar">${icon('search')}<input id="passenger-search" type="search" placeholder="查找${state.allDay ? '当天' : '本班'}的电话、称呼、上车点" aria-label="查找${state.allDay ? '当天' : '本班'}乘客" value="${esc(state.search)}" autocomplete="off"></div>
  <div class="filter-tabs" aria-label="乘车状态">${[['all','全部'],['booked','待上车'],['boarded','已上车'],['cancelled','已取消']].map(([key,label]) => `<button data-filter="${key}" class="${state.filter === key ? 'active' : ''}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}</div>
  <div class="trip-summary"><span>${state.allDay ? '当天' : '本班'}预约 <b>${trip.passengers}</b> 人 · 待接 <b>${trip.waiting}</b> 人</span><span>实收 <b>¥${money(trip.received)}</b></span></div>
  <div class="booking-list">${rows.length ? passengerGroups(rows, now) : `<section class="empty-state" style="grid-column:1/-1"><div class="empty-icon">${icon('bus')}</div><h3>${query ? (state.allDay ? '当天没有匹配的乘客' : '本班没有匹配的乘客') : state.filter === 'all' ? (state.allDay ? '当天还没有预约' : '这一班，还没有预约') : '暂无' + ({ booked:'待上车', boarded:'已上车', cancelled:'已取消' }[state.filter]) + '记录'}</h3>${query ? '<p>试试其他电话、称呼或上车地点</p>' : ''}${!query ? `<button class="button secondary" data-action="add">${icon('plus')} 记一笔预约</button>` : ''}</section>`}</div>
  `;
}
function passengerGroups(rows, now) {
  const groups = state.allDay ? HOURS.map(hour => ({ hour, rows: rows.filter(row => row.hour === hour) })).filter(group => group.rows.length) : [{ hour: state.hour, rows }];
  return groups.map(group => `<section class="departure-group" data-departure-hour="${group.hour}">${state.allDay ? `<div class="departure-heading ${departurePassed(state.date, group.hour, now) ? 'past-trip' : ''}"><strong>${group.hour}</strong><small>${departurePassed(state.date, group.hour, now) ? '已过发车时间' : '待发车'}</small></div>` : ''}${['大石', '马岭', '江门', '兴文高铁站'].map(stop => {
    const passengers = group.rows.filter(row => row.stop === stop);
    return passengers.length ? `<section class="stop-group"><div class="stop-heading"><i class="stop-dot"></i>${stop}<small>${passengers.filter(row => row.status !== 'cancelled').reduce((n, row) => n + row.passengers, 0)} 人</small></div>${passengers.map(row => bookingCard(row, now)).join('')}</section>` : '';
  }).join('')}</section>`).join('');
}
function bookingCard(row, now = new Date()) {
  const status = { booked: '待上车', boarded: '已上车', cancelled: '已取消' }[row.status];
  return `<article class="booking-card ${row.status === 'cancelled' ? 'cancelled' : ''} ${state.allDay && departurePassed(row.date, row.hour, now) ? 'past-departure' : ''}" data-record="${esc(row.id)}"><div class="booking-top"><div class="passenger">${esc(row.name || '预约乘客')}${state.allDay ? `<time class="departure-time" datetime="${row.date}T${row.hour}">${row.hour}</time>` : ''}<small>${row.passengers} 人 · ¥${money(row.passengers * row.fare)}</small></div><span class="status ${row.status}">${status}</span></div><div class="pickup">${icon('pin')}<span>${esc(row.pickup)}</span></div>${row.note ? `<p class="booking-note">${esc(row.note)}</p>` : ''}<div class="booking-bottom"><a class="phone-link" href="tel:${esc(row.phone.replace(/[^+\d]/g,''))}" aria-label="拨打 ${esc(row.phone)}">${icon('phone')}${esc(row.phone)}</a><div class="booking-actions">${row.status !== 'cancelled' ? `${row.status === 'booked' ? `<button class="chip-button" data-board="${esc(row.id)}">标记上车</button>` : ''}<button class="chip-button ${row.paid ? 'paid' : 'emphasized'}" data-paid="${esc(row.id)}">${row.paid ? '已收款' : '收款'}</button>` : ''}<button class="icon-button edit-button" data-edit="${esc(row.id)}" aria-label="编辑 ${esc(row.name || row.phone)}">${icon('edit')}</button></div></div></article>`;
}
function incomePage() {
  const day = summarize(data, state.date);
  const dir = summarize(data, state.date, undefined, state.direction);
  const max = Math.max(1, ...HOURS.map(hour => summarize(data, state.date, hour).received));
  const extras = live(data.extras).filter(row => row.date === state.date).sort((a,b) => a.hour.localeCompare(b.hour));
  return `${heading('收入统计')}
  <div class="overview income-overview">${incomeCard(day, state.date === localDate() ? '今日实收' : '当日实收', false)}<div class="metric-panel"><div class="metric-row"><span>预约应收</span><strong>¥${money(day.expected)}</strong></div><div class="metric-row"><span>预约未收</span><strong>¥${money(day.unpaid)}</strong></div><div class="metric-row"><span>补记实收</span><strong>¥${money(day.extra)}</strong></div></div></div>
  <section class="panel"><div class="list-heading"><h3>一天的收入节奏</h3><span class="muted">往返合计 · 实收</span></div><div class="bar-chart" aria-label="各班次往返实收收入">${HOURS.map(hour => { const sum = summarize(data, state.date, hour); return `<div class="bar-column" title="${hour} 实收 ¥${money(sum.received)}"><div class="bar ${sum.received ? 'has-income' : ''}" style="height:${Math.max(3, sum.received / max * 90)}px"></div><small>${hour.slice(0,2)}时</small></div>`; }).join('')}</div></section>
  <div class="list-heading"><h2>班次账单</h2><div class="header-action"><button class="button secondary" data-action="csv">${icon('download')} 导出</button><button class="button primary" data-action="extra">${icon('plus')} 补记收入</button></div></div><div class="toolbar">${directionControls()}</div>
  <section class="panel" style="margin-top:0;padding-top:6px"><div class="table-scroll"><table class="trip-table"><thead><tr><th>始发班次</th><th>人数</th><th>待收</th><th>补记</th><th>实收（元）</th></tr></thead><tbody>${HOURS.map(hour => { const s = summarize(data, state.date, hour, state.direction); return `<tr><td><button class="text-button" data-view-trip="${hour}">${hour}</button></td><td>${s.passengers}</td><td>${money(s.unpaid)}</td><td>${money(s.extra)}</td><td class="money-cell">${money(s.received)}</td></tr>`; }).join('')}</tbody><tfoot><tr><td>本方向合计</td><td>${dir.passengers}</td><td>${money(dir.unpaid)}</td><td>${money(dir.extra)}</td><td class="money-cell">${money(dir.received)}</td></tr></tfoot></table></div></section>
  ${extras.length ? `<section class="panel"><h3>当日补记明细</h3>${extras.map(row => `<div class="extras-row"><div>${esc(row.note)}<small>${row.hour} · ${row.direction === 'return' ? '返回大石' : '开往高铁站'}</small></div><div><b>¥${money(row.amount)}</b><button class="icon-button edit-button" data-delete-extra="${esc(row.id)}" aria-label="删除补记收入 ${esc(row.note)}">${icon('trash')}</button></div></div>`).join('')}</section>` : ''}`;
}
function settingsPage() {
  return `<div class="page-heading"><div><h1>设置</h1></div></div>
  <section class="panel settings-panel connection-panel"><form id="sync-form"><label>连接密钥<input name="token" type="password" ${connection ? '' : 'required'} placeholder="${connection ? '已保存密钥，填写可更换' : '粘贴管理员提供的密钥'}" autocomplete="off" autocapitalize="none" spellcheck="false"></label><button class="button primary full" type="submit">${connection ? '保存并重新连接' : '连接并同步'}</button></form><p class="sync-state" role="status">${esc(connection ? syncStatus : '尚未连接')}</p><p id="sync-error" class="connection-error" role="alert" ${syncError ? '' : 'hidden'}>${esc(syncError)}</p></section>`;
}
function renderSyncState() {
  if ($('#sync-summary')) $('#sync-summary').textContent = syncStatus;
  const status = $('.sync-state');
  if (status) status.textContent = syncStatus;
  const error = $('#sync-error');
  if (error) { error.textContent = syncError; error.hidden = !syncError; }
}
function render() {
  const today = localDate();
  if (state.allDay && state.date === lastLocalDay && today !== lastLocalDay) { state.date = today; state.hour = nextHour(); }
  lastLocalDay = today;
  const activeForm = document.activeElement?.closest('#sync-form, #fares-form');
  const activeField = activeForm ? document.activeElement.name : null;
  const formValues = activeForm ? [...activeForm.elements].filter(el => el.name).map(el => ({ name: el.name, value: el.value, checked: el.checked })) : null;
  const search = $('#passenger-search');
  const focused = document.activeElement === search;
  const selection = focused ? search.selectionStart : 0;
  const hoursScroll = $('.hours')?.scrollLeft;
  $('#app').innerHTML = `${connection && state.page !== 'settings' ? '<p id="history-status" role="status"></p>' : ''}${storageIssue ? `<div class="storage-warning" role="alert">${esc(storageIssue)}</div>` : ''}` + ({ bookings: bookingsPage, income: incomePage, settings: settingsPage }[state.page])();
  document.querySelectorAll('.bottom-nav [data-page]').forEach(button => { button.classList.toggle('active', button.dataset.page === state.page); button.setAttribute('aria-current', button.dataset.page === state.page ? 'page' : 'false'); });
  if (focused && $('#passenger-search')) { $('#passenger-search').focus(); $('#passenger-search').setSelectionRange(selection, selection); }
  if (activeForm && formValues) { const replacement = $('#' + activeForm.id); if (replacement) { for (const entry of formValues) { const input = replacement.elements[entry.name]; if (input) { input.value = entry.value; if (input.type === 'checkbox') input.checked = entry.checked; } } replacement.elements[activeField]?.focus(); } }
  if ($('.hours')) { if (hoursScroll !== undefined) $('.hours').scrollLeft = hoursScroll; else ($('.hour.active') || $(`.hour[data-hour="${state.hour}"]`))?.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  updateBadge();
  refreshDateDisplays();
  renderHistoryStatus();
  queueMicrotask(() => loadSelectedHistory());
}
function confirm(title, message, action, destructive = false) {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  $('#confirm-action').className = 'button ' + (destructive ? 'danger-light' : 'primary');
  confirmAction = action; $('#confirm-dialog').showModal();
}
function closeDialog(id) {
  if (id === 'booking-dialog' && formDirty) { confirm('放弃本次修改？', '尚未保存的预约内容会丢失。', () => { formDirty = false; $('#booking-dialog').close(); }); return; }
  $('#' + id).close();
}
function updateFormTotal() {
  const f = $('#booking-form').elements;
  try { $('#form-total').textContent = '¥' + money(toCents(f.fare.value || '0') * Number(f.passengers.value || 0)); } catch { $('#form-total').textContent = '请检查金额'; }
}
function applyDirection(defaultFare = true) {
  const form = $('#booking-form'); const returning = form.elements.direction.value === 'return';
  form.querySelectorAll('.stop-options label').forEach(label => { label.hidden = returning ? label.querySelector('input').value !== '兴文高铁站' : label.querySelector('input').value === '兴文高铁站'; });
  const checked = form.querySelector('[name="stop"]:checked');
  if ((returning && checked?.value !== '兴文高铁站') || (!returning && checked?.value === '兴文高铁站')) form.querySelector(`[name="stop"][value="${returning ? '兴文高铁站' : '马岭'}"]`).checked = true;
  if (defaultFare) form.elements.fare.value = (data.settings.fares[form.querySelector('[name="stop"]:checked').value] / 100).toFixed(2);
  form.elements.pickup.placeholder = returning ? '例如：高铁站出站口左侧' : '例如：马岭农贸市场门口';
  updateFormTotal();
}
function openBooking(id) {
  const form = $('#booking-form'); form.reset();
  const row = id ? live(data.bookings).find(row => row.id === id) : null;
  if (id && !row) return toast('这条预约已被删除');
  editingSnapshot = row ? structuredClone(row) : null;
  form.elements.id.value = row?.id || '';
  form.elements.date.value = row?.date || state.date;
  form.elements.hour.value = row?.hour || state.hour;
  form.elements.direction.value = row?.direction || state.direction;
  $('#direction-field').hidden = !data.settings.returnEnabled && row?.direction !== 'return';
  $('#form-title').textContent = row ? '编辑预约' : '新增预约';
  $('#booking-error').textContent = ''; $('#delete-booking').hidden = !row;
  if (row) {
    for (const key of ['pickup', 'phone', 'name', 'passengers', 'status', 'note']) form.elements[key].value = row[key];
    form.querySelector(`[name="stop"][value="${row.stop}"]`).checked = true;
    form.elements.fare.value = (row.fare / 100).toFixed(2); form.elements.paid.value = row.paid ? 'yes' : 'no';
  }
  applyDirection(!row); formDirty = false; refreshDateDisplays(); lockBookingPage(); $('#booking-dialog').showModal(); $('#form-title').focus({ preventScroll: true }); $('.sheet-body').scrollTop = 0; updateSheetViewport();
}
let bookingScrollY = 0;
let sheetFrame, focusTimer;
function lockBookingPage() {
  bookingScrollY = $('#page-scroll').scrollTop;
  document.body.classList.add('booking-open');
}
function revealBookingField() {
  const field = document.activeElement;
  const body = $('#booking-dialog .sheet-body');
  if (!body.contains(field) || !field.matches('input, select, textarea')) return;
  // Scroll only the form body. scrollIntoView can pan the entire iOS page.
  body.scrollTop += scrollDelta(field.getBoundingClientRect(), body.getBoundingClientRect());
}
function updateSheetViewport() {
  if (!$('#booking-dialog').open) return;
  cancelAnimationFrame(sheetFrame);
  sheetFrame = requestAnimationFrame(() => {
    const viewport = window.visualViewport;
    const geometry = sheetGeometry(viewport?.height || window.innerHeight, viewport?.offsetTop || 0, window.innerHeight);
    const sheet = $('#booking-dialog');
    sheet.style.setProperty('--sheet-height', `${geometry.height}px`);
    sheet.style.setProperty('--sheet-top', `${geometry.top}px`);
    sheet.classList.toggle('keyboard-open', geometry.keyboard);
    $('#keyboard-done').hidden = !geometry.keyboard;
    revealBookingField();
  });
}
window.visualViewport?.addEventListener('resize', updateSheetViewport);
window.visualViewport?.addEventListener('scroll', updateSheetViewport);
window.addEventListener('resize', updateSheetViewport);
$('#booking-dialog').addEventListener('focusin', () => {
  updateSheetViewport();
  clearTimeout(focusTimer);
  focusTimer = setTimeout(updateSheetViewport, 350);
});
$('#keyboard-done').addEventListener('click', () => {
  document.activeElement?.blur();
  $('#form-title').focus({ preventScroll: true });
});
$('#booking-dialog').addEventListener('close', () => {
  cancelAnimationFrame(sheetFrame); clearTimeout(focusTimer);
  document.body.classList.remove('booking-open');
  $('#page-scroll').scrollTop = bookingScrollY;
});
function openExtra() { const form = $('#extra-form'); form.reset(); form.elements.date.value = state.date; form.elements.hour.value = state.hour; form.elements.direction.value = state.direction; $('#extra-direction-field').hidden = !data.settings.returnEnabled; $('#extra-error').textContent = ''; refreshDateDisplays(); $('#extra-dialog').showModal(); }
function download(content, name, type = 'application/json') { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000); }
function exportBackup() { download(JSON.stringify({ ...currentData(), exportedAt: new Date().toISOString() }, null, 2), `兴文高铁站专线-全部备份-${localDate()}.json`); toast('备份已导出，请保存下载的文件'); }

document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.close) return closeDialog(button.dataset.close);
  if (button.dataset.page) { state.page = button.dataset.page; state.search = ''; render(); $('#page-scroll').scrollTo(0, 0); return; }
  if (button.dataset.hour) {
    if (!state.allDay && state.hour === button.dataset.hour) { state.allDay = true; state.date = localDate(); state.hour = nextHour(); }
    else { state.allDay = false; state.hour = button.dataset.hour; }
    state.search = ''; state.filter = 'all'; render(); return;
  }
  if (button.dataset.direction) { state.direction = button.dataset.direction; render(); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; render(); return; }
  if (button.dataset.edit) return openBooking(button.dataset.edit);
  if (button.dataset.board) { if (updateRecord('bookings', button.dataset.board, { status: 'boarded' })) toast('已标记上车'); return; }
  if (button.dataset.paid) {
    const row = live(data.bookings).find(row => row.id === button.dataset.paid); if (!row) return;
    confirm(row.paid ? '撤销这笔收款？' : `确认已收到 ¥${money(row.fare * row.passengers)}？`, row.paid ? '撤销后，本单会恢复为未收款，并从实收中扣除。' : `${row.name || row.phone} · ${row.passengers} 人。本单将按全额计入 ${row.date} ${row.hour} 班次实收。`, () => { if (updateRecord('bookings', row.id, { paid: !row.paid })) toast(row.paid ? '已撤销收款' : '收款已记入台账'); }); return;
  }
  if (button.dataset.viewTrip) { state.hour = button.dataset.viewTrip; state.allDay = false; state.page = 'bookings'; state.filter = 'all'; state.search = ''; render(); $('#page-scroll').scrollTo(0, 0); return; }
  if (button.dataset.deleteExtra) { const row = data.extras.find(row => row.id === button.dataset.deleteExtra); confirm('删除这笔补记收入？', `¥${money(row.amount)} · ${row.note}。删除后会同步从收入中扣除。`, () => { if (updateRecord('extras', row.id, { deleted: true })) toast('已删除补记收入'); }, true); return; }
  const action = button.dataset.action;
  if (action === 'add') openBooking();
  if (action === 'extra') openExtra();
  if (action === 'previous-date' || action === 'next-date') { const date = new Date(state.date + 'T12:00:00'); date.setDate(date.getDate() + (action === 'next-date' ? 1 : -1)); const next = localDate(date); if (next >= '2020-01-01' && next <= '2100-12-31') state.date = next; render(); }
  if (action === 'today') { state.date = localDate(); render(); }
  if (action === 'csv') { download(incomeCSV(data, state.date), `兴文高铁站专线-收入-${state.date}.csv`, 'text/csv;charset=utf-8'); toast('当日往返班次收入已导出'); }
  if (action === 'backup') { try { exportBackup(); } catch(error) { toast(error.message); } }
  if (action === 'raw-backup') download(localStorage.getItem(STORAGE_KEY) || '', `兴文高铁站专线-原始记录-${localDate()}.json`);
  if (action === 'import') $('#import-file').click();
  if (action === 'sync') runSync(true);
  if (action === 'check-update') updates.check(true);
  if (action === 'disconnect') confirm('断开云端连接？', '当前手机保留全部本地记录，其他司机和云端数据不受影响。未上传的记录请先同步或导出备份。', () => { syncGeneration++; connectionEpoch++; activeSyncController?.abort(); historyController?.abort(); connection = null; syncClient = null; localStorage.removeItem(SYNC_KEY); uploadScheduler.clear(); syncStatus = '未连接云端'; render(); toast('已断开连接，本机记录已保留'); });
  if (action === 'install') { if (installPrompt) { installPrompt.prompt(); installPrompt = null; } else toast('请在浏览器菜单中选择添加到主屏幕'); }
});
$('#confirm-action').addEventListener('click', () => { $('#confirm-dialog').close(); const action = confirmAction; confirmAction = null; action?.(); });
$('#booking-dialog').addEventListener('cancel', event => { if (formDirty) { event.preventDefault(); closeDialog('booking-dialog'); } });
document.addEventListener('input', event => {
  if (event.target.id === 'passenger-search') { state.search = event.target.value; render(); }
  if (event.target.closest('#booking-form')) { formDirty = true; if (['fare', 'passengers'].includes(event.target.name)) updateFormTotal(); }
});
document.addEventListener('change', event => {
  if (event.target.matches('.date-picker input')) refreshDateDisplays();
  if (event.target.id === 'selected-date') { if (event.target.validity.valid && event.target.value) state.date = event.target.value; render(); }
  if (event.target.closest('#booking-form') && ['stop', 'direction'].includes(event.target.name)) applyDirection(true);
  if (event.target.id === 'import-file') importFile(event.target.files?.[0]);
});
$('#booking-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget; const f = new FormData(form);
  try {
    const id = f.get('id') || crypto.randomUUID();
    const old = editingSnapshot;
    const row = { id, ...(old?.homeMonth ? { homeMonth: old.homeMonth } : {}), date: f.get('date'), hour: f.get('hour'), direction: f.get('direction'), stop: f.get('stop'), pickup: f.get('pickup').trim(), phone: f.get('phone').trim(), name: f.get('name').trim(), passengers: Number(f.get('passengers')), fare: toCents(f.get('fare')), status: f.get('status'), paid: f.get('paid') === 'yes', note: f.get('note').trim(), updatedAt: stamp(old?.updatedAt) };
    if (!/^[+\d ()-]{5,25}$/.test(row.phone)) throw new Error('请填写有效联系电话（5—25 位，可含区号）');
    const candidate = freshData(); candidate.bookings.push(row); validateData(candidate);
    const save = () => {
      if (change(next => { const index = next.bookings.findIndex(item => item.id === id); if (old && (index < 0 || next.bookings[index].deleted)) throw new Error('预约已被其他设备删除，请重新录入'); if (old && next.bookings[index].updatedAt !== old.updatedAt) throw new Error('这笔预约已被更新，请关闭后重新打开查看'); if (index >= 0) next.bookings[index] = row; else next.bookings.push(row); })) { formDirty = false; $('#booking-dialog').close(); state.date = row.date; state.hour = row.hour; state.direction = row.direction; state.filter = 'all'; state.search = ''; render(); toast('预约已保存'); }
    };
    if (row.status === 'cancelled' && row.paid) confirm('取消已收款预约？', '取消后本单不计入实收。请先核实退款，再确认取消。', save); else save();
  } catch (error) { $('#booking-error').textContent = error.message; }
});
$('#delete-booking').addEventListener('click', () => {
  const id = $('#booking-form').elements.id.value;
  confirm('删除这笔预约？', '删除后不会计入人数或收入，也会同步到其他已连接的手机。', () => { if (updateRecord('bookings', id, { deleted: true })) { formDirty = false; $('#booking-dialog').close(); toast('预约已删除'); } }, true);
});
$('#extra-form').addEventListener('submit', event => {
  event.preventDefault(); const f = new FormData(event.currentTarget);
  try { const row = { id: crypto.randomUUID(), date: f.get('date'), hour: f.get('hour'), direction: f.get('direction'), amount: toCents(f.get('amount')), note: f.get('note').trim(), updatedAt: stamp() }; if (!row.note) throw new Error('请填写收入说明'); if (change(next => next.extras.push(row))) { $('#extra-dialog').close(); toast('补记收入已保存'); } }
  catch (error) { $('#extra-error').textContent = error.message; }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'fares-form') {
    event.preventDefault(); const f = new FormData(event.target);
    try { const fares = Object.fromEntries(Object.keys(DEFAULT_SETTINGS.fares).map(stop => [stop, toCents(f.get(stop))])); const returnEnabled = f.get('returnEnabled') === 'on'; if (!returnEnabled) state.direction = 'outbound'; if (change(next => { next.settings = { fares, returnEnabled, updatedAt: stamp(next.settings.updatedAt) }; })) toast('默认票价已保存'); } catch (error) { toast(error.message); }
  }
  if (event.target.id === 'sync-form') {
    event.preventDefault(); const f = new FormData(event.target);
    try {
      const config = validateConnection({ repo: DATA_REPO, token: f.get('token').trim() || connection?.token });
      const connect = () => { try { localStorage.setItem(SYNC_KEY, JSON.stringify(config)); syncGeneration++; connectionEpoch++; activeSyncController?.abort(); historyController?.abort(); historyChecked.clear(); connection = config; syncClient = createSyncClient(config); retryNotBefore = 0; syncFailures = 0; syncStatus = '等待同步'; syncError = ''; document.activeElement?.blur(); render(); if (syncing) { syncRequested = true; setTimeout(() => runSync(true), 500); } else runSync(true); } catch { toast('无法保存连接，请检查浏览器存储设置'); } };
      if (connection && connection.repo !== config.repo) confirm('切换数据仓库？', '本机现有记录会合并到新仓库。请确认这是同一条专线的数据。', connect); else connect();
    } catch (error) { syncError = error.message; renderSyncState(); toast(error.message); }
  }
});
async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > 15 * 1024 * 1024) throw new Error('备份文件太大，最多支持 15 MB');
    const imported = validateData(JSON.parse(await file.text()));
    confirm('合并这份备份？', `包含 ${live(imported.bookings).length} 笔预约、${live(imported.extras).length} 笔补记收入。相同记录保留较新的修改，已有记录不会被整份覆盖。${connection ? '合并后会同步到云端。' : ''}`, () => { if (change(next => Object.assign(next, mergeData(next, imported)))) toast('备份已合并'); });
  } catch (error) { toast(error instanceof SyntaxError ? '备份格式错误，请选择本应用导出的 JSON 文件' : error.message); }
  if ($('#import-file')) $('#import-file').value = '';
}
for (const form of ['#booking-form', '#extra-form']) $(form + ' select[name="hour"]').innerHTML = HOURS.map(hour => `<option value="${hour}">${hour} 发车</option>`).join('');
window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) { try { data = currentData(); render(); queueSync(); } catch { toast('本机数据读取异常，请先备份'); } } });
window.addEventListener('online', () => { updateBadge(); runSync(); });
window.addEventListener('offline', updateBadge);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); runSync(); } });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; if (state.page === 'settings') render(); });
window.addEventListener('beforeunload', event => { if (formDirty) { event.preventDefault(); event.returnValue = ''; } });
let updateStatus = '打开应用时自动检查更新';
const updates = startUpdates({ notify: toast, canReload: () => !document.querySelector('dialog[open]') && !document.activeElement?.closest('form'), onStatus: message => { updateStatus = message; if ($('#update-status')) $('#update-status').textContent = message; } });
render();
if (connection) runSync();
setInterval(() => { if (document.visibilityState === 'visible' && !$('#booking-dialog').open && !$('#extra-dialog').open) { const meta = localSyncState(); runSync(false, hasPending(meta.pending) && Date.now() >= meta.since + UPLOAD_DELAY ? 'full' : hasPending(meta.pending) ? 'pull' : 'full'); } }, PULL_INTERVAL);

// Keep local-time departure styling current without interrupting text entry.
setInterval(() => { if (document.visibilityState === 'visible' && state.page === 'bookings' && state.allDay && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input, textarea, select')) render(); }, 60000);
