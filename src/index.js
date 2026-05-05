const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3001;

// Cache: search result 10 menit, stream URL 8 menit (signed URL expire-nya unpredictable)
const searchCache = new NodeCache({ stdTTL: 600 });
const streamCache = new NodeCache({ stdTTL: 480 });

app.use(cors());
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Id Muzix Backend is alive 🎵" });
});

// ─── GET /search?q=nama+lagu ──────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query is required" });

  const cacheKey = `search_${query.toLowerCase().trim()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] search: ${query}`);
    return res.json(cached);
  }

  try {
    // 1. Fetch dari SoundCloud API
    const scRes = await axios.get("https://api-faa.my.id/faa/soundcloud-play", {
      params: { query },
      timeout: 10000,
    });

    if (!scRes.data?.status || !scRes.data?.result) {
      return res.status(404).json({ error: "Lagu tidak ditemukan di SoundCloud" });
    }

    const track = scRes.data.result;

    // 2. Fetch thumbnail dari iTunes (lebih clean dari SC thumbnail)
    let thumbnail = track.thumbnail; // fallback ke SC thumbnail
    try {
      const itunesRes = await axios.get("https://itunes.apple.com/search", {
        params: {
          term: query,
          entity: "song",
          limit: 1,
          media: "music",
        },
        timeout: 5000,
      });

      if (itunesRes.data?.results?.length > 0) {
        // Upgrade dari 100x100 ke 600x600
        thumbnail = itunesRes.data.results[0].artworkUrl100.replace(
          "100x100bb",
          "600x600bb"
        );
      }
    } catch (itunesErr) {
      console.warn("[iTunes] fallback ke SC thumbnail:", itunesErr.message);
    }

    const result = {
      title: track.title,
      thumbnail,
      duration: track.duration,
      source_url: track.source_url,
      format: track.format,
      // Simpan download_url di server saja, jangan expose langsung ke frontend
      // Frontend harus request /stream untuk dapat audio
      stream_token: Buffer.from(query.toLowerCase().trim()).toString("base64"),
    };

    // Cache stream URL terpisah (8 menit)
    streamCache.set(`stream_${result.stream_token}`, track.download_url);

    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[Search Error]", err.message);
    res.status(500).json({ error: "Gagal mengambil data lagu" });
  }
});

// ─── GET /stream/:token — proxy audio stream ──────────────────────────────────
// Ini yang bikin background play works: frontend pake URL ini, bukan direct SC URL
app.get("/stream/:token", async (req, res) => {
  const { token } = req.params;
  let downloadUrl = streamCache.get(`stream_${token}`);

  // Kalau cache expired, re-fetch dari API
  if (!downloadUrl) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      const scRes = await axios.get("https://api-faa.my.id/faa/soundcloud-play", {
        params: { query },
        timeout: 10000,
      });

      if (!scRes.data?.result?.download_url) {
        return res.status(404).json({ error: "Stream tidak tersedia" });
      }

      downloadUrl = scRes.data.result.download_url;
      streamCache.set(`stream_${token}`, downloadUrl);
    } catch (err) {
      console.error("[Stream Re-fetch Error]", err.message);
      return res.status(500).json({ error: "Gagal mendapatkan stream URL" });
    }
  }

  // Proxy audio stream ke client
  try {
    const range = req.headers.range;
    const headers = { "User-Agent": "Mozilla/5.0" };
    if (range) headers["Range"] = range;

    const audioRes = await axios.get(downloadUrl, {
      responseType: "stream",
      headers,
      timeout: 30000,
    });

    const status = range ? 206 : 200;
    res.writeHead(status, {
      "Content-Type": "audio/mpeg",
      "Content-Length": audioRes.headers["content-length"],
      "Content-Range": audioRes.headers["content-range"] || "",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });

    audioRes.data.pipe(res);

    audioRes.data.on("error", (err) => {
      console.error("[Stream Pipe Error]", err.message);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error("[Stream Proxy Error]", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Gagal stream audio" });
    }
  }
});

// ─── GET /get-stream-url/:token — hybrid: return signed URL ke frontend ───────
app.get("/get-stream-url/:token", async (req, res) => {
  const { token } = req.params;
  let downloadUrl = streamCache.get(`stream_${token}`);

  if (!downloadUrl) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      const scRes = await axios.get("https://api-faa.my.id/faa/soundcloud-play", {
        params: { query },
        timeout: 10000,
      });
      downloadUrl = scRes.data?.result?.download_url;
      if (downloadUrl) streamCache.set(`stream_${token}`, downloadUrl);
    } catch (err) {
      return res.status(500).json({ error: "Gagal mendapatkan stream URL" });
    }
  }

  if (!downloadUrl) return res.status(404).json({ error: "URL tidak ditemukan" });
  res.json({ url: downloadUrl });
});

// ─── GET /download/:token — return direct URL untuk download ──────────────────
app.get("/download/:token", async (req, res) => {
  const { token } = req.params;
  let downloadUrl = streamCache.get(`stream_${token}`);

  if (!downloadUrl) {
    try {
      const query = Buffer.from(token, "base64").toString("utf-8");
      const scRes = await axios.get("https://api-faa.my.id/faa/soundcloud-play", {
        params: { query },
        timeout: 10000,
      });
      downloadUrl = scRes.data?.result?.download_url;
      if (downloadUrl) streamCache.set(`stream_${token}`, downloadUrl);
    } catch (err) {
      return res.status(500).json({ error: "Gagal mendapatkan download URL" });
    }
  }

  if (!downloadUrl) return res.status(404).json({ error: "URL tidak ditemukan" });

  // Redirect ke download URL langsung
  res.redirect(downloadUrl);
});

app.listen(PORT, () => {
  console.log(`🎵 Id Muzix Backend running on port ${PORT}`);
});
