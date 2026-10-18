// Geometry is relative to the visual viewport, which iOS pans as the keyboard opens.
export function sheetGeometry(height, offsetTop = 0, layoutHeight = height) {
  const usable = Math.max(0, height - 12);
  const sheetHeight = Math.min(840, usable);
  return { height: sheetHeight, top: Math.max(0, offsetTop) + (height - sheetHeight) / 2, keyboard: layoutHeight - height > 120 };
}
export function scrollDelta(field, body, padding = 12) {
  const top = body.top + padding;
  const bottom = body.bottom - padding;
  if (field.height > bottom - top || field.top < top) return field.top - top;
  if (field.bottom > bottom) return field.bottom - bottom;
  return 0;
}
export function displayDate(value, compact = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '选择日期';
  const [year, month, day] = value.split('-');
  return compact ? `${year}/${month}/${day}` : `${year}年${Number(month)}月${Number(day)}日`;
}
// Interpret departure times in the phone's local timezone, as the native date
// controls and the rest of the ledger do. Do not convert them through UTC.
export function departurePassed(date, hour, now = new Date()) {
  return new Date(`${date}T${hour}:00`).getTime() < now.getTime();
}
