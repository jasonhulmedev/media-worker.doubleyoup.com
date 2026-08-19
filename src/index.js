// doubleyoup media Worker — serves site media from PER-SITE R2 buckets for BOTH
// the shared host (media.doubleyoup.com/<slug>/…) and branded customer hostnames
// (media.<theirdomain>/… via Cloudflare for SaaS). One R2 object per file; the
// public URL differs, the R2 key does not.
//
// Slug + key resolution (UNCHANGED from the single-bucket era):
//   • shared host (SHARED_HOST): the slug is the first path segment — key = path.
//   • branded host: look the Host up in KV (HOSTMAP: hostname -> slug) and prepend
//     the slug — key = "<slug>/" + path.
//
// Bucket resolution (TWO ATTEMPTS, per-site first): each site gets its OWN R2 bucket
//   "doubleyoup-media-<slug>" (H1 per-site isolation), but sites are migrated into those
// buckets ONE AT A TIME, so this Worker has to serve both models simultaneously:
//   1. PRIMARY   — "doubleyoup-media-<slug>", always tried first.
//   2. FALLBACK  — the shared legacy bucket (env.MEDIA_BUCKET, default
//      "doubleyoup-media"), tried ONLY when the primary answered one of
//      FALLBACK_TRIGGER_STATUSES (404 = bucket/object not migrated yet; 401/403 = the
//      read credential can't see the per-site bucket yet).
// Any other primary status (200/206/304/412, or a 5xx) is returned as-is — a real
// upstream failure must never be masked by a second lookup. The <slug>/<path> KEY
// scheme is identical in both buckets, so a request resolves the same object whichever
// bucket answers, and a site can be migrated with no Worker deploy.
//
// There is no static R2 binding: the bucket names are derived per request and read with
// a SigV4-signed S3 GET against the account S3 endpoint using ONE Object-Read-ONLY R2
// credential held as a Worker secret. A leaked/compromised per-site WRITE credential can
// therefore only touch that one tenant's bucket, while this read path stays
// single-credential.
//
// PREREQUISITES before this Worker is live (Jason / migration, gated — NOT done here):
//   1. The Worker secrets R2_S3_KEY / R2_S3_SECRET and the R2_ACCOUNT_ID var must be set.
//      That credential must become ACCOUNT-scoped (Object Read only) before the first
//      per-site bucket goes live: today's deployed key is BUCKET-scoped to the shared
//      bucket, which makes every primary (per-site) lookup an auth denial. The fallback
//      keeps those sites serving, but a migrated site cannot be read until the key is
//      swapped.
//   2. The per-site buckets "doubleyoup-media-<slug>" must exist and hold the migrated
//      objects (Phase 2 provisioning + Phase 3 migration) — per site, not all at once.
//   3. media.doubleyoup.com must be RE-ROUTED off its current direct-R2-custom-domain
//      binding and onto this Worker (a zone change; per-slug flippable during migration).
//   This file targets that end state; it does NOT implement the shared-host-vs-Worker
//   routing transition — that is a per-slug deploy/re-route step, not Worker logic.
//
// Conditional requests + Range: the client's Range / If-* headers are forwarded to
// R2 AND included in the SigV4 signature (R2 can reject headers that affect the
// response if they arrive unsigned), so R2 itself applies the HTTP semantics and
// returns the 200/206/304/412 we map straight back to the client.

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NOT_FOUND_CACHE = "public, max-age=60"; // small + cacheable, so a bad/unknown
// path or host doesn't hammer KV/R2 on every repeat request.
const ALLOWED_METHODS = "GET, HEAD";
const EXPOSED_HEADERS = "content-length, content-range, etag, accept-ranges";

// A slug becomes part of an R2 bucket name ("doubleyoup-media-<slug>") that this
// Worker fetches with the account read credential — validate its charset before
// trusting it, whether it came from the path (shared host) or KV (branded host).
// Mirrors the platform's slug rules (lowercase alnum + hyphen); also keeps the
// resulting bucket name inside R2's naming constraints. Capped at 46 so the derived
// bucket "doubleyoup-media-<slug>" (17-char prefix + slug) stays within R2's 63-char
// bucket-name limit; this matches app's uniqueSlug cap (<=46 chars).
const SLUG_PATTERN = /^[a-z0-9-]{1,46}$/;

// ── Bucket selection (per-site primary, shared-bucket fallback) ───────────────

// The single legacy bucket every site's media lived in before per-site buckets.
// Overridable with the MEDIA_BUCKET var purely so a non-prod account can point the
// fallback somewhere else; it is NOT a pin any more (it used to be one).
const DEFAULT_SHARED_BUCKET = "doubleyoup-media";

// Statuses from the PRIMARY (per-site) bucket that mean "this site may not be migrated
// yet — go ask the shared bucket":
//   • 404 — NoSuchBucket (bucket not provisioned) or NoSuchKey (object not migrated).
//   • 401/403 — the read credential cannot see that bucket. This matters during the
//     credential transition: today's deployed read key is BUCKET-scoped to the shared
//     bucket, so probing a foreign bucket is an auth denial (R2 answers 403 for a
//     bucket-scoped key hitting another bucket, and NoSuchBucket-style 404s in some
//     paths — both are covered here). Treating auth denial on the PRIMARY as
//     fall-through keeps every unmigrated site serving until the account-scoped
//     Object-Read-only key is in place.
// Deliberately NOT here: 5xx and every success status. A real upstream failure must
// surface, not be masked by a second lookup that might 404.
const FALLBACK_TRIGGER_STATUSES = new Set([401, 403, 404]);

// Which buckets to try, in order, for a resolved slug. Exported (with
// shouldFallbackToSharedBucket) so the attempt-order decision is unit-testable without
// a Workers runtime — Cloudflare ignores named exports other than the default handler.
export function bucketAttemptOrder(slug, env) {
  const perSiteBucket = `doubleyoup-media-${slug}`;
  const sharedBucket = env.MEDIA_BUCKET || DEFAULT_SHARED_BUCKET;

  // Only possible with a deliberately odd MEDIA_BUCKET, but never pay for the same
  // upstream request twice.
  if (perSiteBucket === sharedBucket) return [perSiteBucket];

  return [perSiteBucket, sharedBucket];
}

// Only ever asked about the PRIMARY attempt's status — a fallback response is handed
// to buildClientResponse as-is, so a 401/403 from the shared bucket stays a visible
// 500 (broken credential) instead of quietly becoming a cached 404.
export function shouldFallbackToSharedBucket(primaryStatus) {
  return FALLBACK_TRIGGER_STATUSES.has(primaryStatus);
}

// The R2 S3 endpoint uses SigV4 with region "auto" and service "s3" (path-style),
// exactly matching the doubleyoup-media mu-plugin's proven write-side signer.
const R2_REGION = "auto";
const R2_SERVICE = "s3";

// Range/conditional request headers we forward-and-sign. Kept sorted here for
// readability; the signer sorts the full signed set again regardless.
const CONDITIONAL_HEADER_NAMES = [
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
];

// Fallback Content-Type by file extension — only used when the R2 object was
// stored without a content-type (the mu-plugin always sets one, but migrated /
// hand-uploaded objects may not).
const EXT_CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

const textEncoder = new TextEncoder();

function contentTypeForKey(key) {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = key.slice(dot + 1).toLowerCase();
  return EXT_CONTENT_TYPES[ext] || "application/octet-stream";
}

// Media is public, static, cross-origin-embeddable content — permissive read
// CORS on every response (including errors, so a broken <img>/<video> src
// fails with a clean 404 rather than an opaque CORS error in the console).
function baseHeaders() {
  return new Headers({ "access-control-allow-origin": "*" });
}

function notFound(method) {
  const headers = baseHeaders();
  headers.set("cache-control", NOT_FOUND_CACHE);
  return new Response(method === "HEAD" ? null : "Not found", { status: 404, headers });
}

function methodNotAllowed() {
  const headers = baseHeaders();
  headers.set("allow", ALLOWED_METHODS);
  return new Response("Method Not Allowed", { status: 405, headers });
}

function badRequest(method) {
  return new Response(method === "HEAD" ? null : "Bad request", { status: 400, headers: baseHeaders() });
}

// Never leak internals (stack traces, R2/S3 error detail, signing state) to the
// client — always a bare 500 with CORS so a broken embed still fails cleanly.
function internalError() {
  return new Response("Internal error", {
    status: 500,
    headers: { "access-control-allow-origin": "*" },
  });
}

// ── SigV4 helpers ─────────────────────────────────────────────────────────────

function toHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(message));
  return new Uint8Array(signature);
}

// RFC 3986 / AWS UriEncode, keeping "/" as path separators. encodeURIComponent
// already leaves the unreserved set + "!'()*" unescaped and emits upper-hex %XX,
// so we only need to additionally escape "!'()*" to land on exactly the AWS rule
// (unreserved = A-Za-z0-9-._~). This matches the mu-plugin's rawurlencode()
// write-side key encoding, so a key round-trips to the same stored object.
function encodeS3Path(pathSegments) {
  return pathSegments
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
}

// SigV4 canonical header value: trim, then collapse internal whitespace runs to a
// single space — matching how S3/R2 canonicalizes the value it receives. Our
// signed conditional/range values (ETags, HTTP-dates, byte ranges) have no
// whitespace inside quoted strings, so this is lossless for them.
function canonicalizeHeaderValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

// Build a SigV4-signed S3 GET/HEAD for one object in a per-site bucket. Returns
// the exact URL to fetch plus the header set to send. INVARIANT: the headers we
// SEND are exactly the headers we SIGNED (minus Host, which the runtime sets from
// the URL) and the wire path byte-matches the canonical URI — otherwise R2's
// signature check fails.
async function buildSignedR2Request({ method, accountId, accessKey, secretKey, bucket, key, clientHeaders }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const amzDate = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(""); // GET/HEAD carry no request body

  // Headers to both sign and send. host/x-amz-* are mandatory-signed; the
  // conditional/range headers are signed too so R2 accepts them.
  const signedValues = new Map();
  signedValues.set("host", host);
  signedValues.set("x-amz-content-sha256", payloadHash);
  signedValues.set("x-amz-date", amzDate);
  for (const name of CONDITIONAL_HEADER_NAMES) {
    const raw = clientHeaders.get(name);
    if (raw !== null) signedValues.set(name, canonicalizeHeaderValue(raw));
  }

  const sortedNames = [...signedValues.keys()].sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${signedValues.get(name)}\n`).join("");
  const signedHeaderList = sortedNames.join(";");

  const canonicalUri = `/${bucket}/${encodeS3Path(key)}`;
  const canonicalRequest =
    `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaderList}\n${payloadHash}`;

  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmacSha256(textEncoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, R2_REGION);
  const kService = await hmacSha256(kRegion, R2_SERVICE);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  // Send exactly the signed headers except Host (set by the runtime from the URL)
  // plus Authorization, using the canonicalized values so wire == signed.
  const outHeaders = new Headers();
  outHeaders.set("x-amz-content-sha256", payloadHash);
  outHeaders.set("x-amz-date", amzDate);
  outHeaders.set("authorization", authorization);
  for (const name of CONDITIONAL_HEADER_NAMES) {
    const value = signedValues.get(name);
    if (value !== undefined) outHeaders.set(name, value);
  }

  return { url: `https://${host}${canonicalUri}`, headers: outHeaders };
}

// One signed read attempt against one bucket. Called once per bucket in
// bucketAttemptOrder with the SAME method + client headers, so the client's
// Range/If-* headers are forwarded and signed identically on both attempts (each
// attempt gets its own x-amz-date/signature, which is all that differs).
async function fetchObjectFromBucket({ method, env, bucket, key, clientHeaders }) {
  const signed = await buildSignedR2Request({
    method,
    accountId: env.R2_ACCOUNT_ID,
    accessKey: env.R2_S3_KEY,
    secretKey: env.R2_S3_SECRET,
    bucket,
    key,
    clientHeaders,
  });

  return fetch(signed.url, { method, headers: signed.headers });
}

// Translate the R2 S3 response into the exact response shape the old R2-binding
// path produced. R2 has already applied the conditional/range semantics, so its
// status IS the client status for the cases we serve.
function buildClientResponse(upstream, method, key) {
  const status = upstream.status;

  // Missing object OR missing (unmigrated/unknown) bucket — R2 returns 404 for both
  // NoSuchKey and NoSuchBucket. Mirrors the old binding path's null -> 404. By the time
  // we get here the shared-bucket fallback has already been tried (see fetch()), so this
  // is a genuine "in neither bucket".
  if (status === 404) return notFound(method);

  // Anything R2 shouldn't return for a well-formed public read (403 bad creds,
  // 5xx, etc.) is an internal problem — surface neither it nor its body.
  if (status !== 200 && status !== 206 && status !== 304 && status !== 412) {
    console.warn(`[media-worker] unexpected R2 status ${status} for key ${key}`);
    return internalError();
  }

  const headers = baseHeaders();
  const upstreamContentType = upstream.headers.get("content-type");
  headers.set("content-type", upstreamContentType || contentTypeForKey(key));
  const upstreamEtag = upstream.headers.get("etag");
  if (upstreamEtag) headers.set("etag", upstreamEtag);
  const upstreamCacheControl = upstream.headers.get("cache-control");
  headers.set("cache-control", upstreamCacheControl || IMMUTABLE_CACHE);
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-expose-headers", EXPOSED_HEADERS);

  // 304 (If-None-Match / If-Modified-Since) and 412 (If-Match / If-Unmodified-
  // Since) carry no body — same as the old binding path's precondition branch,
  // which returned a null body for both. NOTE: R2 now decides 304-vs-412 by HTTP
  // semantics; the old binding path used a coarser "has If-None-Match ? 304 : 412"
  // heuristic, so an If-Modified-Since-only not-modified case is now correctly a
  // 304 (previously a 412). Every other conditional outcome is unchanged.
  if (status === 304 || status === 412) {
    return new Response(null, { status, headers });
  }

  if (status === 206) {
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("content-range", contentRange);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    return new Response(method === "HEAD" ? null : upstream.body, { status: 206, headers });
  }

  // 200 — full object.
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(method === "HEAD" ? null : upstream.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    try {
      const method = request.method;
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();

      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();

      let path;
      try {
        path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      } catch {
        return badRequest(method); // malformed percent-encoding
      }

      // Defence in depth: R2 keys are opaque strings, so ".." can't actually
      // escape a "directory" the way it would on a filesystem — but never
      // let a traversal-looking key through regardless.
      if (path.split("/").includes("..")) return notFound(method);

      const sharedHost = (env.SHARED_HOST || "media.doubleyoup.com").toLowerCase();

      // Resolve slug + object key. The key scheme is UNCHANGED; only the bucket
      // source changed (per-site bucket instead of one shared static binding).
      let slug;
      let key;
      if (host === sharedHost) {
        // /<slug>/<rest> — the slug prefix is already in the path, so the key is
        // the path unchanged and the slug is the first segment.
        key = path;
        slug = path.split("/")[0];
      } else {
        // Branded host — map host -> slug via KV, then prepend the slug prefix.
        const mappedSlug = await env.HOSTMAP.get(host);
        if (!mappedSlug) return notFound(method);
        slug = mappedSlug;
        key = path ? `${slug}/${path}` : slug;
      }
      if (!key) return notFound(method);
      if (!SLUG_PATTERN.test(slug)) return notFound(method);

      // Read credential is an Object-Read-ONLY R2 token held as a Worker secret (never
      // in a tenant container). Absent config => not live yet.
      if (!env.R2_ACCOUNT_ID || !env.R2_S3_KEY || !env.R2_S3_SECRET) {
        console.error("[media-worker] R2_ACCOUNT_ID / R2_S3_KEY / R2_S3_SECRET not configured");
        return internalError();
      }

      // Per-site bucket first, shared (legacy) bucket only as a fallback — sites move
      // into their own bucket one at a time, so both models have to serve at once.
      const [primaryBucket, fallbackBucket] = bucketAttemptOrder(slug, env);

      let upstream = await fetchObjectFromBucket({
        method,
        env,
        bucket: primaryBucket,
        key,
        clientHeaders: request.headers,
      });

      // COST: for a site that has NOT been migrated yet this is one extra upstream
      // round-trip per request that reaches the Worker (the primary 404s/403s first).
      // Accepted: it is a same-datacentre R2 request and repeat hits are absorbed by the
      // long immutable Cache-Control on the eventual 200. A per-slug "migrated" flag in
      // KV would remove the wasted attempt — deliberately NOT built yet (it adds a KV
      // read on every request plus a write path to keep the flag in sync, so it is only
      // worth it if the extra round-trip actually shows up in latency).
      //
      // The response cache is keyed on the PUBLIC url (media host + <slug>/<path>), never
      // on which bucket answered — the same key holds byte-identical objects in both
      // buckets — so migrating a site mid-cache cannot serve one site's object for
      // another's URL. The only staleness window is the 60s negative cache: a 404 that
      // was cached just before the object landed in the per-site bucket can persist for
      // up to NOT_FOUND_CACHE.
      if (fallbackBucket !== undefined && shouldFallbackToSharedBucket(upstream.status)) {
        const primaryStatus = upstream.status;

        // OBSERVABILITY (the fallback's one real hazard): a fallback 404 is served
        // through the status===404 branch of buildClientResponse, so without this line a
        // per-site read credential that is missing/unscoped/revoked would look exactly
        // like "object doesn't exist" — a 60s-cached 404 with no signal in `wrangler
        // tail`, indefinitely. Once the account-scoped read key is live a healthy
        // MIGRATED site answers 200 from the primary, so a persistent stream of these
        // warns is a genuine broken-credential alarm, not background noise.
        if (primaryStatus === 401 || primaryStatus === 403) {
          console.warn(
            `[media-worker] fallback-auth-denied status=${primaryStatus} slug=${slug} ` +
              `primary_bucket=${primaryBucket} key=${key}`,
          );
        }

        // The discarded primary response is a small S3 error XML; its body is left
        // unread (the runtime reclaims it) rather than cancelled, since a rejected
        // cancel() inside this handler would turn a servable request into a 500.
        upstream = await fetchObjectFromBucket({
          method,
          env,
          bucket: fallbackBucket,
          key,
          clientHeaders: request.headers,
        });

        // A genuinely missing object: present in neither bucket, and NOT an auth
        // problem (a 401/403 primary already logged its own, distinct line above — the
        // two cases stay greppable apart). Deliberately silent on the two healthy
        // paths — primary 200, and primary 404 -> fallback 200 (every request from an
        // unmigrated site) — so healthy traffic logs nothing.
        if (primaryStatus === 404 && upstream.status === 404) {
          console.warn(
            `[media-worker] not-found-in-both-buckets slug=${slug} key=${key} ` +
              `primary_bucket=${primaryBucket} fallback_bucket=${fallbackBucket}`,
          );
        }
      }

      return buildClientResponse(upstream, method, key);
    } catch (err) {
      // Never throw out of fetch() and never leak internals to the client.
      return internalError();
    }
  },
};
