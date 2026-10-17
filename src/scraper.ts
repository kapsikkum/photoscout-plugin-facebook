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

/** Parses natural Facebook date strings into ISO 8601 */
export function parseFacebookDate(text?: string): { startTime: string; endTime?: string; dateOnly?: boolean } | null {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // Check if standard ISO date
  const isoCheck = new Date(raw);
  if (!Number.isNaN(isoCheck.getTime()) && raw.includes('-')) {
    return { startTime: isoCheck.toISOString(), dateOnly: raw.length <= 10 };
  }

  const now = new Date();
  const currentYear = now.getFullYear();

  // Examples:
  // "SATURDAY, 24 OCTOBER 2026 AT 10:00"
  // "SAT, 24 OCT AT 10:00"
  // "TOMORROW AT 19:30"
  // "TODAY AT 18:00"
  // "24 OCT AT 10:00 UTC+11"
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  const timeMatch = /\b(\d{1,2}):(\d{2})(?:\s*([ap]m))?\b/i.exec(raw);
  let hours = 10;
  let minutes = 0;
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  }

  if (/today\b/i.test(raw)) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    return { startTime: d.toISOString(), dateOnly: !timeMatch };
  }
  if (/tomorrow\b/i.test(raw)) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes);
    return { startTime: d.toISOString(), dateOnly: !timeMatch };
  }

  const dateMatch = /\b(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?\b/i.exec(raw) ||
                    /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i.exec(raw);

  if (dateMatch) {
    let day = 1;
    let monthName = '';
    let year = currentYear;

    if (/^\d+$/.test(dateMatch[1])) {
      day = parseInt(dateMatch[1], 10);
      monthName = dateMatch[2].toLowerCase();
      if (dateMatch[3]) year = parseInt(dateMatch[3], 10);
    } else {
      monthName = dateMatch[1].toLowerCase();
      day = parseInt(dateMatch[2], 10);
      if (dateMatch[3]) year = parseInt(dateMatch[3], 10);
    }

    const monthIndex = months[monthName];
    if (monthIndex !== undefined) {
      const d = new Date(Date.UTC(year, monthIndex, day, hours, minutes));
      // If month has passed and year wasn't specified, assume next year
      if (!dateMatch[3] && d.getTime() < now.getTime() - 86400000 * 7) {
        d.setUTCFullYear(year + 1);
      }
      return { startTime: d.toISOString(), dateOnly: !timeMatch };
    }
  }

  // Fallback to now + 7 days
  const fallback = new Date(now.getTime() + 7 * 86400000);
  return { startTime: fallback.toISOString(), dateOnly: true };
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
          let title = (a.innerText || '').trim();
          let dateText = '';
          let locationText = '';
          let imageUrl = '';

          if (card) {
            const spans = Array.from(card.querySelectorAll('span')).map(s => (s.innerText || '').trim()).filter(Boolean);
            if (!title && spans.length > 0) title = spans[0];
            for (const s of spans) {
              if (/(?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s) && /\\d/.test(s)) {
                if (!dateText) dateText = s;
              } else if (!locationText && s !== title && s.length > 2 && s.length < 50) {
                locationText = s;
              }
            }
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

        return { id, title, description, imageUrl, jsonLd };
      })()
    `);

    if (!data || !data.title) return null;

    const when = parseFacebookDate(data.dateText);
    return {
      sourceId: data.id || eventUrl,
      title: data.title,
      description: data.description,
      startTime: when?.startTime ?? new Date(Date.now() + 86400000 * 7).toISOString(),
      endTime: when?.endTime,
      dateOnly: when?.dateOnly ?? false,
      venueName: data.venueName,
      address: data.address,
      url: eventUrl,
      imageUrl: data.imageUrl,
      category: 'Community',
    };
  } finally {
    await page.close();
  }
}
