import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, parseFacebookDate } from '../src/scraper.js';

// 19 Oct 2026, 15:00 Sydney (AEDT, UTC+11), a Monday.
const now = new Date('2026-10-19T04:00:00Z');
const sydney = { now, timeZone: 'Australia/Sydney' };

test('parseCookies parses string of cookies into CDP cookie params', () => {
  const raw = 'c_user=1000123456789; xs=2%3Aabc123%3A2%3A12345; datr=abc_def_ghi;';
  const cookies = parseCookies(raw);
  assert.equal(cookies.length, 3);
  assert.equal(cookies[0].name, 'c_user');
  assert.equal(cookies[0].value, '1000123456789');
  assert.equal(cookies[0].domain, '.facebook.com');
  assert.equal(cookies[1].name, 'xs');
  assert.equal(cookies[1].value, '2%3Aabc123%3A2%3A12345');
  assert.equal(cookies[2].name, 'datr');
});

test('parseFacebookDate interprets wall-clock times in the account time zone, not UTC', () => {
  // The bug seen in the app: "Sat, 7 Nov at 09:00" was stored as 09:00 UTC (8:00 pm Sydney).
  const sat = parseFacebookDate('Sat, 7 Nov at 09:00', sydney);
  assert.equal(sat?.startTime, '2026-11-06T22:00:00.000Z');
  assert.equal(sat?.dateOnly, false);

  const tue = parseFacebookDate('Tue, 3 Nov at 12:30', sydney);
  assert.equal(tue?.startTime, '2026-11-03T01:30:00.000Z');

  const pm = parseFacebookDate('24 Oct at 10:00 PM', sydney);
  assert.equal(pm?.startTime, '2026-10-24T11:00:00.000Z');
});

test('parseFacebookDate handles today, tomorrow and relative weekdays', () => {
  assert.equal(parseFacebookDate('TOMORROW AT 19:30', sydney)?.startTime, '2026-10-20T08:30:00.000Z');
  assert.equal(parseFacebookDate('TODAY AT 18:00', sydney)?.startTime, '2026-10-19T07:00:00.000Z');
  assert.equal(parseFacebookDate('This Friday at 19:30', sydney)?.startTime, '2026-10-23T08:30:00.000Z');
  assert.equal(parseFacebookDate('This Sunday at 09:00', sydney)?.startTime, '2026-10-24T22:00:00.000Z');
  assert.equal(parseFacebookDate('Next Monday at 09:00', sydney)?.startTime, '2026-10-25T22:00:00.000Z');
});

test('parseFacebookDate reads ranges, explicit offsets, years and rollover', () => {
  const range = parseFacebookDate('Thu, 5 Nov-7 Nov', sydney);
  assert.equal(range?.dateOnly, true);
  assert.equal(range?.startTime, '2026-11-04T13:00:00.000Z');
  assert.equal(range?.endTime, '2026-11-06T13:00:00.000Z');

  assert.equal(parseFacebookDate('SATURDAY, 24 OCTOBER 2026 AT 10:00 UTC+10', sydney)?.startTime, '2026-10-24T00:00:00.000Z');
  assert.equal(parseFacebookDate('Jan 5 at 10:00', sydney)?.startTime, '2027-01-04T23:00:00.000Z');
  assert.equal(parseFacebookDate('2026-11-15T09:00:00Z')?.startTime, '2026-11-15T09:00:00.000Z');
});

test('parseFacebookDate treats Happening now as the current moment', () => {
  assert.equal(parseFacebookDate('Happening now', sydney)?.startTime, now.toISOString());
});

test('parseFacebookDate returns null instead of inventing a date', () => {
  assert.equal(parseFacebookDate('', sydney), null);
  assert.equal(parseFacebookDate('Creedence Clearwater Experience', sydney), null);
});

test('extractCardsInBrowser correctly separates date, title, and venue', async () => {
  const { extractCardsInBrowser } = await import('../src/scraper.js');
  const fakeDoc = {
    querySelectorAll: (sel: string) => {
      if (sel.includes('a[')) {
        return [
          {
            getAttribute: (attr: string) => (attr === 'href' ? '/events/1037295122211380/' : null),
            innerText: 'Sat, 7 Nov at 09:00\nBX THRIFT MARKETS\nBathurst Showground\nInterested\nShare',
            closest: () => ({
              querySelectorAll: () => [
                { children: [], innerText: 'Sat, 7 Nov at 09:00' },
                { children: [], innerText: 'BX THRIFT MARKETS' },
                { children: [], innerText: 'Bathurst Showground' },
              ],
              querySelector: () => null,
            }),
            parentElement: null,
          },
        ];
      }
      return [];
    },
  };
  (globalThis as unknown as { document: unknown }).document = fakeDoc;
  try {
    const cards = extractCardsInBrowser();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].sourceId, '1037295122211380');
    assert.equal(cards[0].title, 'BX THRIFT MARKETS');
    assert.equal(cards[0].dateText, 'Sat, 7 Nov at 09:00');
    assert.equal(cards[0].locationText, 'Bathurst Showground');
  } finally {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});
