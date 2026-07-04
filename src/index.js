// doubleyoup media Worker — serves site media from the R2 bucket for BOTH the
// shared host (media.doubleyoup.com/<slug>/…) and branded customer hostnames
// (media.<theirdomain>/… via Cloudflare for SaaS). One R2 object per file; the
// public URL differs, the R2 key does not.
//
// Prefix resolution:
//   • shared host (SHARED_HOST): the slug is the first path segment — key = path.
//   • branded host: look the Host up in KV (HOSTMAP: hostname -> slug) and prepend
//     the slug — key = "<slug>/" + path.
//
// Bindings (wrangler.toml): BUCKET (R2, doubleyoup-media), HOSTMAP (KV), and the
// var SHARED_HOST. Cloudflare for SaaS attaches customer hostnames to this Worker;
// the orchestrator writes the HOSTMAP entry + registers the custom hostname on
// onboarding.
//
// Conditional requests + Range are both handled by passing `request.headers`
// straight through to env.BUCKET.get() as `onlyIf` and `range` — that is R2's
// own documented option shape (R2GetOptions.onlyIf/range each accept
// `R2Conditional | Headers` / `R2Range | Headers`), so R2 parses If-Match /
// If-None-Match / If-Modified-Since / If-Unmodified-Since / Range itself
// instead of this Worker re-implementing that HTTP semantics by hand.

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NOT_FOUND_CACHE = "public, max-age=60"; // small + cacheable, so a bad/unknown
// path or host doesn't hammer KV/R2 on every repeat request.
const ALLOWED_METHODS = "GET, HEAD";
const EXPOSED_HEADERS = "content-length, content-range, etag, accept-ranges";

// Fallback Content-Type by file extension — only used when the R2 object was
// stored without an httpMetadata.contentType (writeHttpMetadata leaves
// content-type unset in that case).
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

      let key;
      if (host === sharedHost) {
        // /<slug>/<rest> — the slug prefix is already in the path.
        key = path;
      } else {
        // Branded host — map host -> slug via KV, then prepend the slug prefix.
        const slug = await env.HOSTMAP.get(host);
        if (!slug) return notFound(method);
        key = path ? `${slug}/${path}` : slug;
      }
      if (!key) return notFound(method);

      const obj = await env.BUCKET.get(key, {
        onlyIf: request.headers,
        range: request.headers,
      });
      if (obj === null) return notFound(method);

      const headers = baseHeaders();
      obj.writeHttpMetadata(headers);
      if (!headers.has("content-type")) headers.set("content-type", contentTypeForKey(key));
      headers.set("etag", obj.httpEtag);
      if (!headers.has("cache-control")) headers.set("cache-control", IMMUTABLE_CACHE);
      headers.set("accept-ranges", "bytes");
      headers.set("access-control-expose-headers", EXPOSED_HEADERS);

      // R2 withholds the body when an onlyIf precondition isn't satisfied —
      // the returned value is a plain R2Object (metadata only), not an
      // R2ObjectBody. If-None-Match is what browsers send for GET cache
      // revalidation, so treat that specifically as "not modified"; any other
      // failed precondition (If-Match / If-Unmodified-Since) is a genuine 412.
      if (!("body" in obj)) {
        const status = request.headers.has("if-none-match") ? 304 : 412;
        return new Response(null, { status, headers });
      }

      if (obj.range) {
        // R2 always resolves a served range to a concrete {offset, length}
        // (even if the request used a suffix range) before returning it here;
        // the ?? fallbacks below are just defensive, not expected in practice.
        const offset = obj.range.offset ?? 0;
        const length = obj.range.length ?? Math.max(obj.size - offset, 0);
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        headers.set("content-length", String(length));
        return new Response(method === "HEAD" ? null : obj.body, { status: 206, headers });
      }

      headers.set("content-length", String(obj.size));
      return new Response(method === "HEAD" ? null : obj.body, { status: 200, headers });
    } catch (err) {
      // Never throw out of fetch() and never leak internals (stack traces,
      // R2/KV error detail) to the client.
      return new Response("Internal error", {
        status: 500,
        headers: { "access-control-allow-origin": "*" },
      });
    }
  },
};
