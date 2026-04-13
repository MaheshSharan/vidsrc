# vidsrc-scraper

Request-based scraper for vidsrc.to. No browser, no Selenium. Returns HLS m3u8 stream URLs for any movie or TV show by IMDB or TMDB id.

## Vercel deployment

The `vercel/` folder is a self-contained TypeScript/Node project ready to deploy for vercel.

On Vercel dashboard: set the root directory to `vidsrc/vercel` so it only sees that folder.

---

## Python CLI (local use)

## Requirements

- Python 3.10+
- Node.js (any recent version)
- `pip install requests`

## Usage

```bash
# movie
python scraper.py tt9263550

# movie by TMDB id
python scraper.py 12345 --type movie

# TV episode
python scraper.py tt1234567 --type tv --season 1 --episode 3

# JSON output
python scraper.py tt9263550 --json
```
## How it works

vidsrc.to serves content through a 4-hop chain, all request-based:

```
  GET vidsrc.to/embed/{type}/{id}
  │   parse iframe src
  ▼
  GET vsembed.ru/embed/{type}/{id}/
  │   parse data-hash attributes  ──►  [ hash_1, hash_2, hash_3 ]  (one per source)
  ▼                                              │
  GET cloudnestra.com/rcp/{hash}                 │  iterate each
  │   parse prorcp hash from loadIframe() JS     │
  ▼                                              │
  GET cloudnestra.com/prorcp/{hash}  ◄───────────┘
  │   parse Playerjs({ file: "url1 or url2 or ..." })
  │   resolve {v1}..{v5} CDN placeholders via extract_cdn_vars.js
  ▼
  [ https://tmstr5.<cdn>/pl/<token>/master.m3u8, ... ]
```

The `{v1}`-`{v5}` placeholders come from an obfuscated JS file whose filename is embedded in the prorcp page via `document.write`. `extract_cdn_vars.js` fetches that file and runs it in a Node.js VM sandbox with a mocked browser environment to extract the real hostnames. If that fails, it falls back to last-known-good values.

The `{v1}`-`{v5}` placeholders are resolved by an obfuscated JS file whose filename is embedded in the prorcp page via `document.write`. `extract_cdn_vars.js` fetches that file and runs it in a Node.js VM sandbox with a mocked browser environment to extract the real hostnames. If that fails, it falls back to last-known-good values.

## Using the streams

The m3u8 URLs are served from cloudnestra CDN hosts. They require a `Referer` header pointing to `cloudnestra.com` to play. Direct browser address bar or most online HLS players will get a 403.

**To play in VLC:**
```bash
vlc --http-referrer "https://cloudnestra.com/" "https://tmstr5.neonhorizonworkshops.com/pl/.../master.m3u8"
```

**To play in mpv:**
```bash
mpv --referrer="https://cloudnestra.com/" "https://tmstr5.neonhorizonworkshops.com/pl/.../master.m3u8"
```

**To proxy for browser players** (e.g. hls.js, Video.js), you need a local proxy that injects the Referer header. Example with Python:

```python
# minimal proxy snippet
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request

class Proxy(BaseHTTPRequestHandler):
    def do_GET(self):
        req = urllib.request.Request(
            self.path.lstrip('/'),
            headers={"Referer": "https://cloudnestra.com/", "User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req) as r:
            self.send_response(r.status)
            self.end_headers()
            self.wfile.write(r.read())

HTTPServer(('localhost', 8888), Proxy).serve_forever()
```

Then pass `http://localhost:8888/https://tmstr5.../master.m3u8` to your player.

**As a module:**
```python
from scraper import scrape

result = scrape("movie", "tt9263550")
for stream in result["streams"]:
    print(stream["url"])
```

## Notes

- Multiple stream URLs are returned per title (redundant CDN mirrors, same content)
- The first URL (`tmstr5.neonhorizonworkshops.com`) is the primary CDN and most reliable
- CDN hostnames rotate periodically; the Node.js extractor handles this automatically
- Add a delay between requests if scraping in bulk to avoid rate limiting
