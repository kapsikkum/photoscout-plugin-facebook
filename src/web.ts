import type { PluginHost, WebPlugin } from './sdk/web-api.js';

interface StatusReply {
  ok: boolean;
  browserUrl?: string;
  cookieSet?: boolean;
  browser?: string;
  userAgent?: string;
  error?: string;
}

interface ScrapeReply {
  ok: boolean;
  found: number;
  ingested: number;
  rejected: number;
  outsideArea: number;
  sample?: { title: string; startTime: string; venue?: string }[];
  error?: string;
}

const plugin: WebPlugin = {
  activate(host: PluginHost) {
    host.settings.addTab({
      id: 'facebook-stealth',
      label: 'Facebook Stealth',
      group: 'Events',
      render: (el) => {
        el.replaceChildren();

        const wrap = document.createElement('div');
        wrap.className = 'form';
        wrap.style.maxWidth = '680px';

        const title = document.createElement('h2');
        title.textContent = 'Facebook Events (Stealth Browser)';

        const desc = document.createElement('p');
        desc.className = 'hint';
        desc.textContent =
          'Scrapes Facebook /events using a real Chromium browser via DevTools Protocol (CDP) with full stealth evasion and your session cookies.';

        const statusBox = document.createElement('div');
        statusBox.style.padding = '12px 16px';
        statusBox.style.marginBottom = '16px';
        statusBox.style.borderRadius = '6px';
        statusBox.style.background = 'var(--bg-elevated, #1a1d24)';
        statusBox.style.border = '1px solid var(--border, #2a2e39)';
        statusBox.textContent = 'Checking browser status…';

        const btnRow = document.createElement('div');
        btnRow.style.display = 'flex';
        btnRow.style.gap = '10px';
        btnRow.style.marginBottom = '16px';

        const checkBtn = document.createElement('button');
        checkBtn.textContent = 'Check Browser Connection';

        const scrapeBtn = document.createElement('button');
        scrapeBtn.className = 'primary';
        scrapeBtn.textContent = 'Scrape /events Now';

        const output = document.createElement('div');
        output.style.whiteSpace = 'pre-wrap';
        output.style.fontFamily = 'monospace';
        output.style.fontSize = '12px';
        output.style.color = 'var(--text-muted, #94a3b8)';

        const updateStatus = async () => {
          try {
            const data = await host.data.json<StatusReply>('/status');
            if (data.ok) {
              statusBox.style.borderColor = '#10b981';
              statusBox.innerHTML = `
                <div style="color: #10b981; font-weight: 600; margin-bottom: 4px;">● Connected to Chromium</div>
                <div><b>Browser:</b> ${data.browser || 'Chromium'}</div>
                <div><b>Endpoint:</b> <code>${data.browserUrl || ''}</code></div>
                <div><b>Cookie Status:</b> ${data.cookieSet ? '✓ Stored' : '⚠️ No cookie set (set under System → Plugins)'}</div>
              `;
            } else {
              statusBox.style.borderColor = '#ef4444';
              statusBox.innerHTML = `
                <div style="color: #ef4444; font-weight: 600; margin-bottom: 4px;">✕ Cannot connect to Chromium</div>
                <div><b>Endpoint:</b> <code>${data.browserUrl || ''}</code></div>
                <div style="color: #ef4444;">${data.error || 'Connection refused'}</div>
                <p class="hint" style="margin-top: 8px;">Ensure a Chromium instance is running with <code>--remote-debugging-port=9222</code> or start the docker container.</p>
              `;
            }
          } catch (err) {
            statusBox.style.borderColor = '#ef4444';
            statusBox.textContent = `Status check failed: ${(err as Error).message}`;
          }
        };

        checkBtn.addEventListener('click', () => {
          output.textContent = '';
          void updateStatus();
        });

        scrapeBtn.addEventListener('click', async () => {
          scrapeBtn.disabled = true;
          scrapeBtn.textContent = 'Scraping /events…';
          output.textContent = 'Connecting to stealth browser and navigating to /events…\n';
          try {
            const res = await host.data.fetch('/scrape-now', { method: 'POST' });
            const data = (await res.json()) as ScrapeReply;
            if (data.ok) {
              output.textContent += `✓ Success!\nFound: ${data.found} events\nIngested: ${data.ingested} events\nRejected (invalid dates): ${data.rejected}\nOutside active areas: ${data.outsideArea}\n`;
              if (data.sample && data.sample.length > 0) {
                output.textContent += `\nSample events:\n` + data.sample.map((s) => `• ${s.title} (${s.startTime})`).join('\n');
              }
              host.activity(`Facebook scrape: ingested ${data.ingested} events`, 'info');
            } else {
              output.textContent += `✕ Scrape failed: ${data.error || 'Unknown error'}\n`;
              host.activity(`Facebook scrape failed: ${data.error || 'error'}`, 'error');
            }
          } catch (err) {
            output.textContent += `✕ Network error: ${(err as Error).message}\n`;
          } finally {
            scrapeBtn.disabled = false;
            scrapeBtn.textContent = 'Scrape /events Now';
          }
        });

        btnRow.append(checkBtn, scrapeBtn);

        const instructions = document.createElement('div');
        instructions.style.marginTop = '24px';
        instructions.style.padding = '12px 16px';
        instructions.style.border = '1px dashed var(--border, #2a2e39)';
        instructions.style.borderRadius = '6px';
        instructions.innerHTML = `
          <h4 style="margin: 0 0 8px 0;">Chromium Sidecar Setup</h4>
          <p class="hint" style="margin: 0 0 6px 0;">To run the dedicated stealth Chromium container alongside PhotoScout:</p>
          <pre style="background: var(--bg-surface, #0f172a); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 0; font-size: 11px;">podman run -d --name chromium-stealth -p 9222:9222 --security-opt seccomp=unconfined docker.io/library/debian:bookworm-slim ...</pre>
          <p class="hint" style="margin: 6px 0 0 0;">See the plugin's <code>docker-compose.chromium.yml</code> for the full compose definition.</p>
        `;

        wrap.append(title, desc, statusBox, btnRow, output, instructions);
        el.append(wrap);

        void updateStatus();
      },
    });
  },
};

export default plugin;
