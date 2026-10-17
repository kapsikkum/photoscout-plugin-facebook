/**
 * Stealth script and metadata for evading automated browser detection.
 *
 * Injected before any page scripts execute via Page.addScriptToEvaluateOnNewDocument.
 * Hides automation markers, patches WebGL fingerprints, fakes window.chrome,
 * fakes realistic plugins and languages, and overrides permission queries.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const USER_AGENT_METADATA = {
  brands: [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  fullVersion: '131.0.6778.86',
  platform: 'Windows',
  platformVersion: '15.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
};

export const STEALTH_SCRIPT = `
(() => {
  const hide = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch { /* already defined */ }
  };

  // 1. Remove navigator.webdriver
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch { /* ignore */ }
  hide(navigator, 'webdriver', undefined);

  // 2. Realistic WebGL vendor and renderer (discrete NVIDIA GPU under Windows ANGLE)
  const WEBGL_VENDOR = 'Google Inc. (NVIDIA)';
  const WEBGL_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const patchGl = (proto) => {
    if (!proto) return;
    const original = proto.getParameter;
    proto.getParameter = function (parameter) {
      if (parameter === 37445) return WEBGL_VENDOR;
      if (parameter === 37446) return WEBGL_RENDERER;
      return original.apply(this, arguments);
    };
  };
  patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // 3. Emulate window.chrome
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.csi) window.chrome.csi = () => ({});
  if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});

  // 4. Emulate notification permission query consistency
  try {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission || 'default', onchange: null })
        : originalQuery(params);
  } catch { /* ignore */ }

  // 5. Default Chrome plugins
  if (navigator.plugins && navigator.plugins.length === 0) {
    const names = [
      'PDF Viewer',
      'Chrome PDF Viewer',
      'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer',
      'WebKit built-in PDF',
    ];
    hide(navigator, 'plugins', names.map((name) => ({ name, filename: 'internal-pdf-viewer' })));
  }

  // 6. Languages and hardware concurrency
  if (navigator.languages && navigator.languages.length === 0) {
    hide(navigator, 'languages', ['en-AU', 'en-US', 'en']);
  }
  if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 4) {
    hide(navigator, 'hardwareConcurrency', 8);
  }
  if (!navigator.deviceMemory || navigator.deviceMemory < 4) {
    hide(navigator, 'deviceMemory', 8);
  }
})();
`;
