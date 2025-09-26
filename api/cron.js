export default async function handler(req, res) {
  // izinkan cron vercel / test manual
  if (!(req.headers["x-vercel-cron"] === "1" || req.query.test === "1")) {
    return res.status(401).json({ ok: false, msg: "unauthorized" });
  }

  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, SHEET_ID, SHEET_GID = "0" } = process.env;
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !SHEET_ID) {
    return res.status(500).json({ ok: false, msg: "Missing env vars" });
  }

  // --- ambil kolom B dari Google Sheets (CSV) ---
  async function fetchSheetTextsCSV(sheetId, gid = "0") {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const csv = await fetch(url).then((r) => r.text()); // baris: id, text_pesan
    const rows = csv.split(/\r?\n/).map((r) => r.split(",")); // super simple parser
    // buang header, ambil kolom B (index 1)
    return rows
      .slice(1)
      .map((r) => (r[1] || "").replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }

  const staticMsgs = [
    "🔥 Promo gila! Deposit min 50K, bonus langsung masuk!",
    "🎯 Cashback 10% tiap 30 menit — jangan ketinggalan!",
  ];

  const sheetMsgs = await fetchSheetTextsCSV(SHEET_ID, SHEET_GID);

  // gabung & unik
  let pool = [...staticMsgs, ...sheetMsgs];
  pool = [...new Set(pool)].filter(Boolean);
  if (!pool.length) return res.status(500).json({ ok: false, msg: "No messages" });

  // rotasi per slot 30 menit
  const slot = Math.floor(Date.now() / (30 * 60 * 1000));
  const pick = pool[slot % pool.length];

  // split biar aman < 4096 char
  const splitMessage = (txt, limit = 3500) => {
    const parts = [];
    let s = txt;
    while (s.length > limit) {
      const cut = s.lastIndexOf("\n", limit);
      parts.push(s.slice(0, cut > 0 ? cut : limit).trim());
      s = s.slice(cut > 0 ? cut : limit).trim();
    }
    if (s) parts.push(s);
    return parts;
  };

  const sendText = (text) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }).then((r) => r.json());

  const chunks = splitMessage(pick);
  const results = [];
  for (const c of chunks) {
    results.push(await sendText(c));
    await new Promise((r) => setTimeout(r, 300));
  }

  if (req.query.test === "1") {
    return res.status(200).json({
      ok: true,
      poolSize: pool.length,
      pickedIndex: slot % pool.length,
      pickedPreview: pick.slice(0, 100),
      results,
    });
  }
  return res.status(200).json({ ok: true });
}
