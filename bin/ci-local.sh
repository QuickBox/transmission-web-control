#!/usr/bin/env bash
# ci-local.sh - run the ci checks locally, exactly as .github/workflows/ci.yml
# runs them: from the repo root, with the same relative invocations, in the same
# order, stopping on the first failure.
#
# KEEP IN SYNC: this script and .github/workflows/ci.yml must list the SAME
# steps in the SAME order. Change one, change the other.
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "$0")/.." >/dev/null 2>&1 && pwd)
cd "$root"

step() { echo; echo "== $* =="; }

# 1-2. static gates over the shipped app
step "check.mjs"
node tools/check.mjs
step "check.mjs --selftest"
node tools/check.mjs --selftest

# 3. syntax-check the app modules
step "node --check"
find src/app -name '*.js' -print0 | xargs -0 -n1 node --check

# 4. unit tests
step "node --test"
node --test "tests/**/*.test.js"

# 5. conventional commit messages over the commits not yet on main
step "commit messages are conventional"
if git rev-parse --verify -q origin/main >/dev/null 2>&1; then
	range="origin/main..HEAD"
else
	range="HEAD"
fi
echo "checking $range"
bash bin/check-version.sh messages "$range"

# 6. one consistent version across the sources
step "version consistency"
bash bin/check-version.sh consistency

# 7-8. selftests
step "release --selftest"
bash bin/release.sh --selftest
step "check-version --selftest"
bash bin/check-version.sh --selftest

echo
echo "ci-local: ALL GREEN"
