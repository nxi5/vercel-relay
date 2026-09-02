<div align="center">

# ⚡ hermes-relay

**Full Hermes Agent on any Daytona sandbox — installed, configured and wired to your Telegram bot in one click.**

Paste 5 fields. Get a private AI agent in a fresh cloud VM that answers you on Telegram.
No accounts here. No tokens stored. Nothing to install.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnxi5%2Fvercel-relay&project-name=hermes-relay)
[![Deploy status](https://github.com/nxi5/vercel-relay/actions/workflows/deploy.yml/badge.svg)](https://github.com/nxi5/vercel-relay/actions/workflows/deploy.yml)
[![Open in Codespaces](https://img.shields.io/badge/Open_in-Codespaces-blue?logo=github)](https://codespaces.new/nxi5/vercel-relay)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## What is this?

| Piece | What it does |
|---|---|
| 🚀 **Launcher** (`/`) | One page. Paste your Daytona SSH line, Telegram bot token, your chat ID and a Cloudflare AI token → it provisions everything live, with a real console |
| 🔀 **AI relay** (`/client/v4/...`) | Streaming passthrough to Cloudflare Workers AI — survives Daytona's SNI-filtered egress where direct `api.cloudflare.com` is impossible |
| 🤖 **Telegram relay** (`/telegram/bot...`) | Passthrough to `api.telegram.org` — the sandbox can't reach Telegram either, your deployment relays it |
| 🛠 **Provisioner** (`/api/provision`) | Real SSH (ssh2) into the sandbox: installs Hermes, writes config, uploads a poller, starts it, notifies you on Telegram |

```
 you (Telegram)  ⇄  your bot  ⇄  YOUR hermes-relay.vercel.app  ⇄  api.telegram.org
                                        │
                                        └─► /ai/v1  ⇄  api.cloudflare.com (Workers AI, GLM)
                                                     ▲
 your browser ── launcher ── ssh ──► Daytona sandbox: hermes + tg_poller.py
```

**Every deployment is self-contained.** Your copy relays through *your own* domain — the launcher
tells the provisioner its own origin, so sandboxes configured by *your* page use *your* relay.
No shared infrastructure, no hardcoded anything.

---

## 🚀 Quick start

### Option A — one click (recommended)

1. Hit the **Deploy with Vercel** button above (log in with GitHub, it clones + deploys in ~40s)
2. Open your new `https://your-project.vercel.app`
3. Fill the 5 fields → **LAUNCH**
4. Talk to your bot on Telegram

### Option B — CLI

```bash
git clone https://github.com/nxi5/vercel-relay.git && cd vercel-relay
npx vercel deploy --prod
```

### Option C — use the hosted instance

Open **https://vercel-relay-steel-nine-15.vercel.app** — same code, nothing stored.

---

## 📋 What you need (all free)

| # | Thing | Where to get it | ~Time |
|---|---|---|---|
| 1 | **Daytona sandbox SSH line** | [daytona.io](https://www.daytona.io) → create sandbox → **Connect → SSH**. Looks like `ssh AbCdEf123@ssh.app.daytona.io` | 1 min |
| 2 | **Telegram bot token** | [@BotFather](https://t.me/BotFather) → `/newbot` → copy token | 1 min |
| 3 | **Your chat ID** | Send any message to [@userinfobot](https://t.me/userinfobot) — it replies with your ID | 30 sec |
| 4 | **Cloudflare account ID** | [dash.cloudflare.com](https://dash.cloudflare.com) → right sidebar → Account ID (32 hex chars) | 30 sec |
| 5 | **Cloudflare API token** | [Create token](https://dash.cloudflare.com/profile/api-tokens) → template **"Edit Cloudflare Workers"** → scope it to Workers AI | 2 min |

> 💡 Cloudflare's free Workers AI tier covers ~10,000 neurons/day — thousands of Telegram messages.

---

## 🧠 How provisioning works

When you hit **LAUNCH**, the provisioner opens one SSH session to your sandbox and:

```
[01] ssh connect ..................... ✓ sandbox alive
[02] hermes installer ................ pip3 → uv → python 3.12 → hermes agent  (~4–8 min)
[03] config write .................... /root/.hermes/config.yaml → GLM via YOUR relay
[04] AI smoke test ................... hermes -z "Reply OK"  ✓ round-trip
[05] telegram poller upload .......... /root/tg_poller.py (ast-validated)
[06] poller start .................... long-poll getUpdates via your relay ✓
[07] telegram notify ................. "Hermes is LIVE" → your chat ✓
```

- Sandboxes with Hermes already installed skip straight to config (**fast path**)
- The poller is **yours-only**: hardcoded to your chat ID, everyone else is ignored
- Fresh sandbox? Creds expire ~60 min — just paste a fresh SSH line and relaunch; the fast
  path re-wires config in seconds

## 🔐 Security model

- **Nothing is stored.** Tokens live in job memory only (45-min TTL, then GC). No database, no logs, no cookies
- **Your secrets never leave the TLS session** except to the two places they belong: your sandbox (Hermes config) and Cloudflare/Telegram (auth headers)
- **Least-privilege**: the Cloudflare token only needs Workers AI permission; the Telegram bot only answers your chat ID
- **Least-privilege SSH**: the provisioner runs one installer + config; it doesn't touch anything else
- Scan the code yourself — zero tokens in the repo, deploy secrets live in GitHub Actions *encrypted secrets*

## ⚙️ Configuration (optional)

| Env | Default | Meaning |
|---|---|---|
| `RELAY_BASE` | *your deployment's own URL* | Override the relay domain sandboxes are pointed at |
| `MODEL` | `@cf/zai-org/glm-5.3-flash` | Any Workers AI model ID |

No env vars are required — deploys work with zero configuration.

## 🧪 Local development

```bash
npm install
npm run test     # 5 tests: token verify · GLM round-trip · streaming · tg 401 · tg 400
npx vercel dev   # local launcher at localhost:3000
```

## ❓ FAQ

<details>
<summary><b>Why does this need a relay at all?</b></summary>

Daytona sandboxes sit behind an SNI-whitelist egress filter: TLS to `api.cloudflare.com` and
`api.telegram.org` is killed by DPI, but `*.vercel.app` domains are allowed. A Vercel function
on an allowed domain that forwards bytes = full connectivity. See
[the DPI notes](docs/daytona-egress-dpi.md) for the full autopsy.
</details>

<details>
<summary><b>My sandbox died / SSH expired. Now what?</b></summary>

That's Daytona's ~60-minute credential lifecycle. Spin up a new sandbox, paste the fresh SSH
line, hit LAUNCH. If the old sandbox still has Hermes, the fast path finishes in seconds.
</details>

<details>
<summary><b>Can others talk to my bot?</b></summary>

No. The poller drops every message whose chat ID doesn't match yours.
</details>

<details>
<summary><b>Which models work?</b></summary>

Any Workers AI model ID — e.g. `@cf/zai-org/glm-5.3-flash` (default, reasoning),
`@cf/zai-org/glm-4.7-flash` (faster). Set via the `MODEL` env var.
</details>

<details>
<summary><b>Is running an agent on a Daytona sandbox allowed?</b></summary>

You're responsible for complying with Daytona's ToS. The egress relay exists because of
networking constraints, not to circumvent paid tiers — everything here runs on free plans.
</details>

## 📁 Project layout

```
api/relay.js        → streaming AI passthrough (?up= rewrite contract)
api/telegram.js     → telegram passthrough (/telegram/bot<TOKEN>/<method>)
api/provision.js    → ssh2 provisioner (start/poll job API)
public/index.html   → launcher UI with live console
public/boot.sh      → sandbox installer (pip3→uv→py3.12→hermes)
public/tg_poller.py → telegram ⇄ hermes bridge (runs in sandbox)
test_local.mjs      → 5-test suite (npm run test)
.github/workflows/  → push-to-main = production deploy
```

---

<div align="center">

**MIT License** · built by [nxi5](https://github.com/nxi5) ·
Hermes Agent by [Nous Research](https://nousresearch.com)

</div>
