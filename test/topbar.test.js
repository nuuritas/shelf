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

test('the save pill is in the top bar and the clipboard note sits above the banners', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    notice: 'added',
    error: null,
  });
  const bar = topbar(html);

  const form = bar.match(/<form class="save-form"[\s\S]*?<\/form>/);
  assert.ok(form, 'the top bar has no save form');
  assert.match(form[0], /method="post"/);
  assert.match(form[0], /action="\/add"/);
  assert.match(form[0], /<input type="hidden" name="url" value="">/);
  assert.match(form[0], /class="save-to-shelf"[^>]*>Save to Shelf<\/button>/);
  // It reads pill · calendar · Settings · Log out.
  assert.ok(bar.indexOf('class="save-form"') < bar.indexOf('class="bar-icon"'));
  assert.ok(bar.indexOf('class="bar-icon"') < bar.indexOf('>Settings</a>'));

  // The note is the first thing under the top bar, above the notice banner.
  const main = html.indexOf('<main class="shell">');
  const note = html.indexOf('class="add-note"');
  const banner = html.indexOf('class="banner success"');
  assert.ok(main < note && note < banner, 'the note is not above the banners');
  assert.match(html, /class="add-note"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /Nothing to save yet — copy a link first, then tap again\./);
  // The disclosure row and its visible field are gone; one control is left.
  assert.doesNotMatch(html, /class="add-drawer"/);
  assert.doesNotMatch(html, /<input id="url"/);
});
