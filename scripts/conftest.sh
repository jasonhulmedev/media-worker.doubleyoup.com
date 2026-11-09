#!/usr/bin/env sh
# Check workflow supply-chain policy; verify runs its Rego unit tests instead.
# Requires conftest 0.69.0 on PATH (CI installs the checksum-verified release).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."

if ! command -v conftest > /dev/null 2>&1; then
  echo "conftest is not on PATH. Install conftest 0.69.0 before running this script." >&2
  exit 127
fi

POLICY_DIR=.policy-as-code/.conftest/workflows

if [ "${1:-}" = "verify" ]; then
  shift
  exec conftest verify --policy "$POLICY_DIR" "$@"
fi

if [ "${1:-}" = "test" ]; then
  shift
fi

exec conftest test --policy "$POLICY_DIR" .github/workflows/*.yml "$@"
