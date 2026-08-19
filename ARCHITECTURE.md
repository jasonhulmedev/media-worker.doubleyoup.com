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
                         │       yes → key = path; slug = path[0]    │
                         │       no  → HOSTMAP.get(host) -> slug     │
                         │             (404 if no mapping)           │
                         │             key = "<slug>/" + path        │
                         │       validate slug; buckets =           │
                         │         1. "doubleyoup-media-<slug>"      │
                         │         2. MEDIA_BUCKET (shared, only     │
                         │            on a 404/401/403 from #1)      │
                         └───────────────┬───────────────────────────┘
                                         │ 4. SigV4-signed S3 GET/HEAD (Range +
                                         │    If-* forwarded AND signed) — once
                                         │    per attempted bucket
                                         ▼
                              ┌───────────────────────────────┐
                              │ R2 account S3 endpoint →       │
                              │ doubleyoup-media-<slug>, else  │
                              │ shared bucket (path-style)     │
                              └──────────┬────────────────────┘
                                         │ 5. HTTP response (200/206/304/412/404)
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
4. **R2 read (per-site bucket via SigV4, shared bucket as fallback)** — the slug is
   validated (`^[a-z0-9-]{1,46}$`), the primary bucket derived as
   `doubleyoup-media-<slug>`, and the object read with a **SigV4-signed S3 GET/HEAD**
   against the account S3 endpoint
   (`<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`, path-style, region
   `auto`, service `s3`) using one account-scoped, Object-Read-ONLY R2 credential
   (Worker secrets `R2_S3_KEY`/`R2_S3_SECRET`). The client's
   `Range`/`If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`
   headers are both forwarded to R2 AND included in the signature (R2 can reject
   response-affecting headers that arrive unsigned), so R2 applies the HTTP
   conditional/range semantics itself. There is **no static R2 binding**.

   If the primary answers **404** (bucket/object not migrated yet) or **401/403** (the
   read credential can't see that bucket — the state while the key is still
   bucket-scoped), the identical signed request is replayed against the **shared
   fallback bucket** (`MEDIA_BUCKET`, default `doubleyoup-media`); the two buckets use
   the same `<slug>/<path>` key, so sites can be migrated one at a time with no Worker
   deploy. Every other primary status — including 5xx — is returned as-is so a real
   upstream failure is never masked. The fallback's own response is not
   re-interpreted, so a 401/403 from it becomes a 500 rather than a cached 404. Cost
   of the fallback is one extra R2 round-trip per Worker-reaching request for an
   unmigrated site (a per-slug "migrated" flag in KV would remove it; not built).

   Two `console.warn` lines make the fallback observable in `wrangler tail`, since a
   fallback 404 is otherwise indistinguishable from a missing object:
   `fallback-auth-denied` (primary returned 401/403 — a broken per-site read credential
   masked by the shared bucket) and `not-found-in-both-buckets` (primary 404 + fallback
   404). Nothing is logged on primary-200 or on primary-404 → fallback-200.
5. **Response assembly** — R2's HTTP status (from whichever bucket answered last) is
   mapped straight back: `404` (`NoSuchKey`/`NoSuchBucket` in both buckets) → 404;
   `304`/`412` → that status with no body;
   `206` → 206 re-emitting `Content-Range`/`Content-Length`; `200` → full body;
   any other status (403 bad creds, 5xx) → a generic 500 (no upstream body/detail
   leaked). Every response gets `access-control-allow-origin: *`, an `etag`, a
   `content-type` (from R2's stored content-type or a fallback table keyed on file
   extension), and a `cache-control` (upstream's, else `public, max-age=31536000,
   immutable` on a hit, `public, max-age=60` on a 404).

Every path is wrapped in a top-level try/catch that returns a bare 500 —
`fetch()` never throws and never leaks internals to the client.

## Bindings

| Binding          | Type          | Source of truth                                                    |
| ---------------- | ------------- | -------------------------------------------------------------------- |
| `R2_S3_KEY` / `R2_S3_SECRET` | Worker secrets | one **account-scoped, Object-Read-ONLY** R2 S3 credential used to SigV4-sign reads of the shared bucket AND every per-site `doubleyoup-media-<slug>` bucket. Never held in a tenant container (that's the per-site *write* credential, which is bucket-scoped). Set via `wrangler secret put`. **Must be account-scoped before the first per-site bucket goes live** — the currently deployed key is bucket-scoped to the shared bucket, which the fallback tolerates but a migrated site does not. |
| `R2_ACCOUNT_ID`  | plaintext var | the Cloudflare account id in the R2 S3 endpoint host `<id>.r2.cloudflarestorage.com` (not secret) |
| `HOSTMAP`        | KV namespace  | `hostname -> slug`; written by `orchestrator.doubleyoup.com`'s domain automation when a branded media host is onboarded (or manually via `wrangler kv key put`) |
| `SHARED_HOST`    | plaintext var | the one host treated as "path already has the slug" (`media.doubleyoup.com`) |
| `MEDIA_BUCKET`   | plaintext var | the **fallback** (shared/legacy) bucket tried when the per-site bucket 404/401/403s; defaults to `doubleyoup-media`. Never overrides the per-site primary. |

There is **no static R2 binding** — each site's media lives in its own bucket
`doubleyoup-media-<slug>` (H1 per-site isolation), derived from the resolved slug
and read over the account S3 endpoint, with the shared bucket as the fallback until
that site is migrated. Each site's `doubleyoup-media` mu-plugin writes its own bucket
with a bucket-scoped credential; this Worker only reads.

## Where this sits in the platform

This Worker is the read side of a write path owned entirely elsewhere:

- **Writer**: each WordPress site's `doubleyoup-media` mu-plugin signs and
  PUTs media objects directly into its own `doubleyoup-media-<slug>` R2 bucket
  under `<slug>/<path>` (hand-rolled SigV4 — no Worker involved in the write),
  using a per-site, bucket-scoped write credential so a leak is contained to one
  tenant.
- **Onboarding a branded host**: `orchestrator.doubleyoup.com` registers the
  Cloudflare custom hostname (Cloudflare for SaaS / TLS) and writes the
  `HOSTMAP` KV entry as part of site/domain setup. This Worker never talks to
  `orchestrator` or `app` at request time — `HOSTMAP` is the only coupling,
  and it's asynchronous (KV write happens once, ahead of any request).
- **Shared host (target state)**: this Worker is built to serve
  `media.doubleyoup.com` too (deriving the bucket from the path's first segment).
  Routing the shared host onto this Worker is a **gated deploy step** (Jason): it
  requires re-pointing `media.doubleyoup.com` off its current direct-R2-custom-
  domain binding, plus the account-scoped read credential. The per-site buckets no
  longer have to exist first — the fallback serves unmigrated slugs from the shared
  bucket. Until then the shared host keeps serving the single legacy bucket directly
  and only branded per-customer hostnames route here.

## Statelessness

No database, no in-memory state across requests — every request is fully
resolved from the incoming `Host`/path plus a single KV read (branded hosts
only) and a single R2 read. Nothing here persists between invocations except
whatever Cloudflare's own edge cache does independently of this code.
