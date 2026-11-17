import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCalendar, renderPage } from '../src/render.ts';

function topbar(html) {
  const match = html.match(/<header class="topbar">[\s\S]*?<\/header>/);
  assert.ok(match, 'the page has no top bar');
  return match[0];
}

test('the top bar shows the calendar icon and no repeated count', () => {
  const html = renderPage({ bookmarks: [], total: 3, query: '' });
  const bar = topbar(html);

  // The Active/Archived switch already carries both counts; the bar must not
  // repeat one of them.
  assert.doesNotMatch(bar, /class="count"/);

  const icon = bar.match(/<a class="bar-icon"[^>]*>[\s\S]*?<\/a>/);
  assert.ok(icon, 'the top bar has no calendar icon');
  assert.match(icon[0], /aria-label="Open the save calendar"/);
  assert.match(icon[0], /<svg/);
  assert.match(icon[0], /href="\/calendar"/);
  // Calendar sits before Settings, so the bar reads brand · calendar · Settings.
  assert.ok(bar.indexOf('class="bar-icon"') < bar.indexOf('>Settings</a>'));
});

test('the calendar icon keeps the English calendar href', () => {
  const bar = topbar(renderPage({ bookmarks: [], total: 0, query: '', lang: 'en' }));
  assert.match(bar, /class="bar-icon" href="\/calendar\?lang=en"/);
});

test('the filter row no longer carries the calendar text link', () => {
  const html = renderPage({ bookmarks: [], total: 0, query: '' });

  assert.doesNotMatch(html, />Calendar<\/a>/);
  // The class stays in use: the settings and note pages still link as text.
  assert.match(html, /<a class="calendar-link" href="\/settings">Settings<\/a>/);
});

test('the calendar page keeps its own month count', () => {
  const html = renderCalendar({
    calendar: { month: '2026-11', days: [{ date: '2026-11-10', count: 3 }], total: 4 },
  });

  assert.match(topbar(html), /<span class="count">4 saved this month<\/span>/);
});
