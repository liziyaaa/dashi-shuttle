import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function fixture(t) {
  // DOM integration only: this intentionally does not pretend to emulate Safari layout.
  const window = new Window({ url: 'https://example.com/dashi-shuttle/', width: 390, height: 844 });
  t.after(() => window.happyDOM.close());
  const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  window.document.write(html);
  window.structuredClone = structuredClone;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async () => ({ ok: true, json: async () => ({ version: '1.2.0' }) });
  const viewport = new window.EventTarget(); viewport.height = 844; viewport.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { value: viewport });
  // Evaluate the real production modules in one DOM realm; no app logic is copied.
  const modules = await Promise.all(['core.js', 'sync.js', 'ui.js', 'updates.js', 'scheduler.js', 'app.js'].map(async path => (await readFile(new URL('../' + path, import.meta.url), 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')));
  window.eval(modules.join('\n'));
  const document = window.document;
  const get = selector => document.querySelector(selector);
  const set = (name, value) => { const field = get(`#booking-form [name="${name}"]`); field.value = value; field.dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { window, document, viewport, get, set };
}
test('repeated booking notes survive keyboard resize, save, reopen, edit and persistence', async t => {
  const f = await fixture(t); const { get, set, window, viewport } = f;
  assert.equal(get('.home-date .date-display').textContent, get('#selected-date').value.replaceAll('-', '/'));
  for (let i = 0; i < 8; i++) {
    get('[data-action="add"]').click();
    assert.ok(get('#booking-dialog').open);
    set('pickup', `测试上车点 ${i}`); set('phone', `1380000000${i}`); set('passengers', '2');
    const note = get('[name="note"]'); note.focus();
    get('.sheet-body').getBoundingClientRect = () => ({ top: 100, bottom: 320 });
    note.getBoundingClientRect = () => ({ top: 350 - get('.sheet-body').scrollTop, bottom: 426 - get('.sheet-body').scrollTop, height: 76 });
    viewport.height = 420; viewport.offsetTop = i % 2 ? 80 : 0; viewport.dispatchEvent(new window.Event('resize'));
    set('note', `行李两件\n请到门口接人，第 ${i + 1} 笔🚄`);
    await pause();
    assert.ok(get('#booking-dialog').classList.contains('keyboard-open'));
    assert.equal(get('#keyboard-done').hidden, false);
    assert.ok(get('.sheet-body').scrollTop > 0);
    assert.equal(window.document.activeElement, note);
    get('#keyboard-done').click(); assert.notEqual(window.document.activeElement, note);
    viewport.height = 844; viewport.offsetTop = 0; viewport.dispatchEvent(new window.Event('resize'));
    get('#booking-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(get('#booking-dialog').open, false, get('#booking-error').textContent);
    await pause();
    assert.equal(window.document.body.classList.contains('booking-open'), false);
  }
  const saved = JSON.parse(window.localStorage.getItem('dashi-shuttle:v1'));
  assert.equal(saved.bookings.length, 8);
  for (let i = 0; i < 8; i++) assert.equal(saved.bookings.find(row => row.pickup === `测试上车点 ${i}`).note, `行李两件\n请到门口接人，第 ${i + 1} 笔🚄`);
  get(`[data-edit="${saved.bookings[7].id}"]`).click();
  assert.equal(get('[name="note"]').value, saved.bookings[7].note);
  set('note', '编辑后的备注');
  get('#booking-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(JSON.parse(window.localStorage.getItem('dashi-shuttle:v1')).bookings.find(row => row.id === saved.bookings[7].id).note, '编辑后的备注');
  assert.equal(JSON.parse(window.localStorage.getItem('dashi-shuttle:v1')).bookings.length, 8);
});
test('date navigation handles year boundaries, leap days and form date selection', async t => {
  const { get, window } = await fixture(t);
  const select = value => { get('#selected-date').value = value; get('#selected-date').dispatchEvent(new window.Event('change', { bubbles: true })); };
  select('2026-12-31'); get('[data-action="next-date"]').click();
  assert.equal(get('#selected-date').value, '2027-01-01');
  get('[data-action="previous-date"]').click(); assert.equal(get('#selected-date').value, '2026-12-31');
  select('2028-02-28'); get('[data-action="next-date"]').click(); assert.equal(get('#selected-date').value, '2028-02-29');
  select('2020-01-01'); assert.equal(get('[data-action="previous-date"]').disabled, true);
  select('2100-12-31'); assert.equal(get('[data-action="next-date"]').disabled, true);
  select('2026-10-18'); select(''); assert.equal(get('#selected-date').value, '2026-10-18'); get('[data-action="add"]').click();
  assert.equal(get('.form-date .date-display').textContent, '2026年10月18日');
  const date = get('#booking-form [name="date"]'); date.value = '2026-10-19'; date.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(get('.form-date .date-display').textContent, '2026年10月19日');
});
test('closing a modified note requires discard confirmation and preserves saved bookings', async t => {
  const { get, set, window } = await fixture(t);
  get('[data-action="add"]').click(); set('note', '尚未保存的备注');
  get('[data-close="booking-dialog"]').click(); assert.ok(get('#confirm-dialog').open);
  get('#confirm-dialog [data-close]').click(); assert.ok(get('#booking-dialog').open);
  assert.equal(get('[name="note"]').value, '尚未保存的备注');
  get('[data-close="booking-dialog"]').click(); get('#confirm-action').click();
  await pause(); assert.equal(get('#booking-dialog').open, false);
  assert.equal(window.localStorage.getItem('dashi-shuttle:v1'), null);
});
