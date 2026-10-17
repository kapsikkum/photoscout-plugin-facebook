// Vendored from @photoscout/plugin-sdk 2.0.0 (src/server.ts). Do not edit: re-copy with plugin.mjs sdk-check --write.
import type { Request, Response as ExpressResponse, Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The public plugin API. Self-contained on purpose: it is the canonical source,
 * in `@photoscout/plugin-sdk/server`, and imports nothing from the app's
 * internals (only the types of express and node:sqlite). The app re-exports it
 * from server/src/plugins/types.ts.
 */

/**
 * The host's plugin API version: the server contract (ServerPlugin, PluginContext) and the manifest
 * fields. A plugin states a semver range of it in `photoscout`, and manifest.ts checks that range
 * against this constant. It is independent of the browser API's WEB_API_VERSION (`@photoscout/plugin-sdk/web`),
 * which a bundle reads from `host.apiVersion`. See docs/plugins/web-api-design.md, "Versions".
 * 1.1.0 accepts a .mjs web bundle (1.0.0 accepted only .js).
 * 1.2.0 adds `ctx.areas()` and the `PluginArea` type (additive): a plugin that calls it says `"photoscout": "^1.2"`.
 * 1.3.0 adds `ctx.events` (custom event sources, link scrapers/importers, HTML extraction, on-demand ingestion, and event queries) and the `'events'` permission kind (additive): a plugin that uses it says `"photoscout": "^1.3"`.
 */
export const HOST_API_VERSION = '1.3.0';

export type PermissionKind = 'network' | 'secrets' | 'realtime' | 'llm' | 'tasks' | 'storage' | 'events';

export type SettingField =
  | { key: string; type: 'string' | 'secret' | 'url'; label: string; help?: string; default?: string; required?: boolean }
  | { key: string; type: 'number'; label: string; help?: string; default?: number; min?: number; max?: number; required?: boolean }
  | { key: string; type: 'boolean'; label: string; help?: string; default?: boolean; required?: boolean }
  | { key: string; type: 'select'; label: string; help?: string; default?: string; options: { value: string; label: string }[]; required?: boolean };

export interface ServiceSpec {
  name: string;
  image: string;
  port: number;
  health?: string;
  env?: Record<string, string>;
  volumes?: string[];
  devices?: { path: string; optional?: boolean }[];
  memory?: string;
  cpus?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  icon?: string;
  category: 'map' | 'feed' | 'events' | 'ai' | 'tools';
  photoscout: string;
  server?: string;
  web?: string;
  permissions?: { kind: PermissionKind; detail?: string }[];
  services?: ServiceSpec[];
  settings?: SettingField[];
  /**
   * Routes under /api/plugins/<id>/ that a visitor who has not signed in may GET or HEAD.
   * Paths are relative to the plugin, e.g. "/places" or "/stations/*" (a * matches any run
   * of characters, slashes included). Every other plugin route needs a signed-in session.
   */
  public?: string[];
}

export interface PluginTaskDef {
  id: string;
  name: string;
  description?: string;
  intervalMinutes: number | null;
  run(log: (msg: string) => void): Promise<{ ok: boolean; message: string }>;
}

/**
 * One of the instance's configured Areas, as a plugin sees it: where it is and how far it reaches.
 * The events and busy switches an Area also carries are not part of this.
 */
export interface PluginArea {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

/**
 * A raw event listing returned by a plugin's custom event source or link importer.
 * It goes through the same date validation, locality/region check, geocoding, classification,
 * photo scoring, model vetting/enrichment and deduplication as core sources.
 */
export interface PluginRawEvent {
  /** Unique identifier within this source (e.g. a listing ID or canonical URL). */
  sourceId: string;
  title: string;
  description?: string;
  /** ISO 8601 date or date-time (e.g. "2026-11-14T18:00:00Z" or "2026-11-14"). */
  startTime: string;
  endTime?: string;
  venueName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  url?: string;
  imageUrl?: string;
  category?: string;
  priceText?: string;
  isOnline?: boolean;
  /** True when the listing gave a calendar date with no clock time. */
  dateOnly?: boolean;
}

/**
 * One active event area passed to a plugin event source during an events refresh.
 */
export interface PluginEventLocation {
  /** Area name (e.g. "Bathurst", "Sydney"). */
  readonly city: string;
  readonly lat: number;
  readonly lng: number;
  readonly radiusKm: number;
  /** Search query budget allocated to this area for this refresh pass, when multiple areas are active. */
  readonly queryBudget?: number;
  /** Active topic keys for this area (e.g. ['motorsport', 'cars']), honouring any per-area override. */
  readonly topics: readonly string[];
  /** Expanded topic search terms for this area plus custom web search terms. */
  readonly terms: readonly string[];
}

/**
 * What a plugin event source returns for one area: either the listings it found, or
 * `{ missingConfig: '...' }` when a required API key/setting has not been set yet.
 */
export type PluginEventSourceResult =
  | readonly PluginRawEvent[]
  | { readonly missingConfig: string };

export interface PluginEventSourceDef {
  /** Unique within this plugin (lowercase letters, digits and hyphens). Registered as `plugin:<pluginId>:<id>`. */
  id: string;
  /** Display name shown under Settings -> Events -> Sources and in refresh progress logs. */
  label: string;
  /** Short explanation shown under Settings -> Events -> Sources. */
  description?: string;
  /** True for scrapers or unofficial feeds (shows the "unofficial" badge in Settings). */
  unofficial?: boolean;
  /**
   * True when this source is already scoped to the user's area (like an iCal feed pointed at a local club),
   * so listings without a street address or town are still kept rather than culled as unplaced.
   */
  areaScoped?: boolean;
  /** Called once per active event area during an events refresh. */
  fetch(area: PluginEventLocation): Promise<PluginEventSourceResult>;
}

/**
 * A custom single-page scraper for "Add from a link" on the Events page.
 */
export interface PluginEventImporterDef {
  /** Unique within this plugin (lowercase letters, digits and hyphens). */
  id: string;
  /** Display name credited when this importer reads a link (e.g. "Humanitix"). */
  label: string;
  /** Return true when this importer can handle `url`. */
  match(url: string): boolean;
  /**
   * Scrape event candidate(s) from `url`.
   * Return `null` or `[]` to fall back to PhotoScout's default HTML/model reader.
   */
  read(url: string): Promise<readonly PluginRawEvent[] | null>;
}

export interface PluginEventQuery {
  /** Filter to one town/place name, or several. */
  place?: string | readonly string[];
  /** Filter to one category, or several. */
  category?: string | readonly string[];
  /** Search substring in title, description or venue. */
  q?: string;
  /** ISO date/time lower bound (default: upcoming). */
  from?: string;
  /** ISO date/time upper bound. */
  to?: string;
  /** Max items to return (1..500, default 100). */
  limit?: number;
}

export interface PluginEventItem {
  readonly group: string;
  readonly title: string;
  readonly description: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly dateOnly: boolean;
  readonly venueName: string;
  readonly address: string;
  readonly locality: string;
  readonly place: string;
  readonly area: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly imageUrl: string;
  readonly category: string;
  readonly priceText: string;
  readonly isOnline: boolean;
  readonly photoScore: number;
  readonly sources: readonly { readonly source: string; readonly url: string }[];
}

export interface PluginEventsApi {
  /**
   * Register a custom event source / provider / scraper that runs on every events refresh
   * and appears with its own enable toggle and status line under Settings -> Events -> Sources.
   */
  registerSource(def: PluginEventSourceDef): void;
  /**
   * Register a custom link scraper for "Add from a link" on the Events page.
   * Checked before the generic HTML reader whenever `def.match(url)` returns true.
   */
  registerImporter(def: PluginEventImporterDef): void;
  /**
   * Push scraped or webhook-received events into a source registered by this plugin without
   * waiting for a full refresh. Validates dates and locations against the active event areas,
   * geocodes venues, deduplicates, updates source status, and bumps the events cache.
   */
  ingest(sourceId: string, events: readonly PluginRawEvent[]): Promise<{ kept: number; rejected: number; outsideArea: number }>;
  /**
   * Extract structured `schema.org/Event` (JSON-LD and microdata) and natural-language event
   * listings from raw HTML, using PhotoScout's own parser. Useful inside custom scrapers.
   */
  extractFromHtml(html: string, pageUrl: string): PluginRawEvent[];
  /**
   * Read upcoming curated events (culled and hidden events excluded, merged across sources).
   */
  list(query?: PluginEventQuery): readonly PluginEventItem[];
}

export interface PluginContext {
  manifest: PluginManifest;
  /** Mounted at /api/plugins/<id>/ */
  router: Router;
  auth: {
    requireUser(req: Request, res: ExpressResponse): boolean;
    requireAdmin(req: Request, res: ExpressResponse): boolean;
  };
  settings: {
    get(): Record<string, unknown>;
    onChange(fn: (s: Record<string, unknown>) => void): () => void;
  };
  tasks: { register(def: PluginTaskDef): void };
  /**
   * Public internet only: private and loopback addresses are refused, and every redirect hop is checked.
   * One exception, opt-in: a manifest `permissions` entry `{ kind: 'network', detail: '<host>' | '<host>:<port>' }`
   * lets this fetch reach that exact host even when it is private or loopback (a local model server, a sidecar).
   * The host must match exactly, and the port too when one is given; a redirect hop is allowed only if it is
   * public or another declared host. A "*.example.com" detail is informational and never opens anything.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The plugin's own SQLite file, data/plugins/<id>/data/plugin.db. Never the core database. */
  db: DatabaseSync;
  /** data/plugins/<id>/data/ */
  dataDir: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  services: { url(name: string): string | null };
  /**
   * The instance's configured Areas: the home area first, then the others in the order the admin set them.
   * Read-only, and current at call time: each call reads the settings again, so a poll sees the Areas as they
   * are now. The result is a fresh frozen copy, so a plugin cannot change the stored Areas through it.
   * If the Areas cannot be read, this returns [] rather than throwing.
   */
  areas(): readonly PluginArea[];
  /**
   * Custom event providers, scrapers, link importers, HTML extraction and event queries.
   */
  events: PluginEventsApi;
}

export interface ServerPlugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export function definePlugin(p: ServerPlugin): ServerPlugin {
  return p;
}

