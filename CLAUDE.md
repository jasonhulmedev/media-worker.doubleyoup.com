# media-worker.doubleyoup.com — agent working guide

Cloudflare Worker serving each site's own `doubleyoup-media-<slug>` R2 bucket for
the shared host and branded per-site hostnames, with a fallback to the shared legacy
bucket for sites not migrated yet. No static R2 binding — the bucket names are
derived from the resolved slug and read with a SigV4-signed S3 GET using one
account-scoped, Object-Read-ONLY R2 credential (Worker secrets). No DB, no queue,
no other services called — read `README.md` first for bindings/deploy; this file
is gotchas + conventions.

## Commands

```
npm install
npm test             # node --test (built-in runner, no framework) — src/index.js unit + handler tests
npm run dev          # wrangler dev — local R2/KV emulation (--remote for real bucket/namespace)
npm run deploy       # wrangler deploy
npm run tail         # wrangler tail — live log from the deployed Worker
```

No build step, no typecheck. Verify changes with `npm test` + `node --check
src/index.js`, then `wrangler dev` against a local or `--remote` bucket, curling
shared-host and branded-host requests (see "Structure" below for how to fake a
branded host locally). `npx wrangler deploy --dry-run --outdir=<tmp>` bundles
without deploying.

## Structure — what matters

This is effectively a one-file Worker:

- `src/index.js` — the entire Worker: method/path/host parsing, KV lookup for
  branded hosts, slug validation + `doubleyoup-media-<slug>` derivation, the
  primary→fallback bucket attempt order, the hand-rolled SigV4 signer + S3 GET/HEAD,
  response header assembly (content-type fallback by extension, conditional/range
  forward-and-sign, CORS, cache-control). It also has two named exports,
  `bucketAttemptOrder` / `shouldFallbackToSharedBucket`, purely so the bucket
  decision is unit-testable — Cloudflare ignores named exports that aren't
  entrypoint classes, so adding more for testing is safe.
- `wrangler.toml` — the `HOSTMAP` KV binding + `SHARED_HOST`/`MEDIA_BUCKET` vars +
  the `R2_ACCOUNT_ID`/`R2_S3_KEY`/`R2_S3_SECRET` read-credential secrets (set via
  `wrangler secret put`, not in the toml) + deploy steps in the header comment.
  No R2 binding.
- `test/` — `node:test` files run by `npm test`: `bucket-selection.test.js` (the two
  pure functions) and `fallback-flow.test.js` (the real handler with `globalThis.fetch`
  stubbed in place of the R2 S3 endpoint). No framework, no network, no credentials.
- `package.json` — the wrangler scripts + `test`; `"type": "module"` so plain `node`
  loads the ESM source. Only devDependency is wrangler.

## Conventions actually used here

- **Two bucket attempts per request, primary always first.** `doubleyoup-media-<slug>`
  is tried first; the shared bucket (`MEDIA_BUCKET`, default `doubleyoup-media`) is
  tried ONLY if the primary returned 404/401/403. `MEDIA_BUCKET` is the FALLBACK name —
  it used to pin every slug to the shared bucket, and code/docs written before that
  change may still describe it that way. Never let it override the primary.
- **Only 404/401/403 fall through, and only from the primary.** 5xx from the primary
  must propagate (never mask a real outage with a second lookup that could 404), and
  the fallback's response is passed to `buildClientResponse` untouched so a 401/403
  there surfaces as a 500 rather than a 60s-cached 404.
- **The fallback path logs; the happy paths don't.** Two `console.warn` lines exist
  because a fallback 404 is otherwise indistinguishable from "object missing":
  `fallback-auth-denied` (primary answered 401/403 — the alarm for a broken per-site
  read credential being masked by the shared bucket) and `not-found-in-both-buckets`
  (primary 404 + fallback 404). Keep both silent on primary-200 and on
  primary-404 → fallback-200, which is every request from an unmigrated site.

- **R2 key scheme is always `<slug>/<path>`, never anything else.** Shared-host
  requests already have the slug as the path's first segment (key = raw path);
  branded-host requests get the slug prepended after a `HOSTMAP` lookup. Don't
  add a third key shape — every consumer of this bucket (the `doubleyoup-media`
  mu-plugin, the orchestrator) assumes this scheme.
- **Conditional requests and `Range` are not hand-parsed.** The client's
  `Range`/`If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`
  headers are forwarded on the upstream S3 GET **and included in the SigV4
  signature** — R2 can reject response-affecting headers that arrive unsigned, so
  they must be signed, not sent unsigned. R2 then applies the HTTP semantics and
  returns the 200/206/304/412 this Worker maps straight back. Don't reimplement
  that parsing here, and don't forward those headers unsigned.
- **`fetch()` never throws.** The whole handler is wrapped in try/catch that
  returns a generic 500 with no internals leaked (no stack traces, no R2/KV
  error detail). Keep new code inside that boundary or wrapped the same way.
- **Every response carries permissive CORS** (`access-control-allow-origin: *`),
  including 404/405/400/500 — so a broken `<img>`/`<video>` src fails as a
  clean HTTP error in devtools rather than an opaque CORS error. Don't scope
  CORS down without checking this reasoning first.
- Content-type is read from the S3 response's `content-type` first;
  `EXT_CONTENT_TYPES` in `src/index.js` is only a fallback for objects stored
  without a content-type.

## Gotchas

- **The deployed read credential is BUCKET-scoped to the shared bucket today**, so every
  per-site (primary) lookup in prod is currently an auth denial absorbed by the fallback.
  That is fine while nothing is migrated, but a site migrated into its own bucket will
  404 until an ACCOUNT-scoped Object-Read-only R2 token is `wrangler secret put` over
  `R2_S3_KEY`/`R2_S3_SECRET`. Check this first when a migrated site serves 404/500.
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
- **`wrangler.toml`'s `id = "REPLACE_WITH_KV_ID"` and `R2_ACCOUNT_ID =
  "REPLACE_WITH_R2_ACCOUNT_ID"` are real placeholders**, not filled in per-account
  — a fresh clone/fresh Cloudflare account needs `wrangler kv namespace create
  HOSTMAP` run once (id pasted in), `R2_ACCOUNT_ID` set, and `wrangler secret put
  R2_S3_KEY` / `R2_S3_SECRET` before `wrangler deploy` (or `dev --remote`) works.
- **The shared host `media.doubleyoup.com` is NOT yet routed through this Worker.**
  The code targets the end state where it is (deriving the bucket from the path's
  first segment), but re-pointing `media.doubleyoup.com` off its current
  direct-R2-custom-domain binding onto this Worker is a **gated deploy step**
  (Jason). It no longer requires the per-site buckets to exist first — the
  shared-bucket fallback serves unmigrated slugs — but it does require the
  account-scoped read credential. Until that flip, only branded `media.<customer>`
  hostnames route here and the shared host serves the single legacy bucket
  directly. Do not assume the shared host hits this Worker in prod today.
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
- Don't hand-parse `If-*`/`Range` headers — forward them on the upstream S3 GET
  AND include them in the SigV4 signature (unsigned response-affecting headers can
  be rejected by R2); let R2 apply the semantics.
- Don't flip `media.doubleyoup.com` onto this Worker yourself — that re-route (off
  its direct-R2-custom-domain binding) plus the per-site buckets existing are
  gated prerequisites owned by Jason; the code is built for that end state but the
  zone change is not part of a code deploy.
