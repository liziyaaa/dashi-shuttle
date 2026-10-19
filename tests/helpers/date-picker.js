import { expect } from '@playwright/test';

// WebKit commits its native date editor when it loses focus. Finish that step
// before clicking a control whose DOM may be replaced by the date change.
export async function chooseDate(page, value) {
  const field = page.locator('#selected-date');
  await field.fill(value);
  await field.press('Tab');
  await expect(field).toHaveValue(value);
}
