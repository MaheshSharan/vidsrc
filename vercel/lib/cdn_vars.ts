/**
 * Resolves {v1}..{v5} CDN hostname placeholders from the prorcp page.
 *
 * The prorcp page loads an obfuscated JS file (filename rotates per deploy)
 * via document.write. We fetch that JS and run it in Node's vm module with
 * a mocked browser environment, intercepting the Playerjs constructor to
 * capture the resolved CDN hostnames.
 *
 * Falls back to last-known-good values if extraction fails.
 */

import vm from "vm";
import https from "https";

// Last-known-good fallback - update when CDNs rotate
const FALLBACK: Record<string, string> = {
  v1: "neonhorizonworkshops.com",
  v2: "cloudnestra.com",
  v3: "neonhorizonworkshops.com",
  v4: "neonhorizonworkshops.com",
  v5: "cloudnestra.com",
};

function fetchRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Referer: "https://cloudnestra.com/",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      )
      .on("error", reject);
  });
}

async function extractFromJs(jsUrl: string): Promise<Record<string, string>> {
  const code = await fetchRaw(jsUrl);
  const captured: Record<string, string> = {};

  const mockWindow: Record<string, unknown> = {
    location: { href: "https://cloudnestra.com/prorcp/test", hostname: "cloudnestra.com" },
    navigator: {
      userAgent: "Mozilla/5.0",
      language: "en-US",
      plugins: { namedItem: () => true },
      cookieEnabled: true,
      hardwareConcurrency: 4,
      deviceMemory: 8,
      platform: "Win32",
      languages: ["en-US"],
    },
    document: {
      domain: "cloudnestra.com",
      cookie: "",
      referrer: "",
      title: "",
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, onerror: null, onload: null, data: "", appendChild: () => {} }),
      getElementById: () => null,
    },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    XMLHttpRequest: function () {
      return { open: () => {}, send: () => {}, setRequestHeader: () => {} };
    },
    // Intercept Playerjs - CDN hostnames come through here
    Playerjs: function (config: { file?: string }) {
      if (config?.file) {
        const matches = config.file.match(/https?:\/\/([^/]+)/g) ?? [];
        for (const m of matches) {
          const host = m.replace(/https?:\/\//, "");
          if (!Object.values(captured).includes(host)) {
            captured[`v${Object.keys(captured).length + 1}`] = host;
          }
        }
      }
    },
  };

  mockWindow.window = mockWindow;
  mockWindow.parent = mockWindow;
  mockWindow.top = mockWindow;
  mockWindow.self = mockWindow;
  mockWindow.frames = mockWindow;
  mockWindow.globalThis = mockWindow;

  const sandbox = vm.createContext(mockWindow);

  try {
    vm.runInContext(`try { ${code} } catch(e) {}`, sandbox, { timeout: 5000 });
  } catch {
    // ignore
  }

  return captured;
}

// Deduplicate in-flight fetches and cache results
const _cache = new Map<string, Record<string, string>>();
const _inflight = new Map<string, Promise<Record<string, string>>>();

export async function resolveCdnVars(
  prorcpHtml: string,
  prorcpHash: string
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  // Extract CDN vars JS filename from document.write in prorcp HTML
  const jsPath =
    prorcpHtml.match(/document\.write\([^)]*src='(\/[a-f0-9]+\.js\?[^']+)'/)?.[1] ??
    prorcpHtml.match(/src=["']\/(([a-f0-9]{32})\.js\?[^"']+)['"]/)?.[1];

  if (jsPath) {
    const jsUrl = `https://cloudnestra.com${jsPath}`;
    try {
      if (_cache.has(jsUrl)) {
        Object.assign(vars, _cache.get(jsUrl));
      } else {
        // Deduplicate concurrent fetches of the same JS file
        if (!_inflight.has(jsUrl)) {
          _inflight.set(jsUrl, extractFromJs(jsUrl).then((r) => {
            _cache.set(jsUrl, r);
            _inflight.delete(jsUrl);
            return r;
          }));
        }
        const extracted = await _inflight.get(jsUrl)!;
        Object.assign(vars, extracted);
      }
    } catch {
      // fall through to fallback
    }
  }

  // Fill any missing keys from fallback
  for (const [k, v] of Object.entries(FALLBACK)) {
    if (!(k in vars)) vars[k] = v;
  }

  return vars;
}
