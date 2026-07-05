# media-worker.doubleyoup.com — agent working guide

Cloudflare Worker serving the `doubleyoup-media` R2 bucket for the shared host
and branded per-site hostnames. No DB, no queue, no other services called —
read `README.md` first for bindings/deploy; this file is gotchas + conventions.

## Commands

```
npm install
npm run dev          # wrangler dev — local R2/KV emulation (--remote for real bucket/namespace)
npm run deploy       # wrangler deploy
npm run tail         # wrangler tail — live log from the deployed Worker
```

No build step, no typecheck, no test suite. Verify changes with `wrangler dev`
against a local or `--remote` bucket and curling shared-host and branded-host
requests (see "Structure" below for how to fake a branded host locally).

## Structure — what matters

This is effectively a one-file Worker:

- `src/index.js` — the entire Worker: method/path/host parsing, KV lookup for
  branded hosts, R2 `get`, response header assembly (content-type fallback by
  extension, conditional/range passthrough, CORS, cache-control).
- `wrangler.toml` — bindings (`BUCKET`, `HOSTMAP`) + the `SHARED_HOST` var +
  deploy steps in the header comment.
- `package.json` — just the three wrangler scripts; no other dependencies.

## Conventions actually used here

- **R2 key scheme is always `<slug>/<path>`, never anything else.** Shared-host
  requests already have the slug as the path's first segment (key = raw path);
  branded-host requests get the slug prepended after a `HOSTMAP` lookup. Don't
  add a third key shape — every consumer of this bucket (the `doubleyoup-media`
  mu-plugin, the orchestrator) assumes this scheme.
- **Conditional requests and `Range` are not hand-parsed.** `request.headers` is
  passed straight through to `env.BUCKET.get()` as both `onlyIf` and `range` —
  R2 accepts `R2Conditional | Headers` / `R2Range | Headers` and parses
  If-Match/If-None-Match/If-Modified-Since/If-Unmodified-Since/Range itself.
  Don't reimplement that parsing in this Worker.
- **`fetch()` never throws.** The whole handler is wrapped in try/catch that
  returns a generic 500 with no internals leaked (no stack traces, no R2/KV
  error detail). Keep new code inside that boundary or wrapped the same way.
- **Every response carries permissive CORS** (`access-control-allow-origin: *`),
  including 404/405/400/500 — so a broken `<img>`/`<video>` src fails as a
  clean HTTP error in devtools rather than an opaque CORS error. Don't scope
  CORS down without checking this reasoning first.
- Content-type is read from R2's stored `httpMetadata.contentType` first;
  `EXT_CONTENT_TYPES` in `src/index.js` is only a fallback for objects stored
  without that metadata (i.e. `writeHttpMetadata` left it unset).

## Gotchas

- **This is a Cloudflare Worker, not a Node service.** No `server.mjs`/Express,
  no constellation container, no `infra/constellation` entry, no BullMQ, no
  outbound HTTP to `app`/`orchestrator`. Don't try to run this like the other
  doubleyoup services (`npm start`, dev-boot scripts, etc.) — `wrangler dev` /
  `wrangler deploy` are the only two ways this code runs.
- **Branded hosts return a bare 404 if `HOSTMAP` has no entry** — there's no
  distinction in the response between "unknown host" and "unknown path" once a
  host resolves to a slug. If a customer domain serves 404s for everything,
  check `wrangler kv key get --binding=HOSTMAP <hostname>` before assuming a
  content/R2 problem.
- **`wrangler.toml`'s `id = "REPLACE_WITH_KV_ID"` is a real placeholder**, not
  filled in per-account — a fresh clone/fresh Cloudflare account needs
  `wrangler kv namespace create HOSTMAP` run once and the id pasted in before
  `wrangler dev --remote` or `wrangler deploy` will work.
- **Shared host and branded hosts must never both point at this Worker for the
  same hostname.** `media.doubleyoup.com` is deliberately routed as a direct R2
  custom domain, not through this Worker — routing it here too would double up
  and is called out explicitly in `wrangler.toml`'s header comment. Only branded
  `media.<customer>` hostnames (via Cloudflare for SaaS) should route to this
  Worker.
- **`SHARED_HOST` is compared case-insensitively** (`url.hostname.toLowerCase()`
  vs `(env.SHARED_HOST || "media.doubleyoup.com").toLowerCase()`) — if you ever
  need multiple shared hosts, this single-var comparison won't extend cleanly;
  that's a real limitation, not a bug to "fix" without discussion.
- **`..` path segments are rejected outright** even though R2 keys are opaque
  strings that can't actually traverse a "directory" — this is defense-in-depth
  only, not a functional necessity. Don't remove it as dead code.

## Do NOT

- Don't add a database, queue, or any outbound call to another doubleyoup
  service from this Worker — it is a pure R2/KV read path with zero
  dependencies on `app`/`orchestrator` at request time (onboarding writes the
  `HOSTMAP` entry out-of-band, not this Worker).
- Don't change the R2 key scheme (`<slug>/<path>`) without checking every
  writer of the bucket (the `doubleyoup-media` mu-plugin's SigV4 upload path)
  in lockstep.
- Don't hand-parse `If-*`/`Range` headers — pass them through to R2 as-is.
- Don't route `media.doubleyoup.com` through this Worker's Cloudflare for SaaS
  config — it stays a direct R2 custom domain.
