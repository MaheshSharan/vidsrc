"""
VidSrc.to Scraper - Request-based, no browser required
Extracts m3u8 stream URLs for movies and TV shows using TMDB/IMDB IDs.

Chain:
  vidsrc.to/embed/{type}/{id} 
    -> vsembed.ru/embed/{type}/{id}/  (extracts rcp hash)
    -> cloudnestra.com/rcp/{hash}     (extracts prorcp hash)
    -> cloudnestra.com/prorcp/{hash}  (extracts m3u8 URLs)
"""

import re
import sys
import time
import random
import requests
from urllib.parse import urljoin

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "DNT": "1",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get(url: str, referer: str = None, **kwargs) -> requests.Response:
    headers = {}
    if referer:
        headers["Referer"] = referer
    time.sleep(random.uniform(0.3, 0.8))  # polite delay
    resp = SESSION.get(url, headers=headers, timeout=15, **kwargs)
    resp.raise_for_status()
    return resp


def _extract(pattern: str, text: str, group: int = 1) -> str | None:
    m = re.search(pattern, text)
    return m.group(group) if m else None

# ---------------------------------------------------------------------------
# Step 1: vidsrc.to -> vsembed.ru iframe src
# ---------------------------------------------------------------------------

def get_vsembed_url(media_type: str, media_id: str, season: int = None, episode: int = None) -> str:
    """
    media_type: 'movie' or 'tv'
    media_id:   TMDB or IMDB id (e.g. 'tt9263550' or '12345')
    """
    if media_type == "tv" and season and episode:
        url = f"https://vidsrc.to/embed/tv/{media_id}/{season}/{episode}"
    else:
        url = f"https://vidsrc.to/embed/movie/{media_id}"

    resp = _get(url)
    html = resp.text

    # The page embeds vsembed.ru in an iframe
    src = _extract(r'src=["\']([^"\']*vsembed\.ru[^"\']*)["\']', html)
    if not src:
        # Try relative or protocol-relative
        src = _extract(r'src=["\']([^"\']*embed[^"\']*)["\']', html)
    if not src:
        raise ValueError(f"Could not find vsembed iframe in vidsrc.to response for {url}")

    if src.startswith("//"):
        src = "https:" + src
    return src, url


# ---------------------------------------------------------------------------
# Step 2: vsembed.ru -> cloudnestra rcp hash
# ---------------------------------------------------------------------------

def get_rcp_hash(vsembed_url: str, referer: str) -> str:
    resp = _get(vsembed_url, referer=referer)
    html = resp.text

    # data-hash attribute on source/server elements
    # <div class="source" data-hash="..."> or <div class="server" data-hash="...">
    hashes = re.findall(r'data-hash=["\']([A-Za-z0-9+/=_\-]+)["\']', html)
    if not hashes:
        raise ValueError("Could not find rcp hash in vsembed.ru response")

    # Return first (default/primary) source hash
    return hashes[0], hashes


# ---------------------------------------------------------------------------
# Step 3: cloudnestra.com/rcp/{hash} -> prorcp hash
# ---------------------------------------------------------------------------

def get_prorcp_hash(rcp_hash: str, referer: str) -> str:
    url = f"https://cloudnestra.com/rcp/{rcp_hash}"
    resp = _get(url, referer=referer)
    html = resp.text

    # The page has: src: '/prorcp/{hash}' inside loadIframe()
    prorcp = _extract(r"['\"]\/prorcp\/([A-Za-z0-9+/=_\-]+)['\"]", html)
    if not prorcp:
        raise ValueError(f"Could not find prorcp hash in cloudnestra rcp response")
    return prorcp


# ---------------------------------------------------------------------------
# Step 4: cloudnestra.com/prorcp/{hash} -> m3u8 URLs
# ---------------------------------------------------------------------------

def get_m3u8_urls(prorcp_hash: str, referer: str) -> list[dict]:
    url = f"https://cloudnestra.com/prorcp/{prorcp_hash}"
    resp = _get(url, referer=f"https://cloudnestra.com/rcp/{prorcp_hash}")
    html = resp.text

    # The player is initialized with a 'file' param containing m3u8 URLs
    # Format: "file: "url1 or url2 or url3 ..."
    file_match = _extract(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html)
    if not file_match:
        # Try alternate pattern
        file_match = _extract(r'"file"\s*:\s*"([^"]+\.m3u8[^"]*)"', html)

    if not file_match:
        raise ValueError("Could not find m3u8 file URLs in prorcp response")

    # Split on ' or ' to get individual URLs, resolve {v1}/{v2} etc.
    raw_urls = [u.strip() for u in file_match.split(" or ")]

    # Resolve CDN domain variables {v1}..{v5}
    cdn_vars = _resolve_cdn_vars(html, prorcp_hash)

    results = []
    seen = set()
    for raw in raw_urls:
        resolved = raw
        for k, v in cdn_vars.items():
            resolved = resolved.replace("{" + k + "}", v)

        # Skip if still has unresolved placeholders
        if "{v" in resolved:
            continue

        if resolved not in seen:
            seen.add(resolved)
            results.append({
                "url": resolved,
                "raw": raw,
            })

    if not results:
        # Return raw URLs even if unresolved - caller can handle
        results = [{"url": r, "raw": r} for r in raw_urls]

    return results


def _resolve_cdn_vars(html: str, prorcp_hash: str) -> dict:
    """
    Resolve {v1}..{v5} CDN hostname placeholders dynamically.

    The prorcp page loads an obfuscated JS file (filename changes per deploy)
    that contains the CDN hostnames. We:
      1. Extract the JS filename from the prorcp HTML (document.write pattern)
      2. Run it through Node.js in a sandboxed VM to extract the hostnames
      3. Fall back to last-known-good hostnames if Node fails
    """
    import subprocess, json, os

    vars_map = {}

    # Step 1: find the CDN vars JS filename - it's injected via document.write
    # Pattern: document.write("<script ... src='/HASH.js?_=TIMESTAMP'...")
    js_path = _extract(r"document\.write\([^)]*src='(/[a-f0-9]+\.js\?[^']+)'", html)
    if not js_path:
        # Fallback pattern
        js_path = _extract(r'src=["\']/(([a-f0-9]{32})\.js\?[^"\']+)["\']', html)

    if js_path:
        cdn_js_url = f"https://cloudnestra.com{js_path}"
        print(f"[*] CDN vars JS: {cdn_js_url}")

        # Step 2: run through Node.js extractor
        node_script = os.path.join(os.path.dirname(__file__), "extract_cdn_vars.js")
        try:
            result = subprocess.run(
                ["node", node_script, cdn_js_url],
                capture_output=True, text=True, timeout=10
            )
            if result.stdout.strip():
                parsed = json.loads(result.stdout.strip())
                if parsed:
                    vars_map = parsed
                    print(f"[+] CDN vars resolved via Node: {vars_map}")
        except Exception as e:
            print(f"[-] Node extraction failed: {e}")

    # Step 3: fallback - use last-known-good CDN hostnames
    # These are observed from live traffic and updated here when they rotate
    FALLBACK = {
        "v1": "neonhorizonworkshops.com",
        "v2": "cloudnestra.com",
        "v3": "neonhorizonworkshops.com",
        "v4": "neonhorizonworkshops.com",
        "v5": "cloudnestra.com",
    }
    for k, v in FALLBACK.items():
        if k not in vars_map:
            vars_map[k] = v

    return vars_map


# ---------------------------------------------------------------------------
# Main scraper entry point
# ---------------------------------------------------------------------------

def scrape(media_type: str, media_id: str, season: int = None, episode: int = None) -> dict:
    """
    Scrape stream URLs from vidsrc.to.

    Args:
        media_type: 'movie' or 'tv'
        media_id:   IMDB id (tt...) or TMDB numeric id
        season:     Season number (TV only)
        episode:    Episode number (TV only)

    Returns:
        dict with 'streams' list and metadata
    """
    print(f"[*] Fetching: {media_type}/{media_id}" + (f" S{season:02d}E{episode:02d}" if season else ""))

    # Step 1
    vsembed_url, vidsrc_url = get_vsembed_url(media_type, media_id, season, episode)
    print(f"[+] vsembed URL: {vsembed_url}")

    # Step 2
    rcp_hash, all_hashes = get_rcp_hash(vsembed_url, referer=vidsrc_url)
    print(f"[+] RCP hash(es): {len(all_hashes)} source(s) found")

    streams = []
    errors = []

    for i, h in enumerate(all_hashes):
        try:
            print(f"[*] Processing source {i+1}/{len(all_hashes)}: {h[:40]}...")

            # Step 3
            rcp_referer = vsembed_url
            prorcp_hash = get_prorcp_hash(h, referer=rcp_referer)
            print(f"[+] prorcp hash: {prorcp_hash[:40]}...")

            # Step 4
            rcp_url = f"https://cloudnestra.com/rcp/{h}"
            m3u8_list = get_m3u8_urls(prorcp_hash, referer=rcp_url)
            print(f"[+] Found {len(m3u8_list)} m3u8 URL(s)")

            for entry in m3u8_list:
                streams.append({
                    "source_index": i,
                    "url": entry["url"],
                    "type": "hls",
                })
                print(f"    -> {entry['url']}")

        except Exception as e:
            errors.append({"source_index": i, "error": str(e)})
            print(f"[-] Source {i+1} failed: {e}")

    return {
        "media_type": media_type,
        "media_id": media_id,
        "season": season,
        "episode": episode,
        "streams": streams,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse, json

    parser = argparse.ArgumentParser(description="VidSrc.to stream scraper")
    parser.add_argument("id", help="IMDB (tt...) or TMDB numeric ID")
    parser.add_argument("--type", choices=["movie", "tv"], default="movie", help="Media type (default: movie)")
    parser.add_argument("--season", type=int, help="Season number (TV only)")
    parser.add_argument("--episode", type=int, help="Episode number (TV only)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    result = scrape(args.type, args.id, args.season, args.episode)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("\n=== STREAMS ===")
        if result["streams"]:
            for s in result["streams"]:
                print(s["url"])
        else:
            print("No streams found.")
        if result["errors"]:
            print("\n=== ERRORS ===")
            for e in result["errors"]:
                print(f"Source {e['source_index']}: {e['error']}")


if __name__ == "__main__":
    main()
