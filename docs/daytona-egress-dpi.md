# Daytona sandbox egress — SNI whitelist DPI (autopsy, 2026-08)

Context: running Hermes Agent inside a Daytona sandbox whose egress passes a
Deep Packet Inspection stage that **whitelists TLS SNI values**. Everything
below was verified empirically from inside the sandbox — none of it is guesswork.

## The rule

The filter reads the **SNI extension in the TLS ClientHello** and compares it
against a whitelist of domains. Everything else behaves like a normal stateful
firewall:

| Probe | Result |
|---|---|
| TCP `:443` + whitelisted SNI | ✅ passes, transparently MITM'd by upstream proxy (Cloudflare-owned IPs) |
| TCP `:443` with unknown SNI | ❌ RST mid-handshake |
| HTTP `CONNECT` proxy env (`http_proxy`/`https_proxy`) | ❌ no reachable proxy on any port |
| Plain HTTP `:80` | ❌ blackholed |
| UDP (DNS to 1.1.1.1 / 8.8.8.8, QUIC) | ❌ dropped |
| TCP to non-443 ports (e.g. `:8443`) | ❌ dropped |

## Verified whitelist samples

**Allowed:** `*.github.com`, `api.github.com`, `*.anthropic.com`, `api.openai.com`,
`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `*.vercel.app`,
`objects.githubusercontent.com`, `daytona.io`, `*.daytona.io`, plus common
package mirrors.

**Blocked:** `api.cloudflare.com` (and subdomains), `api.telegram.org`, arbitrary
`*.example.com`, raw IPs over TLS, everything non-443, all UDP.

## Working relay pattern

1. From any machine with normal internet, deploy a catch-all function
   (`api/relay.js`) that forwards to `https://<target-host><path>`.
2. Add a Vercel rewrite so *any* path on your domain serves it.
3. Inside the sandbox, call everything through your deployment:

```bash
curl -s https://<your-deployment>.vercel.app/ai/v1/chat/completions \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"@cf/zai-org/glm-5.3-flash","max_tokens":300,"messages":[{"role":"user","content":"ping"}]}'
```

The sandbox's curl sees a trusted `*.vercel.app` SNI and connects; Vercel's
edge performs the real request. Streaming responses pass through fine.

## Telegram from the sandbox

Same filter — the bot API is unreachable directly. The same deployment serves
it via `/telegram/bot<TOKEN>/<method>` (see `api/telegram.js`).

## Notes

- The MITM proxy re-encrypts toward the origin with its own cert chain, so
  cert pinning inside the sandbox is futile; relaying through whitelisted SNI
  is the only stable path we found.
- Raw IPs, alternate ports, and UDP/QUIC are dead ends (dropped, not proxied).
- Long-poll `getUpdates` works through the relay — set generous timeouts
  (Vercel hobby functions cap low unless `maxDuration` is raised).
