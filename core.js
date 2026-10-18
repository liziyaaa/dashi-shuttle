export const HOURS = Array.from({ length: 15 }, (_, i) => String(i + 7).padStart(2, '0') + ':00');
export const STORAGE_KEY = 'dashi-shuttle:v1';
export const SYNC_KEY = 'dashi-shuttle:connection:v1';
export const DEFAULT_SETTINGS = { fares: { 大石: 0, 马岭: 4000, 江门: 2000, 兴文高铁站: 6000 }, returnEnabled: true, updatedAt: '2020-01-01T00:00:00.000Z' };
export function freshData() { return { schema: 1, bookings: [], extras: [], settings: structuredClone(DEFAULT_SETTINGS) }; }
export function localDate(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function money(cents = 0) { return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function toCents(value) { const text = String(value).trim(); if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('金额最多保留两位小数'); const [whole, fraction = ''] = text.split('.'); const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0')); if (!Number.isSafeInteger(result) || result > 99999900) throw new Error('金额超出范围'); return result; }
export function nextHour(now = new Date()) { return HOURS.find(h => Number(h.slice(0, 2)) >= now.getHours() + (now.getMinutes() > 0 ? 1 : 0)) || '21:00'; }
export function validDate(value) { if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(value + 'T12:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function isTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function string(value, max) { return typeof value === 'string' && value.length <= max; }
export function validateData(input) {
  if (!input || input.schema !== 1 || !Array.isArray(input.bookings) || !Array.isArray(input.extras) || input.bookings.length > 50000 || input.extras.length > 50000) throw new Error('不是有效的兴文高铁站专线备份文件');
  const data = freshData();
  const ids = new Set();
  for (const collection of ['bookings', 'extras']) {
    for (const row of input[collection]) {
      if (!row || !string(row.id, 100) || !row.id || ids.has(row.id) || !isTimestamp(row.updatedAt)) throw new Error('记录编号或更新时间无效');
      ids.add(row.id);
      if (row.deleted === true) { data[collection].push({ id: row.id, deleted: true, updatedAt: row.updatedAt }); continue; }
      if (!validDate(row.date) || !HOURS.includes(row.hour) || !['outbound', 'return'].includes(row.direction) || !string(row.note, 300)) throw new Error('记录中的日期、班次或备注无效');
      const base = { id: row.id, date: row.date, hour: row.hour, direction: row.direction, note: row.note, updatedAt: row.updatedAt };
      if (collection === 'bookings') {
        if (!['大石', '马岭', '江门', '兴文高铁站'].includes(row.stop) || !string(row.pickup, 100) || !row.pickup.trim() || !string(row.phone, 25) || !/^[+\d ()-]{5,25}$/.test(row.phone) || !string(row.name, 30) || !Number.isInteger(row.passengers) || row.passengers < 1 || row.passengers > 99 || !Number.isSafeInteger(row.fare) || row.fare < 0 || row.fare > 9999900 || !['booked', 'boarded', 'cancelled'].includes(row.status) || typeof row.paid !== 'boolean') throw new Error('乘客信息或票价无效，请检查备份文件');
        data.bookings.push({ ...base, stop: row.stop, pickup: row.pickup, phone: row.phone, name: row.name, passengers: row.passengers, fare: row.fare, status: row.status, paid: row.paid });
      } else {
        if (!Number.isSafeInteger(row.amount) || row.amount < 1 || row.amount > 99999900) throw new Error('补记收入金额无效');
        data.extras.push({ ...base, amount: row.amount });
      }
    }
  }
  const settings = input.settings;
  if (!settings || typeof settings.returnEnabled !== 'boolean' || !isTimestamp(settings.updatedAt)) throw new Error('票价设置无效');
  for (const stop of Object.keys(DEFAULT_SETTINGS.fares)) if (!Number.isSafeInteger(settings.fares?.[stop]) || settings.fares[stop] < 0 || settings.fares[stop] > 9999900) throw new Error('默认票价无效');
  data.settings = { fares: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.fares).map(key => [key, settings.fares[key]])), returnEnabled: settings.returnEnabled, updatedAt: settings.updatedAt };
  return data;
}
export function mergeData(left, right) {
  const result = freshData();
  for (const key of ['bookings', 'extras']) {
    const rows = new Map(left[key].map(row => [row.id, row]));
    for (const row of right[key]) {
      const old = rows.get(row.id);
      if (!old || Date.parse(row.updatedAt) > Date.parse(old.updatedAt) || (row.updatedAt === old.updatedAt && JSON.stringify(row) > JSON.stringify(old))) rows.set(row.id, row);
    }
    result[key] = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  result.settings = Date.parse(right.settings.updatedAt) > Date.parse(left.settings.updatedAt) ? structuredClone(right.settings) : structuredClone(left.settings);
  return result;
}
export function live(rows) { return rows.filter(row => !row.deleted); }
export function summarize(data, date, hour, direction) {
  const matches = row => row.date === date && (!hour || row.hour === hour) && (!direction || row.direction === direction);
  const rows = live(data.bookings).filter(matches).filter(row => row.status !== 'cancelled');
  const extra = live(data.extras).filter(matches).reduce((sum, row) => sum + row.amount, 0);
  return { count: rows.length, passengers: rows.reduce((sum, row) => sum + row.passengers, 0), waiting: rows.filter(row => row.status === 'booked').reduce((sum, row) => sum + row.passengers, 0), expected: rows.reduce((sum, row) => sum + row.passengers * row.fare, 0), received: rows.filter(row => row.paid).reduce((sum, row) => sum + row.passengers * row.fare, 0) + extra, unpaid: rows.filter(row => !row.paid).reduce((sum, row) => sum + row.passengers * row.fare, 0), extra };
}
export function csvCell(value) { const text = String(value); return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; }
export function incomeCSV(data, date) {
  const rows = [['日期', '方向', '始发班次', '预约人数', '预约应收(元)', '预约未收(元)', '补记实收(元)', '总实收(元)']];
  for (const direction of ['outbound', 'return']) for (const hour of HOURS) { const s = summarize(data, date, hour, direction); rows.push([date, direction === 'outbound' ? '开往高铁站' : '返回大石', hour, s.passengers, (s.expected / 100).toFixed(2), (s.unpaid / 100).toFixed(2), (s.extra / 100).toFixed(2), (s.received / 100).toFixed(2)]); }
  const total = summarize(data, date); rows.push([date, '合计', '', total.passengers, (total.expected / 100).toFixed(2), (total.unpaid / 100).toFixed(2), (total.extra / 100).toFixed(2), (total.received / 100).toFixed(2)]);
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
