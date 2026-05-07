const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");

const app = express();

// FIX proxy ClawCloud / Vercel
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3001;

// ─── Config ───────────────────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || "https://antaxtp1.github.io";
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:5000";

// Explicit full endpoints sesuai dokumentasi api-faa.my.id
const FAA_YT_ENDPOINT = "https://api-faa.my.id/faa/ytplay";
const FAA_SC_ENDPOINT = "https://api-faa.my.id/faa/soundcloud-play";

// ─── Cache ────────────────────────────────────────────────────────────────────
const searchCache  = new NodeCache({ stdTTL: 600 });
const streamCache  = new NodeCache({ stdTTL: 480 });
const trendCache   = new NodeCache({ stdTTL: 1800 });

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  FRONTEND_URL,
  "https://id-muzix.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (allowedOrigins.some(o => origin.startsWith(o))) {
      return cb(null, true);
    }

    cb(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ["GET"],
  credentials: false,
}));

app.use(express.json());

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak request, coba lagi sebentar." },
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak pencarian, tunggu sebentar." },
});

app.use(globalLimiter);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Id Muzix Backend is alive 🎵" });
});

// ─── YouTube ──────────────────────────────────────────────────────────────────
async function fetchFromYouTube(query) {
  const res = await axios.get(FAA_YT_ENDPOINT, {
    params: { query },
    timeout: 12000,
  });

  if (!res.data?.status || !res.data?.result) return null;

  return {
    ...res.data.result,
    source: "youtube"
  };
}

// ─── SoundCloud ───────────────────────────────────────────────────────────────
async function fetchFromSoundCloud(query) {
  const res = await axios.get(FAA_SC_ENDPOINT, {
    params: { query },
    timeout: 10000,
  });

  if (!res.data?.status || !res.data?.result) return null;

  return {
    ...res.data.result,
    source: "soundcloud"
  };
}

// ─── Metadata ─────────────────────────────────────────────────────────────────
async function fetchYTMusicMeta(query) {
  try {
    const res = await axios.get(`${PYTHON_SERVICE_URL}/metadata`, {
      params: { q: query },
      timeout: 8000,
    });

    if (res.data?.thumbnail) {
      return res.data;
    }

  } catch (e) {
    console.warn("[PythonSvc] metadata gagal:", e.message);
  }

  return null;
}

// ─── Stream fallback ──────────────────────────────────────────────────────────
async function fetchStreamWithFallback(query) {
  let track = null;

  try {
    track = await fetchFromYouTube(query);
  } catch (e) {
    console.warn("[YT] gagal:", e.message);
  }

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

// ─── Search ───────────────────────────────────────────────────────────────────
app.get("/search", searchLimiter, async (req, res) => {

  const query = (req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  const cacheKey = `search_${query.toLowerCase()}`;

  const cached = searchCache.get(cacheKey);

  if (cached) {
    console.log(`[CACHE HIT] ${query}`);
    return res.json(cached);
  }

  try {

    const [track, ytMeta] = await Promise.all([
      fetchStreamWithFallback(query),
      fetchYTMusicMeta(query),
    ]);

    if (!track) {
      return res.status(404).json({
        error: "Lagu tidak ditemukan"
      });
    }

    // FIX stream URL parser fleksibel (ditambah track.mp3)
    const streamUrl =
      track.mp3 ||
      track.download_url ||
      track.url ||
      track.audio ||
      track.dl ||
      "";

    if (!streamUrl) {
      throw new Error("Stream URL kosong dari provider");
    }

    const thumbnail = ytMeta?.thumbnail || track.thumbnail || "";
    const artist    = ytMeta?.artist || track.artist || "";
    const album     = ytMeta?.album || "";
    const videoId   = ytMeta?.videoId || "";

    const token = Buffer
      .from(query.toLowerCase())
      .toString("base64");

    streamCache.set(`stream_${token}`, {
      url: streamUrl,
      source: track.source
    });

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

    res.status(500).json({
      error: "Gagal mengambil data lagu"
    });
  }
});

// ─── Stream URL ───────────────────────────────────────────────────────────────
app.get("/get-stream-url/:token", async (req, res) => {

  const { token } = req.params;

  let cached = streamCache.get(`stream_${token}`);

  if (!cached) {

    try {

      const query = Buffer
        .from(token, "base64")
        .toString("utf-8");

      const track = await fetchStreamWithFallback(query);

      // FIX parser fleksibel
      const streamUrl =
        track?.mp3 ||
        track?.download_url ||
        track?.url ||
        track?.audio ||
        track?.dl ||
        "";

      if (!streamUrl) {
        return res.status(404).json({
          error: "URL tidak ditemukan"
        });
      }

      cached = {
        url: streamUrl,
        source: track.source
      };

      streamCache.set(`stream_${token}`, cached);

    } catch (err) {

      return res.status(500).json({
        error: "Gagal mendapatkan stream URL"
      });
    }
  }

  res.json({
    url: cached.url,
    source: cached.source
  });
});

// ─── Download ─────────────────────────────────────────────────────────────────
app.get("/download/:token", async (req, res) => {

  const { token } = req.params;

  let cached = streamCache.get(`stream_${token}`);

  if (!cached) {

    try {

      const query = Buffer
        .from(token, "base64")
        .toString("utf-8");

      const track = await fetchStreamWithFallback(query);

      // FIX parser fleksibel
      const streamUrl =
        track?.mp3 ||
        track?.download_url ||
        track?.url ||
        track?.audio ||
        track?.dl ||
        "";

      if (!streamUrl) {
        return res.status(404).json({
          error: "URL tidak ditemukan"
        });
      }

      cached = { url: streamUrl };

      streamCache.set(`stream_${token}`, cached);

    } catch (err) {

      return res.status(500).json({
        error: "Gagal download"
      });
    }
  }

  res.setHeader("Content-Disposition", "attachment");

  res.redirect(cached.url);
});

// ─── Trending ─────────────────────────────────────────────────────────────────
app.get("/trending", async (req, res) => {

  const cached = trendCache.get("trending_id");

  if (cached) {
    return res.json(cached);
  }

  try {

    const response = await axios.get(
      `${PYTHON_SERVICE_URL}/trending`,
      { timeout: 10000 }
    );

    const data = response.data;

    if (Array.isArray(data) && data.length) {

      trendCache.set("trending_id", data);

      return res.json(data);
    }

    throw new Error("Empty trending data");

  } catch (e) {

    console.warn("[Trending] Python service gagal:", e.message);

    return res.json([]);
  }
});

// ─── Related ──────────────────────────────────────────────────────────────────
app.get("/related", async (req, res) => {

  const query  = (req.query.q || "").trim();
  const artist = (req.query.artist || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Query is required"
    });
  }

  const cacheKey =
    `related_${query.toLowerCase()}_${artist.toLowerCase()}`;

  const cached = searchCache.get(cacheKey);

  if (cached) {
    return res.json(cached);
  }

  try {

    const response = await axios.get(
      `${PYTHON_SERVICE_URL}/related`,
      {
        params: { q: query, artist },
        timeout: 10000,
      }
    );

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

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {

  const checks = {
    node: "ok",
    python_service: "unknown",
    faa_api: "unknown"
  };

  try {
    await axios.get(`${PYTHON_SERVICE_URL}/`, {
      timeout: 3000
    });

    checks.python_service = "ok";

  } catch {
    checks.python_service = "down";
  }

  try {
    await axios.get(`${FAA_SC_ENDPOINT}?query=test`, {
      timeout: 3000
    });

    checks.faa_api = "ok";

  } catch {
    checks.faa_api = "down";
  }

  const allOk =
    Object.values(checks).every(v => v === "ok");

  res.status(allOk ? 200 : 207).json({
    status: allOk ? "ok" : "degraded",
    checks
  });
});

app.listen(PORT, () => {
  console.log(`🎵 Id Muzix Backend running on port ${PORT}`);
  console.log(`   Python service: ${PYTHON_SERVICE_URL}`);
  console.log(`   Frontend origin: ${FRONTEND_URL}`);
});
