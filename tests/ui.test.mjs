import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetGeometry, scrollDelta, displayDate, departurePassed } from '../ui.js';

test('sheet stays inside the visible viewport across keyboard opening, panning and dismissal', () => {
  for (const layout of [568, 844, 932]) {
    for (const height of [layout, 420, 300, 220]) {
      for (const offset of [0, 80, 180]) {
        const sheet = sheetGeometry(height, offset, layout);
        assert.ok(sheet.top >= offset);
        assert.ok(sheet.top + sheet.height <= offset + height);
        assert.equal(sheet.keyboard, layout - height > 120);
      }
    }
  }
});
test('focused note is fully revealed inside the scrolling body without moving the page', () => {
  const body = { top: 100, bottom: 320 };
  for (const top of [500, 320, 250, 150, 20]) {
    const field = { top, bottom: top + 76, height: 76 };
    const delta = scrollDelta(field, body);
    assert.ok(field.top - delta >= body.top + 12);
    assert.ok(field.bottom - delta <= body.bottom - 12);
  }
  assert.equal(scrollDelta({ top: 130, bottom: 206, height: 76 }, body), 0);
  // A very short landscape viewport aligns the start rather than oscillating.
  assert.equal(scrollDelta({ top: 140, bottom: 216, height: 76 }, { top: 100, bottom: 160 }), 28);
});
test('dates have a stable display independent of iOS system language', () => {
  assert.equal(displayDate('2026-10-18'), '2026年10月18日');
  assert.equal(displayDate('2026-01-02', true), '2026/01/02');
  assert.equal(displayDate(''), '选择日期');
});

test('departure styling uses local dates, hours and the exact departure boundary', () => {
  const now = new Date(2026, 9, 18, 15, 30, 0);
  assert.equal(departurePassed('2026-10-18', '15:00', now), true);
  assert.equal(departurePassed('2026-10-18', '16:00', now), false);
  assert.equal(departurePassed('2026-10-17', '21:00', now), true);
  assert.equal(departurePassed('2026-10-19', '07:00', now), false);
  assert.equal(departurePassed('2026-10-18', '15:00', new Date(2026, 9, 18, 15, 0, 0)), false);
  assert.equal(departurePassed('2026-10-18', '15:00', new Date(2026, 9, 18, 15, 0, 1)), true);
});
