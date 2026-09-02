// Local validation of api/relay.js (flat handler, ?up= rewrite contract)
// Stubs Vercel req/res — hits real api.cloudflare.com (local machine has full internet).
import { Readable } from "node:stream";

const CF_TOKEN = process.env.CF_TOKEN || "Dz0-OduYIi_jwxBnvhmOyvOn75S7QToKnY90_JzV";
const ACCT = "d1fcd8dbbd35aec43e5499200f6baede";
const { default: handler } = await import("./api/relay.js");

function stubRes() {
  const res = {
    statusCode: 0, headers: {}, writes: [], ended: false, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; this.headersSent = true; return this; },
    write(c) { this.writes.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.writes.push(Buffer.from(c)); this.ended = true; },
    send(c) { this.write(c); this.ended = true; },
    json(o) { this.write(JSON.stringify(o)); this.ended = true; },
    body() { return Buffer.concat(this.writes).toString("utf8"); },
  };
  return res;
}

async function run(method, { up, headers = {}, body }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = headers;
  req.query = { up };
  const res = stubRes();
  await handler(req, res);
  return res;
}

// TEST1: GET token verify via ?up=
const t1 = await run("GET", {
  up: "client/v4/user/tokens/verify",
  headers: { authorization: `Bearer ${CF_TOKEN}` },
});
const ok1 = t1.statusCode === 200 && t1.body().includes('"success":true');
console.log(`TEST1 GET verify  -> ${t1.statusCode} | ${t1.body().slice(0, 80)}`);

// TEST2: POST GLM completion via ?up= (deterministic prompt — math can't be refused)
const t2 = await run("POST", {
  up: `client/v4/accounts/${ACCT}/ai/v1/chat/completions`,
  headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "@cf/zai-org/glm-5.3-flash", messages: [{ role: "user", content: "What is 2+2? Answer with just the number." }], max_tokens: 400 }),
});
const c2 = JSON.parse(t2.body());
const content2 = c2.choices?.[0]?.message?.content || "";
const ok2 = t2.statusCode === 200 && typeof content2 === "string" && content2.includes("4");
console.log(`TEST2 POST glm    -> ${t2.statusCode} | content: ${JSON.stringify(content2.slice(0, 60))}`);

// TEST3: streaming passthrough — SSE request must produce MULTIPLE res.write calls
const t3 = await run("POST", {
  up: `client/v4/accounts/${ACCT}/ai/v1/chat/completions`,
  headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "@cf/zai-org/glm-5.3-flash", messages: [{ role: "user", content: "Count 1 to 10, one per line" }], max_tokens: 500, stream: true }),
});
const sseChunks = t3.body().split("\n").filter((l) => l.startsWith("data:")).length;
const ok3 = t3.statusCode === 200 && sseChunks >= 3 && t3.writes.length >= 2;
console.log(`TEST3 stream      -> ${t3.statusCode} | res.write calls: ${t3.writes.length} | SSE data lines: ${sseChunks}`);

// TEST4: telegram passthrough handler — bogus token must yield Telegram's own 401
const { default: tgHandler } = await import("./api/telegram.js");
async function runTg(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = body ? { "content-type": "application/json" } : {};
  const res = stubRes();
  await tgHandler(req, res);
  return res;
}
const t4 = await runTg("GET", "/telegram/bot000:bogus/getMe");
const ok4 = t4.statusCode === 401 && t4.body().includes("Unauthorized");
console.log(`TEST4 tg bogus    -> ${t4.statusCode} | ${t4.body().slice(0, 80)}`);

// TEST5: telegram handler bad shape -> usage 400
const t5 = await runTg("GET", "/telegram/wrong");
const ok5 = t5.statusCode === 400 && t5.body().includes("usage:");
console.log(`TEST5 tg badpath  -> ${t5.statusCode} | ${t5.body().slice(0, 80)}`);

console.log(
  ok1 && ok2 && ok3 && ok4 && ok5
    ? "RELAY-PASS (flat handler, up-contract, streaming, telegram passthrough)"
    : "RELAY-FAIL"
);
process.exit(ok1 && ok2 && ok3 && ok4 && ok5 ? 0 : 1);
