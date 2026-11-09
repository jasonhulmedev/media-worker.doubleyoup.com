// Fixture for dy-path-check-misses-single-dot-segment.

function refuseTraversalVulnerable(path, method) {
  // ruleid: dy-path-check-misses-single-dot-segment
  if (path.split("/").includes("..")) return notFound(method);
  return null;
}

function refuseTraversalFixed(path, method) {
  // ok: dy-path-check-misses-single-dot-segment
  if (path.split("/").includes("..") || path.split("/").includes(".")) return notFound(method);
  return null;
}

function refuseTraversalFixedSome(path, method) {
  // ok: dy-path-check-misses-single-dot-segment
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return notFound(method);
  return null;
}
