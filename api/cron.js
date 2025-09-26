// api/cron.js
export default async function handler(req, res) {
  // izinkan: cron Vercel (x-vercel-cron), test manual (?test=1), atau secret key (?key=XXX)
  const allowed =
    req.headers["x-vercel-cron"] === "1" ||
    req.query.test === "1" ||
    (process.env.SECRET_KEY && req.query.key === process.env.SECRET_KEY);

  if (!allowed) return res.status(401).json({ ok: false, msg: "unauthorized" });

  const {
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    SHEET_ID,
    SHEET_GID = "0", // tab pertama default
  } = process.env;

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !SHEET_ID) {
    return res.status(500).json({ ok: false, msg: "Missing env vars" });
  }

  // === FETCH DARI GOOGLE SHEETS (kolom B, skip header) ===
  async function fetchSheetTexts(sheetId, gid = "0") {
    // gViz JSON lebih aman untuk koma/newline/emoji
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    const raw = await fetch(url).then((r) => r.text());
    // hapus pembungkus gviz
    const json = JSON.parse(raw.slice(47, -2));
    // kolom B = index 1
    const texts =
      json.table.rows
        ?.map((r) => (r.c?.[1]?.v ?? "").toString().trim())
        .filter(Boolean) ?? [];
    return texts;
  }

  // === KONTEN STATIC (fallback, opsional) ===
  const staticMsgs = [
    "🔥 Promo gila! Deposit min 50K, bonus langsung masuk!",
    "🎯 Cashback 10% tiap 30 menit — jangan ketinggalan!",
  ];

  const sheetMsgs = await fetchSheetTexts(SHEET_ID, SHEET_GID);

  // Mode paksa dari query (opsional): ?mode=sheet atau ?mode=static
  const mode = (req.query.mode || "").toLowerCase();

  // PRIORITAS: sheet > static (kecuali dipaksa)
  let pool =
    mode === "static"
      ? staticMsgs
      : mode === "sheet"
      ? sheetMsgs
      : sheetMsgs.length
      ? sheetMsgs
      : staticMsgs;

  // buang duplikat & kosong
  pool = [...new Set(pool)].filter(Boolean);

  if (!pool.length) {
    return res.status(500).json({ ok: false, msg: "No messages available" });
  }

  // === PILIH PESAN: rotasi per slot 30 menit (stabil, ga random) ===
  const slot = Math.floor(Date.now() / (30 * 60 * 1000));
  const pick = pool[slot % pool.length];

  // === SPLIT kalau panjang (>4096). Pakai margin 3500 biar aman. ===
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

  // === Kirim ke Telegram ===
  const sendText = (text) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, // contoh: @warnatopup
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }).then((r) => r.json());

  const chunks = splitMessage(pick);
  const results = [];
  for (const c of chunks) {
    results.push(await sendText(c));
    await new Promise((r) => setTimeout(r, 250)); // jeda tipis
  }

  // debug enak dilihat waktu ?test=1
  if (req.query.test === "1") {
    const source = sheetMsgs.includes(pick) ? "sheet" : "static";
    return res.status(200).json({
      ok: true,
      poolSize: pool.length,
      pickedIndex: slot % pool.length,
      pickedPreview: pick.slice(0, 120),
      source,
      results,
    });
  }

  return res.status(200).json({ ok: true });
}
