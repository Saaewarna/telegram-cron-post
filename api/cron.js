// api/cron.js
export default async function handler(req, res) {
  // --- AUTH: cron vercel / test manual / secret key eksternal ---
  const allowed =
    req.headers["x-vercel-cron"] === "1" ||
    req.query.test === "1" ||
    (process.env.SECRET_KEY && req.query.key === process.env.SECRET_KEY);

  if (!allowed) return res.status(401).json({ ok: false, msg: "unauthorized" });

  const {
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    SHEET_ID,
    SHEET_GID = "0",         // tab pertama (default)
    OFFSET = "0",            // geser rotasi kalau perlu
  } = process.env;

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !SHEET_ID) {
    return res.status(500).json({ ok: false, msg: "Missing env vars" });
  }

  // --- FETCH dari Google Sheets (kolom B = text_pesan) ---
  async function fetchSheetTexts(sheetId, gid = "0") {
    // gViz JSON: paling aman buat emoji/koma/newline
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    const raw = await fetch(url).then(r => r.text());
    const json = JSON.parse(raw.slice(47, -2));
    // rows = data tanpa header; kolom B = index 1
    return (json.table.rows || [])
      .map(r => (r.c?.[1]?.v ?? "").toString().trim())
      .filter(Boolean);
  }

  const sheetMsgs = await fetchSheetTexts(SHEET_ID, SHEET_GID);
  if (!sheetMsgs.length) {
    return res.status(500).json({ ok: false, msg: "Sheet kosong (kolom B) 🤷‍♂️" });
  }

  // --- PILIH PESAN ---
  const pool = sheetMsgs; // pure dari Sheets
  const slot = Math.floor(Date.now() / (30 * 60 * 1000)); // rotasi per 30 menit
  const offset = Number.isFinite(+OFFSET) ? (+OFFSET % pool.length + pool.length) % pool.length : 0;

  // override via query
  const hasIndex = typeof req.query.index !== "undefined";
  const qIndex = hasIndex ? Math.max(0, Math.min(pool.length - 1, +req.query.index || 0)) : null;
  const qRandom = req.query.random === "1";

  let idx = (slot + offset) % pool.length;
  if (qRandom) idx = Math.floor(Math.random() * pool.length);
  if (qIndex !== null) idx = qIndex;

  const pick = pool[idx];

  // --- SPLIT kalau panjang (>4096). Pakai margin 3500 biar aman ---
  const splitMessage = (txt, limit = 3500) => {
    const parts = [];
    let s = txt;
    while (s.length > limit) {
      const cutAt = s.lastIndexOf("\n", limit);
      const cut = cutAt > 0 ? cutAt : limit;
      parts.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) parts.push(s);
    return parts;
  };

  // --- SEND ke Telegram ---
  const sendText = (text) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,     // contoh: @warnatopup
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }).then(r => r.json());

  const chunks = splitMessage(pick);
  const results = [];
  for (const c of chunks) {
    results.push(await sendText(c));
    await new Promise(r => setTimeout(r, 250)); // jeda tipis biar ga spammy
  }

  // --- DEBUG saat ?test=1 ---
  if (req.query.test === "1") {
    return res.status(200).json({
      ok: true,
      sheetCount: pool.length,
      pickedIndex: idx,
      pickedPreview: pick.slice(0, 120),
      offset,
      random: qRandom,
      forcedIndex: qIndex,
      results,
    });
  }

  return res.status(200).json({ ok: true });
}
