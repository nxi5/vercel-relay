import ssh2Pkg from 'ssh2';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client } = ssh2Pkg;
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Tunables (not secrets) ──────────────────────────────────────────
const RELAY_BASE = 'https://free-hermes.vercel.app';
const MODEL = '@cf/zai-org/glm-5.3-flash';
const BOOT_TIMEOUT = 540_000; // 9 min hard cap for the installer
const JOB_TTL = 45 * 60_000;  // keep finished jobs 45 min
// ────────────────────────────────────────────────────────────────────

const jobs = new Map(); // id -> job

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finished && now - j.finished > JOB_TTL) jobs.delete(id);
  }
}, 60_000);

function connectSSH(user, pass) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { conn.end(); } catch {}
      reject(new Error('ssh connect timeout (25s) — creds expired or sandbox asleep'));
    }, 25_000);
    conn.on('ready', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(conn); } });
    conn.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ssh failed: ' + e.message)); } });
    // Daytona gateway authenticates on the username token itself; password unused
    conn.connect({ host: 'ssh.app.daytona.io', port: 22, username: user, password: pass || 'daytona', readyTimeout: 20_000, keepaliveInterval: 15_000, keepaliveCountMax: 10 });
  });
}

function execStream(conn, cmd, timeoutMs, input) {
  return new Promise((resolve) => {
    let done = false, out = '', errbuf = '', kill = null;
    const finish = (code) => {
      if (done) return; done = true;
      if (kill) clearTimeout(kill);
      resolve({ code: code == null ? 0 : code, out: out.slice(-60_000), err: errbuf.slice(-20_000) });
    };
    conn.exec(cmd, (err, stream) => {
      if (err) { finish(-1); return; }
      kill = setTimeout(() => finish(124), timeoutMs);
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errbuf += d.toString(); });
      stream.on('close', (code) => finish(code));
      if (input) { stream.write(input); stream.end(); }
    });
  });
}

async function runJob(job, input) {
  const { user, tg_token, tg_chat, cf_acct, cf_token } = input;
  const log = (lv, msg) => job.logs.push({ lv, msg: String(msg).slice(0, 500), t: Date.now() });
  let conn = null;
  try {
    log('info', `ssh → ${user}@ssh.app.daytona.io …`);
    conn = await connectSSH(user);
    job.ssh_ok = true;
    log('ok', 'ssh connected — sandbox alive ✓');

    // 1. fast path: hermes already installed?
    const t = await execStream(conn, 'ls /opt/hv/bin/hermes 2>/dev/null && echo PRESENT || echo MISSING', 15_000);
    if (t.code === 0 && t.out.includes('PRESENT')) {
      job.hermes_preinstalled = true;
      log('ok', 'hermes already installed here ✓ (fast path)');
    } else {
      log('info', 'hermes not found — running installer (~4–8 min, live in your console)…');
      const boot = fs.readFileSync(new URL('../public/boot.sh', import.meta.url), 'utf8');
      const envs = [
        `export RELAY_BASE="${RELAY_BASE}"`,
        `export CF_ACCT="${cf_acct}"`,
        `export CF_TOKEN="${cf_token}"`,
        `export MODEL="${MODEL}"`,
        '',
      ].join('\n');
      const r = await execStream(conn, 'bash -s', BOOT_TIMEOUT, envs + boot + '\n');
      if (r.code !== 0 || !r.out.includes('BOOT-DONE')) {
        throw new Error('installer failed (code ' + r.code + '): ' + ((r.err || r.out) || 'no output').slice(-300));
      }
      log('ok', 'hermes installed ✓');
    }

    // 2. write config (always — also covers preinstalled sandboxes)
    const cfg =
      "mkdir -p /root/.hermes && cat > /root/.hermes/config.yaml << 'EOF'\n" +
      'model:\n  provider: custom\n  name: "' + MODEL + '"\n' +
      '  base_url: "' + RELAY_BASE + '/client/v4/accounts/' + cf_acct + '/ai/v1"\n' +
      '  api_key: "' + cf_token + '"\nEOF\n';
    const w = await execStream(conn, cfg, 15_000);
    if (w.code !== 0) throw new Error('config write failed: ' + (w.err || 'unknown').slice(-200));
    log('ok', 'hermes → GLM via relay configured ✓');

    // 3. AI smoke test (through the relay, from inside the sandbox)
    log('info', 'smoke test: hermes through relay…');
    const ai = await execStream(conn, 'timeout 90 hermes -z "Reply with exactly: OK" 2>&1 | tail -1', 100_000);
    const aiOut = (ai.out || '').trim();
    if (/OK/i.test(aiOut) && aiOut.length < 60) log('ok', 'AI round-trip ✓ (hermes said: ' + aiOut.slice(0, 40) + ')');
    else log('warn', 'smoke test unclear: "' + aiOut.slice(0, 80) + '" — continuing anyway');

    // 4. upload tg_poller.py (base64 → no quoting issues)
    log('info', 'uploading telegram poller…');
    const pollerSrc = fs.readFileSync(new URL('../public/tg_poller.py', import.meta.url), 'utf8');
    const b64 = Buffer.from(pollerSrc).toString('base64');
    const up = await execStream(conn,
      "echo '" + b64 + "' | base64 -d > /root/tg_poller.py && python3 -c \"import ast; ast.parse(open('/root/tg_poller.py').read())\" && echo UPLOADED-OK",
      30_000);
    if (!up.out.includes('UPLOADED-OK')) throw new Error('poller upload failed: ' + ((up.err || up.out) || '').slice(-200));
    log('ok', 'poller uploaded ✓');

    // 5. start poller (detached; survives this SSH session)
    log('info', 'starting poller…');
    const start = await execStream(conn,
      "pkill -f tg_poller.py 2>/dev/null; sleep 1; " +
      "TG_TOKEN='" + tg_token + "' TG_CHAT_ID='" + tg_chat + "' RELAY_BASE='" + RELAY_BASE + "' " +
      "nohup python3 /root/tg_poller.py > /root/tg_poller.log 2>&1 & " +
      "sleep 5; grep -q 'polling as' /root/tg_poller.log && echo POLLER-UP || tail -3 /root/tg_poller.log",
      40_000);
    if (!start.out.includes('POLLER-UP')) throw new Error('poller did not start: ' + ((start.err || start.out) || '').slice(-250));
    log('ok', 'poller running — your bot is LIVE ✓');

    // 6. notify the user on telegram (from the sandbox, via relay)
    log('info', 'sending telegram notification…');
    const notify = await execStream(conn,
      "TG_TOKEN='" + tg_token + "' TG_CHAT_ID='" + tg_chat + "' RELAY_BASE='" + RELAY_BASE + "' python3 - << 'PYEOF'\n" +
      "import os, json, urllib.request\n" +
      "req = urllib.request.Request(os.environ['RELAY_BASE'] + '/telegram/bot' + os.environ['TG_TOKEN'] + '/sendMessage', data=json.dumps({'chat_id': os.environ['TG_CHAT_ID'], 'text': 'Hermes is LIVE. Your Daytona sandbox is connected to this bot. Send me any message and I will reply.'}).encode(), headers={'Content-Type': 'application/json'})\n" +
      "try:\n    print('NOTIFY-OK' if json.loads(urllib.request.urlopen(req, timeout=20).read()).get('ok') else 'NOTIFY-FAIL')\n" +
      "except Exception as e:\n    print('NOTIFY-FAIL', e)\n" +
      "PYEOF",
      50_000);
    if (notify.out.includes('NOTIFY-OK')) log('ok', 'telegram notified — check your DM ✓');
    else log('warn', 'notification failed (bot itself still works — open it and say hi)');

    // 7. final version line
    const v = await execStream(conn, 'hermes --version 2>&1 | head -1', 15_000);
    if (v.out.trim()) log('ok', v.out.trim().slice(0, 80));

    job.state = 'done';
    log('ok', 'ALL DONE — go talk to your bot on Telegram 🚀');
  } catch (e) {
    job.state = 'failed';
    job.error = String((e && e.message) || e).slice(0, 400);
    job.logs.push({ lv: 'err', msg: 'FAILED: ' + job.error, t: Date.now() });
  } finally {
    try { if (conn) conn.end(); } catch {}
    job.finished = Date.now();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }

  let b = '';
  for await (const c of req) b += c;
  let body;
  try { body = JSON.parse(b); } catch { res.status(400).json({ ok: false, error: 'bad json' }); return; }

  if (body.action === 'start') {
    // parse "ssh USER@ssh.app.daytona.io ..." or bare USER@host
    let user = String(body.ssh || '').trim().replace(/^ssh\s+/, '');
    user = user.split(/\s+/)[0].replace(/[~@#].*$/, '').trim();
    const tg_token = String(body.tg_token || '').trim();
    const tg_chat = String(body.tg_chat || '').trim();
    const cf_acct = String(body.cf_acct || '').trim();
    const cf_token = String(body.cf_token || '').trim();

    if (!/^[A-Za-z0-9_-]{8,80}$/.test(user)) return res.status(400).json({ ok: false, error: 'ssh field must be user@host (Daytona style)' });
    if (!/^\d{6,}:[\w-]{30,}$/.test(tg_token)) return res.status(400).json({ ok: false, error: 'telegram token looks invalid (expect 123456:ABC-...)' });
    if (!/^-?\d{3,}$/.test(tg_chat)) return res.status(400).json({ ok: false, error: 'telegram chat id must be numeric' });
    if (!/^[0-9a-f]{32}$/.test(cf_acct)) return res.status(400).json({ ok: false, error: 'cloudflare account id must be 32 hex chars' });
    if (cf_token.length < 20) return res.status(400).json({ ok: false, error: 'cloudflare token looks too short' });

    const id = Math.random().toString(36).slice(2, 10);
    const job = { id, state: 'running', ssh_ok: false, hermes_preinstalled: false, started: Date.now(), logs: [{ lv: 'info', msg: 'job created', t: Date.now() }] };
    jobs.set(id, job);
    runJob(job, { user, tg_token, tg_chat, cf_acct, cf_token }); // fire & forget
    res.status(200).json({ ok: true, id });
    return;
  }

  if (body.action === 'poll') {
    const job = jobs.get(String(body.id || ''));
    if (!job) return res.status(404).json({ ok: false, error: 'unknown or expired job' });
    const cursor = Math.max(0, parseInt(body.cursor, 10) || 0);
    res.status(200).json({
      ok: true,
      state: job.state,
      ssh_ok: job.ssh_ok,
      hermes_preinstalled: job.hermes_preinstalled,
      new_lines: job.logs.slice(cursor).map((l) => ({ lv: l.lv, msg: l.msg })),
      next_cursor: job.logs.length,
      error: job.error || null,
    });
    return;
  }

  res.status(400).json({ ok: false, error: 'unknown action' });
}
