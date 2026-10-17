import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, parseFacebookDate } from '../src/scraper.js';

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

test('parseFacebookDate parses standard natural Facebook date representations', () => {
  const tomorrow = parseFacebookDate('TOMORROW AT 19:30');
  assert.ok(tomorrow);
  assert.match(tomorrow.startTime, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(tomorrow.dateOnly, false);

  const natural = parseFacebookDate('24 Oct at 10:00 AM');
  assert.ok(natural);
  assert.match(natural.startTime, /^\d{4}-10-24T/);
  assert.equal(natural.dateOnly, false);

  const iso = parseFacebookDate('2026-11-15T09:00:00Z');
  assert.ok(iso);
  assert.equal(iso.startTime, '2026-11-15T09:00:00.000Z');
});
