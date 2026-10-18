export function emptyPending() { return { bookings: {}, extras: {}, settings: '' }; }
export function allPending(data) { const pending = emptyPending(); for (const key of ['bookings', 'extras']) for (const row of data[key]) pending[key][row.id] = row.updatedAt; pending.settings = data.settings.updatedAt; return pending; }
export function markPending(pending, before, after) {
  const next = structuredClone(pending);
  for (const key of ['bookings', 'extras']) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    for (const row of after[key]) if (previous.get(row.id) !== JSON.stringify(row)) next[key][row.id] = row.updatedAt;
  }
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) next.settings = after.settings.updatedAt;
  return next;
}
export function acknowledgePending(pending, batch) {
  const next = structuredClone(pending);
  for (const key of ['bookings', 'extras']) for (const [id, revision] of Object.entries(batch[key] || {})) if (next[key][id] === revision) delete next[key][id];
  if (next.settings === batch.settings) next.settings = '';
  return next;
}
// A fixed deadline from the first pending change. Subsequent edits cannot
// postpone it indefinitely. The caller persists the deadline with the records.
export function createUploadScheduler(run, clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }) {
  let timer, scheduledAt;
  return {
    schedule(due) {
      if (timer !== undefined && scheduledAt === due) return;
      if (timer !== undefined) clock.clearTimeout(timer);
      scheduledAt = due;
      timer = clock.setTimeout(() => { timer = undefined; scheduledAt = undefined; run(); }, Math.max(0, due - clock.now()));
    },
    clear() { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; scheduledAt = undefined; }
  };
}
