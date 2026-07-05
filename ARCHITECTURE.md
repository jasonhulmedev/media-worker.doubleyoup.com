# media-worker architecture

## Flow

```
                         ┌─────────────────────────────────────────┐
  browser/app request    │        media-worker (Cloudflare Worker)  │        R2
 ───────────────────────►│                                           │
  GET/HEAD <host>/<path> │  1. method check (405 if not GET/HEAD)   │
                         │  2. decode + normalize path              │
                         │     (400 on bad %-encoding,              │
                         │      404 on ".." segment)                │
                         │                                           │
                         │  3. host === SHARED_HOST ?                │
                         │       yes → key = path                   │
                         │       no  → HOSTMAP.get(host) -> slug     │
                         │             (404 if no mapping)           │
                         │             key = "<slug>/" + path        │
                         └───────────────┬───────────────────────────┘
                                         │ 4. BUCKET.get(key, {onlyIf, range})
                                         ▼
                              ┌────────────────────┐
                              │ R2: doubleyoup-media│
                              └──────────┬──────────┘
                                         │ 5. R2Object | R2ObjectBody | null
                                         ▼
                         ┌─────────────────────────────────────────┐
                         │  build response:                        │
                         │   - null            -> 404               │
                         │   - metadata only   -> 304 / 412          │
                         │     (failed onlyIf)   (If-None-Match vs   │
                         │                        other precondition)│
                         │   - obj.range set   -> 206 + Content-Range│
                         │   - else            -> 200                │
                         │  always: CORS *, etag, content-type       │
                         │  (stored or extension fallback),          │
                         │  cache-control (immutable hit / 60s 404)  │
                         └─────────────────────────────────────────┘
```

1. **Method gate** — only `GET`/`HEAD`; anything else is a 405.
2. **Path normalization** — `decodeURIComponent` + strip leading slashes; a
   `..` segment anywhere in the path is rejected as a 404 (defense-in-depth;
   R2 keys are opaque strings and can't actually traverse).
3. **Host routing** — exactly two shapes, decided by comparing the lowercased
   `Host` against `SHARED_HOST`:
   - **shared** (`media.doubleyoup.com`): the path's first segment is already
     the slug, so the R2 key is the path unchanged.
   - **branded** (any other host, attached via Cloudflare for SaaS): look the
     host up in the `HOSTMAP` KV namespace to get a slug; no entry is a 404.
     The key becomes `<slug>/<path>`.
4. **R2 read** — `env.BUCKET.get(key, { onlyIf: request.headers, range:
   request.headers })`. Passing the raw `Headers` object lets R2 itself parse
   `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`/`Range`
   — this Worker does none of that parsing by hand.
5. **Response assembly** — `null` → 404. A precondition failure returns only
   metadata (no `body` in the result): treated as 304 if the client sent
   `If-None-Match` (browser revalidation), else a genuine 412. A satisfied
   range request returns 206 with `Content-Range`/`Content-Length` computed
   from `obj.range`. Otherwise 200 with the full body. Every response gets
   `access-control-allow-origin: *`, an `etag`, a `content-type` (from R2's
   stored `httpMetadata` or a fallback table keyed on file extension), and a
   `cache-control` (`public, max-age=31536000, immutable` on a hit, `public,
   max-age=60` on a 404).

Every path is wrapped in a top-level try/catch that returns a bare 500 —
`fetch()` never throws and never leaks internals to the client.

## Bindings

| Binding       | Type         | Source of truth                                                    |
| ------------- | ------------ | -------------------------------------------------------------------- |
| `BUCKET`      | R2 bucket    | `doubleyoup-media` — written by the `doubleyoup-media` mu-plugin's SigV4 upload path on every site; this Worker only reads it |
| `HOSTMAP`     | KV namespace | `hostname -> slug`; written by `orchestrator.doubleyoup.com`'s domain automation when a branded media host is onboarded (or manually via `wrangler kv key put`) |
| `SHARED_HOST` | plaintext var| the one host treated as "path already has the slug" (`media.doubleyoup.com`) |

## Where this sits in the platform

This Worker is the read side of a write path owned entirely elsewhere:

- **Writer**: each WordPress site's `doubleyoup-media` mu-plugin signs and
  PUTs media objects directly into the `doubleyoup-media` R2 bucket under
  `<slug>/<path>` (hand-rolled SigV4 — no Worker involved in the write).
- **Onboarding a branded host**: `orchestrator.doubleyoup.com` registers the
  Cloudflare custom hostname (Cloudflare for SaaS / TLS) and writes the
  `HOSTMAP` KV entry as part of site/domain setup. This Worker never talks to
  `orchestrator` or `app` at request time — `HOSTMAP` is the only coupling,
  and it's asynchronous (KV write happens once, ahead of any request).
- **Shared host caveat**: `media.doubleyoup.com` is a direct R2 custom domain,
  not routed through this Worker — see `wrangler.toml`'s header comment. Only
  branded per-customer hostnames route here.

## Statelessness

No database, no in-memory state across requests — every request is fully
resolved from the incoming `Host`/path plus a single KV read (branded hosts
only) and a single R2 read. Nothing here persists between invocations except
whatever Cloudflare's own edge cache does independently of this code.
