const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Config ───────────────────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || "https://antaxtp1.github.io";
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:5000";
const FAA_BASE = "https://api-faa.my.id/faa";

// ─── Cache ────────────────────────────────────────────────────────────────────
const searchCache  = new NodeCache({ stdTTL: 600 });
const streamCache  = new NodeCache({ stdTTL: 480 });
const trendCache   = new NodeCache({ stdTTL: 1800 }); // 30 menit

// ─── CORS — whitelist frontend aja ───────────────────────────────────────────
const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, mobile app)
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ["GET"],
  credentials: false,
}));

app.use(express.json());

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 menit
  max: 60,                    // max 60 req/menit per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak request, coba lagi sebentar." },
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                    // search lebih ketat: 20/menit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak pencarian, tunggu sebentar." },
});

app.use(globalLimiter);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Id Muzix Backend is alive 🎵" });
});

// ─── Helper: fetch dari YouTube (PRIMARY) ─────────────────────────────────────
async function fetchFromYouTube(query) {
  const res = await axios.get(`${FAA_BASE}/ytplay`, {
    params: { query },
    timeout: 12000,
  });
  if (!res.data?.status || !res.data?.result) return null;
  return { ...res.data.result, source: "youtube" };
}

// ─── Helper: fetch dari SoundCloud (BACKUP) ──────────────────────────────────
async function fetchFromSoundCloud(query) {
  const res = await axios.get(`${FAA_BASE}/soundcloud-play`, {
    params: { query },
    timeout: 10000,
  });
  if (!res.data?.status || !res.data?.result) return null;
  return { ...res.data.result, source: "soundcloud" };
}

// ─── Helper: fetch thumbnail & metadata dari Python service ──────────────────
async function fetchYTMusicMeta(query) {
  try {
    const res = await axios.get(`${PYTHON_SERVICE_URL}/metadata`, {
      params: { q: query },
      timeout: 8000,
    });
    if (res.data?.thumbnail) return res.data;
  } catch (e) {
    console.warn("[PythonSvc] metadata gagal:", e.message);
  }
  return null;
}

// ─── Helper: fetch stream (YT primary, SC backup) ─────────────────────────────
async function fetchStreamWithFallback(query) {
  let track = null;

  // 1. Coba YouTube dulu (primary)
  try {
    track = await fetchFromYouTube(query);
  } catch (e) {
    console.warn("[YT] gagal:", e.message);
  }

  // 2. Fallback ke SoundCloud
  if (!track) {
    console.log(`[FALLBACK] YT gagal, coba SoundCloud: ${query}`);
    try {
      track = await fetchFromSoundCloud(query);
    } catch (e) {
      console.warn("[SC] juga gagal:", e.message);
    }
  }

  return track;
}

// ─── GET /search?q=nama+lagu ──────────────────────────────────────────────────
app.get("/search", searchLimiter, async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Query is required" });

  const cacheKey = `search_${query.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${query}`);
    return res.json(cached);
  }

  try {
    // Paralel: fetch stream + metadata dari Python service
    const [track, ytMeta] = await Promise.all([
      fetchStreamWithFallback(query),
      fetchYTMusicMeta(query),
    ]);

    if (!track) {
      return res.status(404).json({ error: "Lagu tidak ditemukan" });
    }

    // Thumbnail: prioritas Python service (YT Music) > track thumbnail
    const thumbnail = ytMeta?.thumbnail || track.thumbnail || "";
    const artist    = ytMeta?.artist    || track.artist    || "";
    const album     = ytMeta?.album     || "";
    const videoId   = ytMeta?.videoId   || "";

    const token = Buffer.from(query.toLowerCase()).toString("base64");
    streamCache.set(`stream_${token}`, { url: track.download_url, source: track.source });

    const result = {
      title: ytMeta?.title || track.title,
      artist,
      album,
      thumbnail,
      duration: track.duration,
      source: track.source,
      stream_token: token,
      videoId,
    };

    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[Search Error]", err.message);
    res.status(500).json({ error: "Gagal mengambil data lagu" });
  }
});

// ─── GET /get-stream-url/:token ───────────────────────────────────────────────
app.get("/get-stream-url/:token", async (req, res) => {
  const { token } = req.params;
  let cached = streamCache.get(`stream_${token}`);

  if (!cached) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      const track = await fetchStreamWithFallback(query);
      if (!track?.download_url) return res.status(404).json({ error: "URL tidak ditemukan" });
      cached = { url: track.download_url, source: track.source };
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
      const track = await fetchStreamWithFallback(query);
      if (!track?.download_url) return res.status(404).json({ error: "URL tidak ditemukan" });
      cached = { url: track.download_url };
      streamCache.set(`stream_${token}`, cached);
    } catch (err) {
      return res.status(500).json({ error: "Gagal download" });
    }
  }

  res.setHeader("Content-Disposition", "attachment");
  res.redirect(cached.url);
});

// ─── GET /trending — dari Python service (YT Music chart Indonesia) ───────────
app.get("/trending", async (req, res) => {
  const cached = trendCache.get("trending_id");
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${PYTHON_SERVICE_URL}/trending`, { timeout: 10000 });
    const data = response.data;
    if (Array.isArray(data) && data.length) {
      trendCache.set("trending_id", data);
      return res.json(data);
    }
    throw new Error("Empty trending data");
  } catch (e) {
    console.warn("[Trending] Python service gagal:", e.message);
    // Fallback minimal kalau Python service down
    return res.json([]);
  }
});

// ─── GET /related?q=query&artist=artist — related songs dari Python service ───
app.get("/related", async (req, res) => {
  const query  = (req.query.q || "").trim();
  const artist = (req.query.artist || "").trim();
  if (!query) return res.status(400).json({ error: "Query is required" });

  const cacheKey = `related_${query.toLowerCase()}_${artist.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${PYTHON_SERVICE_URL}/related`, {
      params: { q: query, artist },
      timeout: 10000,
    });
    const data = response.data;
    if (Array.isArray(data) && data.length) {
      searchCache.set(cacheKey, data);
      return res.json(data);
    }
    throw new Error("Empty related data");
  } catch (e) {
    console.warn("[Related] Python service gagal:", e.message);
    return res.json([]);
  }
});

// ─── GET /health — cek status semua service ──────────────────────────────────
app.get("/health", async (req, res) => {
  const checks = { node: "ok", python_service: "unknown", faa_api: "unknown" };

  try {
    await axios.get(`${PYTHON_SERVICE_URL}/`, { timeout: 3000 });
    checks.python_service = "ok";
  } catch { checks.python_service = "down"; }

  try {
    await axios.get(`${FAA_BASE}/soundcloud-play?query=test`, { timeout: 3000 });
    checks.faa_api = "ok";
  } catch { checks.faa_api = "down"; }

  const allOk = Object.values(checks).every(v => v === "ok");
  res.status(allOk ? 200 : 207).json({ status: allOk ? "ok" : "degraded", checks });
});

app.listen(PORT, () => {
  console.log(`🎵 Id Muzix Backend running on port ${PORT}`);
  console.log(`   Python service: ${PYTHON_SERVICE_URL}`);
  console.log(`   Frontend origin: ${FRONTEND_URL}`);
});
