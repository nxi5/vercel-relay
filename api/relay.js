export const config = { api: { bodyParser: false } };

const ALLOWED = ["authorization", "content-type", "accept", "user-agent"];

export default async function handler(req, res) {
  // CORS preflight (browser/WebApp clients)
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(204).end();
    return;
  }

  // Optional shared secret: set RELAY_KEY env at deploy; clients send X-Relay-Key
  if (process.env.RELAY_KEY && req.headers["x-relay-key"] !== process.env.RELAY_KEY) {
    res.status(401).json({ error: "relay: bad key" });
    return;
  }

  // Upstream path arrives via rewrite: /anything -> /api/relay?up=anything
  let up = req.query.up;
  if (Array.isArray(up)) up = up.join("/");
  if (!up) up = "";
  if (!up.startsWith("/")) up = "/" + up;

  const headers = {};
  for (const h of ALLOWED) if (req.headers[h]) headers[h] = req.headers[h];

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
    if (body.length === 0) body = undefined;
  }

  try {
    const r = await fetch("https://api.cloudflare.com" + up, { method: req.method, headers, body });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "no-cache");
    res.status(r.status);

    // Stream the upstream body through chunk-by-chunk (SSE-friendly).
    // Buffering with r.text() makes hermes show nothing for the whole
    // generation, then dump the answer in one wall of text.
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
    res.end(JSON.stringify({ error: "relay: upstream failed", detail: String(e).slice(0, 200) }));
  }
}
