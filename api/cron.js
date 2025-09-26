// api/cron.js
export default async function handler(req, res) {
  const isCron = req.headers['x-vercel-cron'] === '1' || req.query.test === '1';
  if (!isCron) return res.status(401).json({ ok: false, msg: 'unauthorized' });

  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, SHEET_ID } = process.env;
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, msg: 'Missing TELEGRAM_* envs' });
  }

  // --- 1) STATIC short messages (boleh edit/ambah) ---
  const staticMsgs = [
    "🔥 Promo gila! Deposit min 50K, bonus langsung masuk!",
    "🎯 Cashback 10% tiap 30 menit — jangan ketinggalan!",
    "🚀 Info event & update, cek pinned!",
  ];

  // --- helper: fetch baris kolom A dari Google Sheets (sheet pertama) ---
  async function fetchSheetTexts(sheetId) {
    if (!sheetId) return [];
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
    try {
      const raw = await fetch(url).then(r => r.text());
      const json = JSON.parse(raw.substring(47, raw.length - 2));
      // Ambil kolom A (index 0). Satu baris = satu pesan.
      // Format khusus (opsional): "PHOTO|https://url.gambar.jpg|Caption bebas"
      return json.table.rows
        .map(r => (r.c?.[0]?.v ?? "").toString().trim())
        .filter(Boolean);
    } catch (e) {
      console.error("sheet fetch error", e);
      return [];
    }
  }

  const sheetMsgs = await fetchSheetTexts(SHEET_ID);

  // --- 2) Gabung pool: static + sheets ---
  let pool = [...staticMsgs, ...sheetMsgs];
  pool = [...new Set(pool)].filter(Boolean); // unik & non-empty

  if (pool.length === 0) {
    return res.status(500).json({ ok: false, msg: 'No messages available' });
  }

  // --- 3) Rotasi per slot 30 menit (stabil, bukan random) ---
  const slot = Math.floor(Date.now() / (30 * 60 * 1000));
  const pick = pool[slot % pool.length];

  // --- 4) Kirim: dukung TEXT panjang (auto-split) & FOTO (PHOTO|url|caption) ---
  const sendText = async (text) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
    }).then(r => r.json());

  const sendPhoto = async (photoUrl, caption) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML',
        disable_notification: false
      }),
    }).then(r => r.json());

  // auto-split untuk text > 4096 (pakai margin 3500)
  const splitMessage = (txt, limit = 3500) => {
    const parts = [];
    let s = txt;
    while (s.length > limit) {
      const cutAt = s.lastIndexOf('\n', limit);
      const cut = cutAt > 0 ? cutAt : limit;
      parts.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) parts.push(s);
    return parts;
  };

  const results = [];

  // Cek format PHOTO
  if (pick.startsWith("PHOTO|")) {
    // Format: PHOTO|<url>|<caption>
    const [, url = "", capRaw = ""] = pick.split("|");
    const caption = (capRaw || "").trim();
    const r = await sendPhoto(url.trim(), caption);
    results.push(r);
  } else {
    // TEXT
    const chunks = splitMessage(pick);
    for (const c of chunks) {
      const r = await sendText(c);
      results.push(r);
      await new Promise(rr => setTimeout(rr, 300)); // jeda tipis
    }
  }

  // debug view saat ?test=1
  if (req.query.test === '1') {
    return res.status(200).json({
      ok: true,
      poolSize: pool.length,
      pickedIndex: slot % pool.length,
      pickedPreview: pick.slice(0, 120),
      results
    });
  }

  return res.status(200).json({ ok: true });
}
