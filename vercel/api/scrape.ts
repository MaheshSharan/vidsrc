import type { VercelRequest, VercelResponse } from "@vercel/node";
import { scrape } from "../lib/scraper.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, type = "movie", season, episode } = req.query;

  if (!id || typeof id !== "string") {
    return res.status(400).json({
      error: "Missing required param: id (IMDB tt... or TMDB numeric id)",
      usage: {
        movie: "/api/scrape?id=tt9263550",
        movie_tmdb: "/api/scrape?id=12345&type=movie",
        tv: "/api/scrape?id=tt1234567&type=tv&season=1&episode=3",
      },
    });
  }

  const mediaType = typeof type === "string" ? type : "movie";
  const s = season ? parseInt(season as string, 10) : undefined;
  const e = episode ? parseInt(episode as string, 10) : undefined;

  if (mediaType === "tv" && (!s || !e)) {
    return res.status(400).json({ error: "TV requires season and episode params" });
  }

  try {
    const result = await scrape(mediaType, id, s, e);

    if (!result.streams.length) {
      return res.status(404).json({ error: "No streams found", details: result.errors });
    }

    // Cache for 5 minutes - URLs are session-scoped and rotate
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
