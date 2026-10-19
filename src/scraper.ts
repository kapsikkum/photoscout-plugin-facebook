import { Browser, CookieParam, Page } from './cdp.js';
import type { PluginRawEvent } from './sdk/server-api.js';

export interface ScrapeOptions {
  browserUrl: string;
  cookie?: string;
  section?: 'events' | 'explore' | 'search';
  query?: string;
  scrollSteps?: number;
}

export function parseCookies(raw?: string): CookieParam[] {
  if (!raw || typeof raw !== 'string') return [];
  const list: CookieParam[] = [];
  const parts = raw.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name && value) {
      list.push({
        name,
        value,
        domain: '.facebook.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      });
    }
  }
  return list;
}

/** Facebook shows event times in the viewing account's zone; override with the PHOTOSCOUT_FB_TIMEZONE env var. */
export const DEFAULT_TIME_ZONE = process.env.PHOTOSCOUT_FB_TIMEZONE || 'Australia/Sydney';

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, sept: 8, september: 8, october: 9, november: 10, december: 11,
};
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** Converts a wall-clock time in `timeZone` (or a fixed UTC offset in minutes) to a UTC instant. */
function wallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string, fixedOffsetMin?: number): Date {
  const asUtc = Date.UTC(y, mo, d, h, mi);
  if (fixedOffsetMin !== undefined) return new Date(asUtc - fixedOffsetMin * 60000);
  let guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  guess = asUtc - zoneOffsetMs(guess, timeZone); // second pass settles DST edges
  return new Date(guess);
}

/** Calendar date "today" as seen in `timeZone`. */
function zonedToday(now: Date, timeZone: string): { y: number; m: number; d: number } {
  const local = new Date(now.getTime() + zoneOffsetMs(now.getTime(), timeZone));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
}

export interface ParseDateOptions { now?: Date; timeZone?: string }

/**
 * Parses natural Facebook date strings into ISO 8601. Times are interpreted in the
 * account's time zone (or an explicit "UTC+11" suffix), never as UTC.
 * Returns null when no date can be recognised, rather than inventing one.
 *
 * Handled: "SAT, 24 OCT AT 10:00", "Tue, 3 Nov at 12:30", "TODAY/TOMORROW AT 19:30",
 * "This Friday at 19:30", "Next Sunday", ranges like "Thu, 5 Nov-7 Nov", ISO strings.
 */
export function parseFacebookDate(text?: string, options: ParseDateOptions = {}): { startTime: string; endTime?: string; dateOnly?: boolean } | null {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const iso = new Date(raw);
    if (!Number.isNaN(iso.getTime())) return { startTime: iso.toISOString(), dateOnly: raw.length <= 10 };
  }

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const today = zonedToday(now, timeZone);

  const offsetMatch = /UTC\s*([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(raw);
  const fixedOffsetMin = offsetMatch
    ? (offsetMatch[1] === '-' ? -1 : 1) * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] ?? '0', 10))
    : undefined;

  const timeMatch = /\b(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i.exec(raw);
  let hours = 0;
  let minutes = 0;
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  }
  const make = (y: number, mo: number, d: number) => wallClockToUtc(y, mo, d, hours, minutes, timeZone, fixedOffsetMin);
  const done = (start: Date, end?: Date) => ({ startTime: start.toISOString(), endTime: end?.toISOString(), dateOnly: !timeMatch });

  if (/\btoday\b/i.test(raw)) return done(make(today.y, today.m, today.d));
  if (/\btomorrow\b/i.test(raw)) return done(make(today.y, today.m, today.d + 1));

  const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}\\b(?:\\s+(\\d{4}))?`, 'i').exec(raw);
  const monthDay = new RegExp(`\\b${monthPattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i').exec(raw);
  const match = dayMonth ?? monthDay;
  if (match) {
    const day = parseInt(dayMonth ? match[1] : match[2], 10);
    const monthIndex = MONTHS[(dayMonth ? match[2] : match[1]).toLowerCase()];
    const explicitYear = match[3] ? parseInt(match[3], 10) : undefined;
    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      let year = explicitYear ?? today.y;
      let start = make(year, monthIndex, day);
      // No year given and the date is well in the past: it means next year.
      if (explicitYear === undefined && start.getTime() < now.getTime() - 7 * 86400000) {
        year += 1;
        start = make(year, monthIndex, day);
      }
      // A range such as "Thu, 5 Nov-7 Nov" ends on its second date.
      let end: Date | undefined;
      const afterStart = raw.slice(match.index + match[0].length).replace(/^\s+at\s+\d{1,2}:\d{2}(?:\s*[ap]m)?/i, '');
      const range = new RegExp(`^\\s*[-–—]\\s*(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}|${monthPattern}\\s+(\\d{1,2}))`, 'i').exec(afterStart);
      if (range) {
        const endDay = parseInt(range[1] ?? range[4], 10);
        const endMonth = MONTHS[(range[2] ?? range[3]).toLowerCase()];
        if (endMonth !== undefined) end = make(year + (endMonth < monthIndex ? 1 : 0), endMonth, endDay);
      }
      return done(start, end);
    }
  }

  // "This Friday", "Next Sunday", or a bare weekday: the next occurrence on or after today.
  const weekday = /\b(?:(this|next)\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(raw);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2].toLowerCase());
    const todayIdx = new Date(Date.UTC(today.y, today.m, today.d)).getUTCDay();
    let delta = (target - todayIdx + 7) % 7;
    if (weekday[1]?.toLowerCase() === 'next' && delta === 0) delta = 7;
    return done(make(today.y, today.m, today.d + delta));
  }

  return null;
}

export async function scrapeFacebookEvents(opts: ScrapeOptions): Promise<PluginRawEvent[]> {
  const browser = await Browser.connect(opts.browserUrl);
  const page = await browser.newPage();

  try {
    const cookies = parseCookies(opts.cookie);
    if (cookies.length > 0) {
      await page.setCookies(cookies);
    }

    let targetUrl = 'https://www.facebook.com/events/';
    if (opts.section === 'explore') {
      targetUrl = 'https://www.facebook.com/events/explore/';
    } else if (opts.section === 'search' && opts.query) {
      targetUrl = `https://www.facebook.com/events/search/?q=${encodeURIComponent(opts.query)}`;
    }

    await page.goto(targetUrl, { waitMs: 4000 });

    // Check for login wall / checkpoint
    const checkpoint = await page.evaluate<string>(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        if (/You must log in to continue|Log in to Facebook|name="checkpoint"/i.test(text.slice(0, 4000))) {
          return 'login_required';
        }
        return '';
      })()
    `);

    if (checkpoint === 'login_required') {
      throw new Error('Facebook served a login wall. Please update the Facebook Cookie in Settings -> Plugins.');
    }

    // Scroll down to load event cards
    const scrollSteps = Math.max(1, Math.min(20, opts.scrollSteps ?? 6));
    await page.scrollFeed(scrollSteps, 1200);

    // Extract events from page DOM
    const rawEvents = await page.evaluate<
      {
        sourceId: string;
        title: string;
        dateText?: string;
        locationText?: string;
        imageUrl?: string;
        url: string;
      }[]
    >(`
      (() => {
        const out = [];
        const seen = new Set();

        // 1. Check all event links
        const anchors = Array.from(document.querySelectorAll('a[href*="/events/"]'));
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\\/events\\/(\\d{8,})/);
          if (!m) continue;
          const id = m[1];
          if (seen.has(id)) continue;
          seen.add(id);

          const fullUrl = 'https://www.facebook.com/events/' + id + '/';

          // Traverse upwards to card container
          let card = a.closest('div[role="article"]') || a.closest('div[data-visualcompletion]') || a.parentElement;
          let dateText = '';
          let locationText = '';
          let imageUrl = '';

          // An event card's link often wraps the date line ("Sat, 7 Nov at 09:00"), not the
          // title, so classify every piece of text rather than trusting the first one.
          const dayWord = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
          const monthWord = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
          const dateLike = new RegExp('^(?:(?:this|next)\\s+)?(?:' + dayWord + '|today|tomorrow)\\b.*(?:\\d|' + monthWord + ')|^\\d{1,2}\\s+' + monthWord + '\\b|^' + monthWord + '\\s+\\d{1,2}\\b|^(?:today|tomorrow)\\b', 'i');
          const noise = /^(?:going|interested|share|invite|maybe|event|events|see more|more|·|\\d+ (?:going|interested)|starts in .*|.* (?:going|interested))$/i;
          const texts = [];
          const push = (t) => { t = (t || '').replace(/\\s+/g, ' ').trim(); if (t && !texts.includes(t)) texts.push(t); };
          for (const line of (a.innerText || '').split('\\n')) push(line);
          push(a.getAttribute('aria-label'));
          if (card) {
            for (const s of card.querySelectorAll('span, [dir="auto"]')) {
              if (s.children.length === 0) push(s.innerText);
            }
          }
          const dateIdx = texts.findIndex((t) => t.length < 60 && dateLike.test(t));
          if (dateIdx !== -1) dateText = texts[dateIdx];
          const rest = texts.filter((t, i) => i !== dateIdx && !dateLike.test(t) && !noise.test(t) && t.length > 2);
          const imgAlt = card && card.querySelector('img[alt]') ? (card.querySelector('img[alt]').getAttribute('alt') || '').trim() : '';
          let title = rest.find((t) => t.length >= 4) || (imgAlt.length >= 4 && !dateLike.test(imgAlt) ? imgAlt : '');
          locationText = rest.find((t) => t !== title && t.length < 80) || '';
          if (card) {
            const img = card.querySelector('img[src*="fbcdn"]');
            if (img) imageUrl = img.getAttribute('src') || '';
          }

          if (title && id) {
            out.push({
              sourceId: id,
              title: title.split('\\n')[0],
              dateText,
              locationText,
              imageUrl,
              url: fullUrl,
            });
          }
        }
        return out;
      })()
    `);

    const events: PluginRawEvent[] = [];
    for (const item of rawEvents) {
      const parsedWhen = parseFacebookDate(item.dateText);
      if (!parsedWhen) continue;

      events.push({
        sourceId: item.sourceId,
        title: item.title,
        startTime: parsedWhen.startTime,
        endTime: parsedWhen.endTime,
        dateOnly: parsedWhen.dateOnly,
        venueName: item.locationText || undefined,
        address: item.locationText || undefined,
        url: item.url,
        imageUrl: item.imageUrl || undefined,
        category: 'Community',
      });
    }

    return events;
  } finally {
    await page.close();
  }
}

export async function scrapeSingleEvent(browserUrl: string, eventUrl: string, cookie?: string): Promise<PluginRawEvent | null> {
  const browser = await Browser.connect(browserUrl);
  const page = await browser.newPage();

  try {
    const cookies = parseCookies(cookie);
    if (cookies.length > 0) {
      await page.setCookies(cookies);
    }

    await page.goto(eventUrl, { waitMs: 3000 });

    const data = await page.evaluate<{
      id: string;
      title: string;
      description?: string;
      dateText?: string;
      venueName?: string;
      address?: string;
      imageUrl?: string;
      jsonLd?: unknown;
    }>(`
      (() => {
        const idMatch = window.location.href.match(/\\/events\\/(\\d{8,})/);
        const id = idMatch ? idMatch[1] : '';
        const titleEl = document.querySelector('h1') || document.querySelector('span[dir="auto"]');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // Extract description
        let description = '';
        const descSection = Array.from(document.querySelectorAll('div[data-ad-preview="message"], div[dir="auto"]'))
          .find(el => el.innerText && el.innerText.length > 40);
        if (descSection) description = descSection.innerText.trim();

        // Check for JSON-LD schema.org/Event
        let jsonLd = null;
        for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          try {
            const parsed = JSON.parse(script.innerText);
            if (parsed && (parsed['@type'] === 'Event' || parsed['@type'] === 'SocialEvent')) {
              jsonLd = parsed;
              break;
            }
          } catch {}
        }

        const img = document.querySelector('img[src*="fbcdn"]');
        const imageUrl = img ? img.getAttribute('src') || '' : '';

        // The visible date line ("Saturday, 24 October 2026 at 10:00 UTC+11") when JSON-LD is absent.
        let dateText = '';
        const dateRe = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+|today|tomorrow|this\\s+\\w+|next\\s+\\w+)?.*\\d.*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow)|^(?:today|tomorrow)\\b/i;
        for (const el of Array.from(document.querySelectorAll('span, div[dir="auto"]'))) {
          if (el.children.length) continue;
          const t = (el.innerText || '').trim();
          if (t.length > 4 && t.length < 90 && /\\d/.test(t) && dateRe.test(t)) { dateText = t; break; }
        }

        return { id, title, description, imageUrl, jsonLd, dateText };
      })()
    `);

    if (!data) return null;
    const ld = (data.jsonLd ?? {}) as {
      name?: string; startDate?: string; endDate?: string;
      location?: { name?: string; address?: string | { streetAddress?: string; addressLocality?: string } };
    };
    const title = data.title || ld.name;
    if (!title) return null;

    const fromLd = ld.startDate ? parseFacebookDate(ld.startDate) : null;
    const when = fromLd ?? parseFacebookDate(data.dateText);
    if (!when) return null;
    const endFromLd = ld.endDate ? parseFacebookDate(ld.endDate)?.startTime : undefined;
    const ldAddress = typeof ld.location?.address === 'string'
      ? ld.location.address
      : [ld.location?.address?.streetAddress, ld.location?.address?.addressLocality].filter(Boolean).join(', ');
    return {
      sourceId: data.id || eventUrl,
      title,
      description: data.description,
      startTime: when.startTime,
      endTime: endFromLd ?? when.endTime,
      dateOnly: when.dateOnly ?? false,
      venueName: data.venueName ?? ld.location?.name,
      address: data.address ?? (ldAddress || undefined),
      url: eventUrl,
      imageUrl: data.imageUrl,
      category: 'Community',
    };
  } finally {
    await page.close();
  }
}
