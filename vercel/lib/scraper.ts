/**
 * VidSrc.to scraper - TypeScript port
 * Chain: vidsrc.to -> vsembed.ru -> cloudnestra rcp -> cloudnestra prorcp -> m3u8
 */

import { resolveCdnVars } from "./cdn_vars.js";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  DNT: "1",
};

async function get(url: string, referer?: string): Promise<string> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (referer) headers["Referer"] = referer;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extract(pattern: RegExp, text: string): string | null {
  return text.match(pattern)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Step 1: vidsrc.to -> vsembed.ru iframe src
// ---------------------------------------------------------------------------
async function getVsembedUrl(
  type: string,
  id: string,
  season?: number,
  episode?: number
): Promise<{ vsembedUrl: string; vidsrcUrl: string }> {
  const vidsrcUrl =
    type === "tv" && season && episode
      ? `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`
      : `https://vidsrc.to/embed/movie/${id}`;

  const html = await get(vidsrcUrl);

  let src =
    extract(/src=["']([^"']*vsembed\.ru[^"']*)['"]/i, html) ??
    extract(/src=["'](\/\/vsembed\.ru[^"']*)['"]/i, html);

  if (!src) throw new Error("vsembed iframe not found in vidsrc.to response");
  if (src.startsWith("//")) src = "https:" + src;

  return { vsembedUrl: src, vidsrcUrl };
}

// ---------------------------------------------------------------------------
// Step 2: vsembed.ru -> rcp hashes
// ---------------------------------------------------------------------------
async function getRcpHashes(
  vsembedUrl: string,
  referer: string
): Promise<string[]> {
  const html = await get(vsembedUrl, referer);
  const hashes = [...html.matchAll(/data-hash=["']([A-Za-z0-9+/=_\-]+)['"]/g)].map(
    (m) => m[1]
  );
  if (!hashes.length) throw new Error("No rcp hashes found in vsembed.ru");
  return hashes;
}

// ---------------------------------------------------------------------------
// Step 3: cloudnestra.com/rcp/{hash} -> prorcp hash
// ---------------------------------------------------------------------------
async function getProrcpHash(rcpHash: string, referer: string): Promise<string> {
  const url = `https://cloudnestra.com/rcp/${rcpHash}`;
  const html = await get(url, referer);

  const prorcp = extract(/['"]\/prorcp\/([A-Za-z0-9+/=_\-]+)['"]/i, html);
  if (!prorcp) throw new Error("prorcp hash not found in cloudnestra rcp response");
  return prorcp;
}

// ---------------------------------------------------------------------------
// Step 4: cloudnestra.com/prorcp/{hash} -> m3u8 URLs
// ---------------------------------------------------------------------------
async function getM3u8Urls(
  prorcpHash: string
): Promise<{ url: string; type: "hls" }[]> {
  const url = `https://cloudnestra.com/prorcp/${prorcpHash}`;
  const html = await get(url, `https://cloudnestra.com/rcp/${prorcpHash}`);

  // Parse file: "url1 or url2 or ..." from Playerjs init
  const fileMatch =
    extract(/file:\s*["']([^"']+\.m3u8[^"']*)['"]/i, html) ??
    extract(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i, html);

  if (!fileMatch) throw new Error("m3u8 URLs not found in prorcp response");

  const rawUrls = fileMatch.split(" or ").map((u) => u.trim());
  const cdnVars = await resolveCdnVars(html, prorcpHash);

  const seen = new Set<string>();
  const results: { url: string; type: "hls" }[] = [];

  for (const raw of rawUrls) {
    let resolved = raw;
    for (const [k, v] of Object.entries(cdnVars)) {
      resolved = resolved.split(`{${k}}`).join(v);
    }
    if (resolved.includes("{v") || seen.has(resolved)) continue;
    seen.add(resolved);
    results.push({ url: resolved, type: "hls" });
  }

  return results.length ? results : rawUrls.map((url) => ({ url, type: "hls" as const }));
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export interface ScrapeResult {
  media_type: string;
  media_id: string;
  season?: number;
  episode?: number;
  streams: { source_index: number; url: string; type: string }[];
  errors: { source_index: number; error: string }[];
}

export async function scrape(
  type: string,
  id: string,
  season?: number,
  episode?: number
): Promise<ScrapeResult> {
  const { vsembedUrl, vidsrcUrl } = await getVsembedUrl(type, id, season, episode);
  const hashes = await getRcpHashes(vsembedUrl, vidsrcUrl);

  const streams: ScrapeResult["streams"] = [];
  const errors: ScrapeResult["errors"] = [];

  // Process all sources concurrently
  await Promise.allSettled(
    hashes.map(async (hash, i) => {
      try {
        const prorcpHash = await getProrcpHash(hash, vsembedUrl);
        const m3u8List = await getM3u8Urls(prorcpHash);
        for (const entry of m3u8List) {
          streams.push({ source_index: i, ...entry });
        }
      } catch (e) {
        errors.push({ source_index: i, error: (e as Error).message });
      }
    })
  );

  return {
    media_type: type,
    media_id: id,
    season,
    episode,
    streams,
    errors,
  };
}
