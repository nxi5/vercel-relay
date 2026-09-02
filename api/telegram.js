export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // Telegram Bot API passthrough: /telegram/bot<TOKEN>/<method> -> api.telegram.org
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(204).end();
    return;
  }

  const m = (req.url || "").match(/\/telegram\/(bot[^/?]+)\/([^/?]+)/);
  if (!m) {
    res.status(400).json({ ok: false, error: "usage: /telegram/bot<TOKEN>/<method>" });
    return;
  }
  const botToken = m[1];
  const method = m[2];

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
    if (body.length === 0) body = undefined;
  }

  try {
    const r = await fetch(`https://api.telegram.org/${botToken}/${method}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body,
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    res.status(r.status);

    // stream-through (same reasoning as relay.js — keep long-poll alive)
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502);
    res.end(JSON.stringify({ ok: false, error: "telegram relay: upstream failed", detail: String(e).slice(0, 200) }));
  }
}
