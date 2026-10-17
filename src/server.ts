import { Browser } from './cdp.js';
import { scrapeFacebookEvents, scrapeSingleEvent } from './scraper.js';
import type { PluginContext, ServerPlugin } from './sdk/server-api.js';

interface PluginSettings {
  browserUrl?: string;
  cookie?: string;
  exploreSection?: 'events' | 'explore' | 'search';
  scrollSteps?: number;
}

const plugin: ServerPlugin = {
  activate(ctx: PluginContext) {
    const getConf = (): PluginSettings => ctx.settings.get() as PluginSettings;

    // 1. Register Scheduled Event Provider (Settings -> Events -> Sources)
    ctx.events.registerSource({
      id: 'facebook-stealth',
      label: 'Facebook (Stealth Browser)',
      description: 'Visits Facebook /events with a stealth headless browser using session cookies to discover local events.',
      unofficial: true,
      async fetch(area) {
        const conf = getConf();
        const browserUrl = conf.browserUrl || 'http://127.0.0.1:9222';
        const cookie = conf.cookie;

        if (!cookie) {
          return { missingConfig: 'Set Facebook Cookie in Settings -> Plugins -> Facebook Events' };
        }

        ctx.log.info(`Scraping Facebook events for ${area.city} via stealth browser at ${browserUrl}`);
        const events = await scrapeFacebookEvents({
          browserUrl,
          cookie,
          section: conf.exploreSection || 'events',
          query: area.city,
          scrollSteps: conf.scrollSteps ?? 6,
        });

        ctx.log.info(`Discovered ${events.length} Facebook events for ${area.city}`);
        return events;
      },
    });

    // 2. Register Link Importer for "Add from a link" on Events page
    ctx.events.registerImporter({
      id: 'facebook-stealth-link',
      label: 'Facebook (Stealth Browser)',
      match(url: string) {
        return /facebook\.com\/events\/\d+/i.test(url);
      },
      async read(url: string) {
        const conf = getConf();
        const browserUrl = conf.browserUrl || 'http://127.0.0.1:9222';
        const ev = await scrapeSingleEvent(browserUrl, url, conf.cookie);
        return ev ? [ev] : null;
      },
    });

    // 3. API Routes for Status Check and On-Demand Ingestion
    ctx.router.get('/status', async (_req, res) => {
      const conf = getConf();
      const browserUrl = conf.browserUrl || 'http://127.0.0.1:9222';
      try {
        const browser = await Browser.connect(browserUrl);
        const ver = await browser.getVersion();
        res.json({
          ok: true,
          browserUrl,
          cookieSet: Boolean(conf.cookie),
          browser: ver.browser,
          userAgent: ver.userAgent,
        });
      } catch (err) {
        res.json({
          ok: false,
          browserUrl,
          cookieSet: Boolean(conf.cookie),
          error: (err as Error).message,
        });
      }
    });

    ctx.router.post('/scrape-now', async (req, res) => {
      if (!ctx.auth.requireAdmin(req, res)) return;
      const conf = getConf();
      const browserUrl = conf.browserUrl || 'http://127.0.0.1:9222';
      if (!conf.cookie) {
        return res.status(400).json({ error: 'Please set your Facebook Cookie in Settings -> Plugins first.' });
      }

      try {
        ctx.log.info(`Manual scrape initiated for ${conf.exploreSection || 'events'}`);
        const events = await scrapeFacebookEvents({
          browserUrl,
          cookie: conf.cookie,
          section: conf.exploreSection || 'events',
          scrollSteps: conf.scrollSteps ?? 6,
        });

        const stats = await ctx.events.ingest('facebook-stealth', events);
        res.json({
          ok: true,
          found: events.length,
          ingested: stats.kept,
          rejected: stats.rejected,
          outsideArea: stats.outsideArea,
          sample: events.slice(0, 3).map((e) => ({ title: e.title, startTime: e.startTime, venue: e.venueName })),
        });
      } catch (err) {
        ctx.log.error(`Manual scrape failed: ${(err as Error).message}`);
        res.status(500).json({ error: (err as Error).message });
      }
    });
  },
};

export default plugin;
