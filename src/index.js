const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3001;

const searchCache = new NodeCache({ stdTTL: 600 });
const streamCache  = new NodeCache({ stdTTL: 480 });

app.use(cors());
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Id Muzix Backend is alive 🎵" });
});

// ─── Helper: fetch dari SoundCloud ───────────────────────────────────────────
async function fetchFromSoundCloud(query) {
  const res = await axios.get("https://api-faa.my.id/faa/soundcloud-play", {
    params: { query },
    timeout: 10000,
  });
  if (!res.data?.status || !res.data?.result) return null;
  return res.data.result;
}

// ─── Helper: fetch dari YouTube (fallback) ────────────────────────────────────
async function fetchFromYouTube(query) {
  const res = await axios.get("https://api-faa.my.id/faa/ytplay", {
    params: { query },
    timeout: 10000,
  });
  if (!res.data?.status || !res.data?.result) return null;
  return res.data.result;
}

// ─── Helper: fetch thumbnail iTunes ──────────────────────────────────────────
async function fetchItunesThumbnail(query, fallback) {
  try {
    const res = await axios.get("https://itunes.apple.com/search", {
      params: { term: query, entity: "song", limit: 1, media: "music" },
      timeout: 5000,
    });
    if (res.data?.results?.length > 0) {
      return res.data.results[0].artworkUrl100.replace("100x100bb", "600x600bb");
    }
  } catch (e) {
    console.warn("[iTunes] fallback:", e.message);
  }
  return fallback;
}

// ─── GET /search?q=nama+lagu ──────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query is required" });

  const cacheKey = `search_${query.toLowerCase().trim()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${query}`);
    return res.json(cached);
  }

  try {
    let track = null;
    let source = "soundcloud";

    // 1. Coba SoundCloud dulu
    try {
      track = await fetchFromSoundCloud(query);
    } catch (e) {
      console.warn("[SC] gagal:", e.message);
    }

    // 2. Fallback ke YouTube kalau SC gagal
    if (!track) {
      console.log(`[FALLBACK] SC gagal, coba YouTube untuk: ${query}`);
      try {
        track = await fetchFromYouTube(query);
        source = "youtube";
      } catch (e) {
        console.warn("[YT] juga gagal:", e.message);
      }
    }

    if (!track) {
      return res.status(404).json({ error: "Lagu tidak ditemukan" });
    }

    // 3. Thumbnail dari iTunes, fallback ke track thumbnail
    const thumbnail = await fetchItunesThumbnail(query, track.thumbnail);

    const token = Buffer.from(query.toLowerCase().trim()).toString("base64");
    streamCache.set(`stream_${token}`, { url: track.download_url, source });

    const result = {
      title: track.title,
      thumbnail,
      duration: track.duration,
      source_url: track.source_url,
      source,
      stream_token: token,
    };

    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[Search Error]", err.message);
    res.status(500).json({ error: "Gagal mengambil data lagu" });
  }
});

// ─── GET /get-stream-url/:token — return signed URL ke frontend ───────────────
app.get("/get-stream-url/:token", async (req, res) => {
  const { token } = req.params;
  let cached = streamCache.get(`stream_${token}`);

  if (!cached) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      let track = await fetchFromSoundCloud(query).catch(() => null);
      let source = "soundcloud";
      if (!track) {
        track = await fetchFromYouTube(query).catch(() => null);
        source = "youtube";
      }
      if (!track?.download_url) return res.status(404).json({ error: "URL tidak ditemukan" });
      cached = { url: track.download_url, source };
      streamCache.set(`stream_${token}`, cached);
    } catch (err) {
      return res.status(500).json({ error: "Gagal mendapatkan stream URL" });
    }
  }

  res.json({ url: cached.url, source: cached.source });
});

// ─── GET /download/:token ─────────────────────────────────────────────────────
app.get("/download/:token", async (req, res) => {
  const { token } = req.params;
  let cached = streamCache.get(`stream_${token}`);

  if (!cached) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      let track = await fetchFromSoundCloud(query).catch(() => null);
      if (!track) track = await fetchFromYouTube(query).catch(() => null);
      if (!track?.download_url) return res.status(404).json({ error: "URL tidak ditemukan" });
      cached = { url: track.download_url };
      streamCache.set(`stream_${token}`, cached);
    } catch (err) {
      return res.status(500).json({ error: "Gagal download" });
    }
  }

  // Content-Disposition biar browser langsung download, bukan buka tab baru
  res.setHeader("Content-Disposition", "attachment");
  res.redirect(cached.url);
});

// ─── GET /trending — chart Indonesia hardcoded (bisa diganti API nanti) ───────
app.get("/trending", (req, res) => {
  res.json([
    { title: "Hindia - Membasuh ft. Rara Sekar", query: "membasuh hindia rara sekar" },
    { title: "Juicy Luicy - Lantas", query: "juicy luicy lantas" },
    { title: "Pamungkas - To The Bone", query: "pamungkas to the bone" },
    { title: "Kunto Aji - Rehat", query: "kunto aji rehat" },
    { title: "Yura Yunita - Cinta dan Rahasia", query: "yura yunita cinta dan rahasia" },
    { title: "Tulus - Hati-Hati di Jalan", query: "tulus hati hati di jalan" },
    { title: "Fiersa Besari - Waktu yang Salah", query: "fiersa besari waktu yang salah" },
    { title: "Maliq & D'Essentials - Untukmu", query: "maliq dessentials untukmu" },
    { title: "Fourtwnty - Zona Nyaman", query: "fourtwnty zona nyaman" },
    { title: "Rizky Febian - Kesempurnaan Cinta", query: "rizky febian kesempurnaan cinta" },
  ]);
});

app.listen(PORT, () => {
  console.log(`🎵 Id Muzix Backend running on port ${PORT}`);
});
