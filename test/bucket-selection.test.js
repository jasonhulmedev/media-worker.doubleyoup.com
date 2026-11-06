// Unit tests for the pure request-decision helpers exported by the Worker (bucket
// attempt order, shared-bucket fallback, trash refusal — hub#222).
// Run with `npm test` (node's built-in runner — no test framework dependency, and no
// Workers runtime needed since these functions touch neither fetch nor env bindings).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bucketAttemptOrder,
  isTrashRequest,
  shouldFallbackToSharedBucket,
  siteSlugFromPrefixSegment,
} from "../src/index.js";

const SLUG = "rareepicgamer-19f933";

test("per-site bucket is always tried first, shared bucket second", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "doubleyoup-media" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET unset falls back to the default shared bucket name", () => {
  const order = bucketAttemptOrder(SLUG, {});
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET empty string is treated as unset", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media"]);
});

test("MEDIA_BUCKET overrides only the fallback, never the primary", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "doubleyoup-media-staging" });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933", "doubleyoup-media-staging"]);
});

test("a MEDIA_BUCKET equal to the per-site bucket collapses to a single attempt", () => {
  const order = bucketAttemptOrder(SLUG, { MEDIA_BUCKET: `doubleyoup-media-${SLUG}` });
  assert.deepEqual(order, ["doubleyoup-media-rareepicgamer-19f933"]);
});

test("only 401/403/404 from the primary trigger the shared-bucket fallback", () => {
  for (const status of [401, 403, 404]) {
    assert.equal(shouldFallbackToSharedBucket(status), true, `expected fallback on ${status}`);
  }

  // Successes are served as-is; server errors must surface rather than be masked by a
  // second lookup that could turn a real outage into a cached 404.
  for (const status of [200, 206, 304, 412, 429, 500, 502, 503, 504]) {
    assert.equal(shouldFallbackToSharedBucket(status), false, `expected no fallback on ${status}`);
  }
});

// hub#43: the agency copy of the Worker has no shared legacy bucket.
test('MEDIA_BUCKET="none" or "off" (any case) leaves only the per-site bucket', () => {
  for (const value of ["none", "NONE", " off ", "Off"]) {
    assert.deepEqual(bucketAttemptOrder(SLUG, { MEDIA_BUCKET: value }), ["doubleyoup-media-rareepicgamer-19f933"], value);
  }
});

test("a bucket whose name merely starts with none is still a fallback bucket", () => {
  assert.deepEqual(bucketAttemptOrder(SLUG, { MEDIA_BUCKET: "none-shared" }), ["doubleyoup-media-rareepicgamer-19f933", "none-shared"]);
});

// hub#222 soft delete: any key/path that resolves into trash/ is refused with a 404
// before the first R2 read, on the shared host and on branded hosts.
test("a resolved key starting with trash/ (root-level trash) is refused", () => {
  // Shared-host path /trash/<date>/<slug>/<file> puts "trash" in the slug position,
  // so the resolved key itself starts with trash/.
  const key = `trash/2026-11-02/${SLUG}/2025/08/photo.jpg`;
  assert.equal(isTrashRequest(key, key.slice("trash/".length)), true);
});

test("trash/ inside the site's own namespace is refused", () => {
  // Branded-host /trash/... and shared-host /<slug>/trash/... both resolve to the
  // key "<slug>/trash/..." — refused via the site path (key minus the slug prefix).
  const key = `${SLUG}/trash/2026-11-02/2025/08/photo.jpg`;
  assert.equal(isTrashRequest(key, "trash/2026-11-02/2025/08/photo.jpg"), true);
});

test("ordinary media keys, and trash-looking names that are not the trash prefix, are served", () => {
  assert.equal(isTrashRequest(`${SLUG}/2025/08/photo.jpg`, "2025/08/photo.jpg"), false);
  // "trash" later in the path, or without the trailing slash, is not trash/.
  assert.equal(isTrashRequest(`${SLUG}/2025/08/trash-can.jpg`, "2025/08/trash-can.jpg"), false);
  assert.equal(isTrashRequest(`${SLUG}/trash`, "trash"), false);
  assert.equal(isTrashRequest(`${SLUG}/trashier/photo.jpg`, "trashier/photo.jpg"), false);
});

// orchestrator#84: shared-host staging prefix "sg-<slug>" belongs to site <slug>.
test("siteSlugFromPrefixSegment strips a leading sg- and leaves other segments alone", () => {
  assert.equal(siteSlugFromPrefixSegment("sg-acme"), "acme");
  assert.equal(siteSlugFromPrefixSegment("acme"), "acme");
  assert.equal(siteSlugFromPrefixSegment("sg-"), "");
  assert.equal(siteSlugFromPrefixSegment("xsg-acme"), "xsg-acme");
});
