import { lookup } from 'node:dns/promises';
import { STEALTH_SCRIPT, USER_AGENT, USER_AGENT_METADATA } from './stealth.js';

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class Page {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private events = new Map<string, ((params: unknown) => void)[]>();

  constructor(
    private ws: WebSocket,
    public readonly targetId: string,
    private closeTargetUrl: string | null = null,
  ) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.events.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }

  static async connect(wsUrl: string, targetId = '', closeTargetUrl: string | null = null): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket failed: ${String(err)}`));
      }, { once: true });
    });
    return new Page(ws, targetId, closeTargetUrl);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method: string, cb: (params: unknown) => void): void {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method)!.push(cb);
  }

  async setupStealth(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Network.enable');
    await this.send('Runtime.enable');

    // 1. Realistic user agent and client hints
    await this.send('Network.setUserAgentOverride', {
      userAgent: USER_AGENT,
      acceptLanguage: 'en-AU,en-US;q=0.9,en;q=0.8',
      platform: 'Windows',
      userAgentMetadata: USER_AGENT_METADATA,
    });

    // 2. Realistic desktop screen
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 3. Inject stealth evasion preamble before any page scripts
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: STEALTH_SCRIPT,
    });
  }

  async setCookies(cookies: CookieParam[]): Promise<void> {
    if (cookies.length === 0) return;
    const formatted = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? '.facebook.com',
      path: c.path ?? '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite ?? 'None',
    }));
    await this.send('Network.setCookies', { cookies: formatted });
  }

  async goto(url: string, { timeoutMs = 15000, waitMs = 3000 }: { timeoutMs?: number; waitMs?: number } = {}): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((resolve) => {
      const onDone = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.on('Page.loadEventFired', onDone);
      this.on('Page.domContentEventFired', () => {
        setTimeout(onDone, 1500);
      });
      timer = setTimeout(onDone, timeoutMs);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    if (waitMs > 0) await sleep(waitMs);
  }

  async evaluate<T = unknown>(fnOrExpression: string | (() => T)): Promise<T> {
    const expression = typeof fnOrExpression === 'function' ? `(${fnOrExpression.toString()})()` : fnOrExpression;
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };

    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'Runtime.evaluate failed');
    }
    return res.result?.value as T;
  }

  /** Scroll down incrementally with random jitter to trigger infinite scroll queries */
  async scrollFeed(steps = 5, stepDelayMs = 1200): Promise<void> {
    for (let i = 0; i < steps; i++) {
      const jitterDistance = 600 + Math.floor(Math.random() * 400);
      await this.evaluate(`window.scrollBy({ top: ${jitterDistance}, behavior: 'smooth' })`);
      await sleep(stepDelayMs + Math.floor(Math.random() * 300));
    }
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      // Ignore
    }
    if (this.closeTargetUrl) {
      try {
        await fetch(this.closeTargetUrl);
      } catch {
        // Target already closed
      }
    }
  }
}

export class Browser {
  constructor(public readonly base: string) {}

  static async connect(endpoint: string): Promise<Browser> {
    const parsed = new URL(endpoint);
    const port = Number(parsed.port || 9222);

    // Resolve DNS (including loopback/container aliases)
    const resolved = await lookup(parsed.hostname, { all: true }).catch(() => []);
    const candidates = resolved.length
      ? resolved.map((r) => (r.family === 6 ? `[${r.address}]` : r.address))
      : [parsed.hostname];

    let lastError: unknown;
    for (const host of candidates) {
      const base = `http://${host}:${port}`;
      try {
        const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          return new Browser(base);
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`Could not connect to Chromium CDP at ${endpoint}: ${(lastError as Error)?.message ?? 'Connection refused'}`);
  }

  async getVersion(): Promise<{ browser: string; protocolVersion: string; userAgent: string }> {
    const res = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.base}/json/version`);
    const data = (await res.json()) as { Browser?: string; 'Protocol-Version'?: string; 'User-Agent'?: string };
    return {
      browser: data.Browser ?? '',
      protocolVersion: data['Protocol-Version'] ?? '',
      userAgent: data['User-Agent'] ?? '',
    };
  }

  private socketUrl(wsDebuggerUrl: string): string {
    const target = new URL(this.base);
    const ws = new URL(wsDebuggerUrl);
    ws.host = target.host;
    return ws.toString();
  }

  async newPage(): Promise<Page> {
    const res = await fetch(`${this.base}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Failed to create new browser page (HTTP ${res.status})`);
    const info = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new Error('Chromium did not return a webSocketDebuggerUrl');

    const wsUrl = this.socketUrl(info.webSocketDebuggerUrl);
    const closeTargetUrl = info.id ? `${this.base}/json/close/${info.id}` : null;
    const page = await Page.connect(wsUrl, info.id ?? '', closeTargetUrl);
    await page.setupStealth();
    return page;
  }
}
