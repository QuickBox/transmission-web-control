#!/usr/bin/env bash
# check-version.sh - guards that keep the automated version valid and derivable.
#
#   bash bin/check-version.sh messages <range>   # every non-merge subject in <range> is a conventional commit
#   bash bin/check-version.sh consistency [repo]  # package.json == version.js == index.json[0], SemVer, ahead of newest tag
#   bash bin/check-version.sh --selftest
#
# The message gate skips merges and the bot's own chore(release): commits. The
# consistency gate requires one SemVer across all three sources, strictly above
# the newest vX.Y.Z tag while that version is untagged (>= once tagged).
set -Eeuo pipefail

# Resolve the repo from the script's own location (overridable) so the checks
# run from any working directory, not only the repo root.
self_dir=$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)
default_root=$(dirname -- "$self_dir")
# Absolute path to this script, so a re-invocation works from any cwd (CI runs us by a relative path).
self="$self_dir/$(basename -- "$0")"
repo_root() { printf '%s' "${TWC_REPO:-$default_root}"; }

CONV='^(feat|fix|perf|refactor|docs|chore|test|style)(\([a-z0-9._-]+\))?!?: .+'
is_semver() { printf '%s' "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; }
# Highest of two SemVers, by version sort.
higher() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }

# The three version sources. Each prints the raw value, or nothing.
pkg_version() { sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
js_version() { sed -nE "s/^export const VERSION = ['\"]([^'\"]*)['\"];.*/\1/p" "$1/src/app/js/version.js" 2>/dev/null | head -1; }
index_version() {
	grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$1/changelogs/index.json" 2>/dev/null \
		| head -1 | sed -E 's/.*"([^"]*)"$/\1/'
}

messages() { # <range>
	local range=$1 bad=0 sha sub
	while IFS=$'\t' read -r sha sub; do
		[ -n "$sha" ] || continue
		printf '%s' "$sub" | grep -qE '^chore\(release\): ' && continue
		if ! printf '%s' "$sub" | grep -qE "$CONV"; then
			echo "  NONCONFORMING ${sha:0:10}  $sub"; bad=1
		fi
	done < <(git -C "$(repo_root)" log --no-merges --format='%H%x09%s' "$range" 2>/dev/null)
	if [ "$bad" = 1 ]; then echo "commit-message gate: FAIL (subjects must be conventional commits)"; return 1; fi
	echo "commit-message gate: PASS"
}

consistency() { # [repo]
	local repo=${1:-$(repo_root)} pv jsv iv v newest
	pv=$(pkg_version "$repo"); jsv=$(js_version "$repo"); iv=$(index_version "$repo")
	for v in "$pv" "$jsv" "$iv"; do
		is_semver "$v" || { echo "version-consistency: FAIL (not SemVer: package.json='$pv' version.js='$jsv' index='$iv')"; return 1; }
	done
	if [ "$pv" != "$jsv" ] || [ "$pv" != "$iv" ]; then
		echo "version-consistency: FAIL (package.json='$pv' version.js='$jsv' index='$iv')"; return 1
	fi
	newest=$(git -C "$repo" tag --list 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null \
		| grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -V | tail -1) || true
	if [ -n "$newest" ]; then
		if git -C "$repo" rev-parse -q --verify "refs/tags/v$pv" >/dev/null 2>&1; then
			[ "$(higher "$newest" "$pv")" = "$pv" ] || { echo "version-consistency: FAIL ($pv < newest tag v$newest)"; return 1; }
		elif [ "$pv" = "$newest" ] || [ "$(higher "$newest" "$pv")" != "$pv" ]; then
			echo "version-consistency: FAIL ($pv not > newest tag v$newest)"; return 1
		fi
	fi
	echo "version-consistency: PASS ($pv)"
}

selftest() {
	local fail=0 d ec
	d=$(mktemp -d); trap 'rm -rf "$d"' RETURN
	ok() { if "$@" >/dev/null 2>&1; then echo "selftest $LBL: PASS"; else echo "selftest $LBL: FAIL"; fail=1; fi; }
	no() { ec=0; "$@" >/dev/null 2>&1 || ec=$?; if [ "$ec" != 0 ]; then echo "selftest $LBL: PASS"; else echo "selftest $LBL: FAIL"; fail=1; fi; }
	# point the tool at a repo via TWC_REPO, proving it does not depend on $PWD
	# shellcheck disable=SC2317  # invoked indirectly through ok()/no()
	msg() { TWC_REPO="$1" bash "$self" messages "$2"; }

	# --- message gate ---
	git -C "$d" init -q; git -C "$d" config user.email t@t; git -C "$d" config user.name t
	echo 0 > "$d/f"; git -C "$d" add -A; git -C "$d" commit -qm 'chore: seed'
	base=$(git -C "$d" rev-parse HEAD)
	for s in 'feat(rpc): add x' 'fix: y' 'refactor(core)!: drop z' 'docs(readme): note' 'chore(release): v1.2.3' 'chore(deps): bump actions/checkout'; do
		echo "$s" > "$d/f"; git -C "$d" add -A; git -C "$d" commit -qm "$s"
	done
	LBL="messages-good-conventional"; ok msg "$d" "$base..HEAD"
	echo bad > "$d/f"; git -C "$d" add -A; git -C "$d" commit -qm 'updated some stuff'
	LBL="messages-bad-subject-rejected"; no msg "$d" "$base..HEAD"
	# breaking via ! is accepted; breaking via body keeps a conventional subject
	git -C "$d" init -q "$d/b"; git -C "$d/b" config user.email t@t; git -C "$d/b" config user.name t
	echo 0 > "$d/b/f"; git -C "$d/b" add -A; git -C "$d/b" commit -qm 'chore: seed'
	bb=$(git -C "$d/b" rev-parse HEAD)
	echo 1 > "$d/b/f"; git -C "$d/b" add -A; git -C "$d/b" commit -qm 'feat(api)!: new loader'
	printf '2' > "$d/b/f"; git -C "$d/b" add -A; git -C "$d/b" commit -qm 'fix(core): guard' -m 'BREAKING CHANGE: legacy dialect removed'
	LBL="messages-breaking-accepted"; ok msg "$d/b" "$bb..HEAD"

	# --- consistency gate ---
	mkver() { # <dir> <package.json ver> <version.js ver> <index.json ver>
		mkdir -p "$1/changelogs" "$1/src/app/js"
		printf '{\n  "private": true,\n  "version": "%s",\n  "type": "module"\n}\n' "$2" > "$1/package.json"
		printf "export const VERSION = '%s';\n" "$3" > "$1/src/app/js/version.js"
		printf '[\n  {"version": "%s", "date": "2026-01-01", "file": "changelogs/v%s.md"}\n]\n' "$4" "$4" > "$1/changelogs/index.json"
		git -C "$1" init -q; git -C "$1" config user.email t@t; git -C "$1" config user.name t
		echo x > "$1/f"; git -C "$1" add -A; git -C "$1" commit -qm 'chore: seed'
	}
	mkver "$d/c1" 2.1.0 2.1.0 2.1.0; git -C "$d/c1" tag v2.0.0
	LBL="consistency-aligned-above-tag"; ok bash "$self" consistency "$d/c1"
	mkver "$d/c2" 2.1.0 2.0.0 2.1.0; git -C "$d/c2" tag v2.0.0
	LBL="consistency-js-mismatch-rejected"; no bash "$self" consistency "$d/c2"
	mkver "$d/c2b" 2.1.0 2.1.0 2.0.0
	LBL="consistency-index-mismatch-rejected"; no bash "$self" consistency "$d/c2b"
	mkver "$d/c3" 1.9.0 1.9.0 1.9.0; git -C "$d/c3" tag v2.0.0
	LBL="consistency-below-tag-rejected"; no bash "$self" consistency "$d/c3"
	mkver "$d/c3b" 2.0.0 2.0.0 2.0.0; git -C "$d/c3b" tag v2.0.0
	LBL="consistency-tagged-equal-ok"; ok bash "$self" consistency "$d/c3b"
	mkver "$d/c4" 2.1 2.1 2.1
	LBL="consistency-nonsemver-rejected"; no bash "$self" consistency "$d/c4"
	mkver "$d/c5" 0.0.0 0.0.0 0.0.0   # no tag at all -> aligned and ahead of nothing
	LBL="consistency-untagged-ok"; ok bash "$self" consistency "$d/c5"
	mkdir -p "$d/c7"; git -C "$d/c7" init -q
	LBL="consistency-missing-sources-rejected"; no bash "$self" consistency "$d/c7"

	# any-cwd: resolve the repo from TWC_REPO / the script location, never $PWD
	mkver "$d/c6" 2.0.0 2.0.0 2.0.0
	LBL="anycwd-consistency-from-tmp"
	if ( cd /tmp && TWC_REPO="$d/c6" bash "$self" consistency ) >/dev/null 2>&1; then
		echo "selftest $LBL: PASS"; else echo "selftest $LBL: FAIL"; fail=1; fi
	LBL="anycwd-messages-from-tmp"
	if ( cd /tmp && TWC_REPO="$d/c6" bash "$self" messages HEAD~0..HEAD ) >/dev/null 2>&1; then
		echo "selftest $LBL: PASS"; else echo "selftest $LBL: FAIL"; fail=1; fi
	return "$fail"
}

case "${1:-}" in
	--selftest) selftest; exit $? ;;
	messages) shift; messages "${1:?range required}" ;;
	consistency) shift; consistency "${1:-}" ;;
	*) echo "usage: $0 messages <range> | consistency [repo] | --selftest" >&2; exit 2 ;;
esac
