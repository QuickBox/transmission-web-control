#!/usr/bin/env bash
# release.sh - derive the next version from conventional commits and write the
# version literals and the changelog set, or build the release asset from a
# tagged tree. It never commits, tags or pushes; it prints the commit to make.
#
#   bash bin/release.sh                      # compute + write for the next version
#   bash bin/release.sh --dry-run            # compute + print, write nothing
#   bash bin/release.sh --ci                 # non-interactive write; exit 3 when nothing to release
#   bash bin/release.sh --version X.Y.Z      # seed/override the version
#   bash bin/release.sh --since <ref>        # override the changelog range base
#   bash bin/release.sh --highlights <file>  # prepend a highlights paragraph
#   bash bin/release.sh --asset <dir> [--ref <ref>]  # build the tarball + SHA256SUMS from <ref> (default HEAD)
#   bash bin/release.sh --selftest
#
# Version base: the highest vX.Y.Z tag reachable from HEAD. Bump from the commit
# subjects since it: feat -> minor; fix/perf/refactor -> patch; a `!` subject or
# a BREAKING CHANGE body -> major; docs/chore/test/style/ci only -> nothing to
# release (refused unless --version). The changelog range is that same tag, or
# --since when the reachable tag predates the line being released. Bot release
# commits and merges never drive a bump or reach a changelog.
#
# The asset is transmission-web-control-vX.Y.Z.tar.gz: the src/ tree of <ref>
# with every __QBV__ cache key replaced by the version that tree's package.json
# holds, plus a SHA256SUMS file beside it. The build is reproducible: the same
# ref always yields the same bytes.
set -Eeuo pipefail

self_dir=$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)
default_repo=$(dirname -- "$self_dir")
# Absolute path to this script, so a re-invocation works from any cwd.
self="$self_dir/$(basename -- "$0")"
repo="${TWC_REPO:-$default_repo}"

dry_run=0 version_override="" since_ref="" highlights_file="" do_selftest=0 ci=0 asset_dir="" asset_ref=HEAD
while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) dry_run=1 ;;
		--ci) ci=1 ;;
		--version) version_override="${2:-}"; shift ;;
		--since) since_ref="${2:-}"; shift ;;
		--highlights) highlights_file="${2:-}"; shift ;;
		--asset) asset_dir="${2:-}"; shift ;;
		--ref) asset_ref="${2:-}"; shift ;;
		--selftest) do_selftest=1 ;;
		-h|--help) sed -nE 's/^# ?//p' "$0" | sed -n '1,26p'; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

die() { echo "release.sh: $*" >&2; exit 1; }
is_semver() { printf '%s' "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# Bot release commits and merges never drive a version bump and never appear
# in a generated changelog.
excluded_subject() { printf '%s' "$1" | grep -qE '^(chore\(release\)|Merge )'; }

# Highest vX.Y.Z tag that is an ancestor of HEAD. Empty if none.
highest_reachable_tag() { # <repo>
	local r=$1 t
	for t in $(git -C "$r" tag --list 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null); do
		printf '%s\n' "$t" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' || continue
		git -C "$r" merge-base --is-ancestor "$t" HEAD 2>/dev/null && printf '%s\n' "${t#v}"
	done | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

# Bump kind across commits in a range. Prints major|minor|patch|none.
bump_kind() { # <repo> <range>
	local r=$1 range=$2 kind=none sub
	if git -C "$r" log --no-merges --format='%b' "$range" 2>/dev/null | grep -q 'BREAKING CHANGE'; then
		echo major; return
	fi
	while IFS= read -r sub; do
		[ -n "$sub" ] || continue
		excluded_subject "$sub" && continue
		if printf '%s' "$sub" | grep -qE '^[a-z]+(\([^)]*\))?!:'; then echo major; return; fi
		if printf '%s' "$sub" | grep -qE '^feat(\([^)]*\))?:'; then kind=minor; continue; fi
		if printf '%s' "$sub" | grep -qE '^(fix|perf|refactor)(\([^)]*\))?:'; then
			[ "$kind" = minor ] || kind="patch"
		fi
	done < <(git -C "$r" log --no-merges --format='%s' "$range" 2>/dev/null)
	echo "$kind"
}

apply_bump() { # <prev X.Y.Z> <kind>
	local x y z; IFS=. read -r x y z <<<"$1"
	case "$2" in
		major) echo "$((x+1)).0.0" ;;
		minor) echo "$x.$((y+1)).0" ;;
		patch) echo "$x.$y.$((z+1))" ;;
		*) return 1 ;;
	esac
}

# A commit whose every changed file sits under the string catalogs is a translation change.
is_lang_only() { # <repo> <sha>
	local r=$1 sha=$2 files
	files=$(git -C "$r" show --name-only --format= "$sha" 2>/dev/null | grep -v '^$' || true)
	[ -n "$files" ] || return 1
	! printf '%s\n' "$files" | grep -qvE '^src/app/i18n/'
}

cap_first() { printf '%s%s' "$(printf '%s' "${1:0:1}" | tr '[:lower:]' '[:upper:]')" "${1:1}"; }

# Build the per-version changelog body on stdout: heading, optional highlights,
# then the sections present. <range> empty means the whole history.
gen_changelog_body() { # <repo> <version> <date> <range> <highlights>
	local r=$1 ver=$2 date=$3 range=$4 hl=$5 sha sub typ scope desc sec
	local -a added=() fixed=() perf=() changed=() trans=()
	while IFS=$'\t' read -r sha sub; do
		printf '%s' "$sub" | grep -qE '^[a-z]+(\([^)]*\))?!?:' || continue
		excluded_subject "$sub" && continue
		typ=$(printf '%s' "$sub" | sed -E 's/^([a-z]+).*/\1/')
		scope=$(printf '%s' "$sub" | sed -nE 's/^[a-z]+\(([^)]*)\)!?:.*/\1/p')
		desc=$(printf '%s' "$sub" | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//')
		desc=$(cap_first "$desc")
		sec=""
		if [ "$scope" = i18n ] || is_lang_only "$r" "$sha"; then sec=trans
		else case "$typ" in
			feat) sec=added ;; fix) sec=fixed ;; perf) sec=perf ;; refactor) sec=changed ;;
		esac; fi
		case "$sec" in
			added) added+=("- $desc") ;; fixed) fixed+=("- $desc") ;;
			perf) perf+=("- $desc") ;; changed) changed+=("- $desc") ;;
			trans) trans+=("- $desc") ;;
		esac
	done < <(git -C "$r" log --no-merges --format='%H%x09%s' "$range" 2>/dev/null)

	printf '## v%s (%s)\n' "$ver" "$date"
	if [ -n "$hl" ] && [ -f "$hl" ]; then printf '\n'; cat "$hl"; fi
	local -a names=(Added Fixed Performance Changed Translations)
	local i=0 arr
	for arr in added fixed perf changed trans; do
		local -n ref=$arr
		if [ "${#ref[@]}" -gt 0 ]; then
			printf '\n### %s\n\n' "${names[$i]}"
			printf '%s\n' "${ref[@]}"
		fi
		i=$((i+1))
	done
}

# index.json from every changelogs/v*.md, newest first.
gen_index() { # <repo>
	local r=$1 f ver date first=1
	printf '['
	while IFS=' ' read -r ver date file; do
		[ -n "$ver" ] || continue
		[ "$first" = 1 ] || printf ','
		first=0
		printf '\n  {"version": "%s", "date": "%s", "file": "%s"}' "$ver" "$date" "$file"
	done < <(
		for f in "$r"/changelogs/v*.md; do
			[ -e "$f" ] || continue
			sed -nE 's/^## v([0-9]+\.[0-9]+\.[0-9]+) \(([0-9]{4}-[0-9]{2}-[0-9]{2})\).*/\1 \2 changelogs\/'"$(basename "$f")"'/p' "$f" | head -1
		done | sort -t. -k1,1nr -k2,2nr -k3,3nr
	)
	printf '\n]\n'
}

# CHANGELOG.md: a header then every per-version file, newest first.
gen_aggregate() { # <repo>
	local r=$1 ver f
	printf '# Changelog\n\n'
	printf 'Release notes for the QuickBox Transmission web interface, newest first. Notes from before this fork (v1.x) are in CHANGELOG-EN.md and the git history.\n'
	while IFS=' ' read -r ver file; do
		[ -n "$ver" ] || continue
		printf '\n'
		cat "$r/$file"
	done < <(
		for f in "$r"/changelogs/v*.md; do
			[ -e "$f" ] || continue
			sed -nE 's/^## v([0-9]+\.[0-9]+\.[0-9]+) \(.*/\1 changelogs\/'"$(basename "$f")"'/p' "$f" | head -1
		done | sort -t. -k1,1nr -k2,2nr -k3,3nr
	)
}

write_package_version() { # <repo> <ver>
	local r=$1 ver=$2
	grep -qE '^[[:space:]]*"version"[[:space:]]*:' "$r/package.json" || die "package.json has no version field"
	sed -i -E "s/^([[:space:]]*\"version\"[[:space:]]*:[[:space:]]*\")[^\"]*(\".*)/\1$ver\2/" "$r/package.json"
}

write_js_version() { # <repo> <ver>
	local r=$1 ver=$2
	local f="$r/src/app/js/version.js"
	grep -qE "^export const VERSION = '[^']*';" "$f" || die "src/app/js/version.js has no VERSION export"
	sed -i -E "s/^(export const VERSION = ')[^']*(';)/\1$ver\2/" "$f"
}

# Build the release tarball and SHA256SUMS into <outdir> from the src/ tree of <ref>.
build_asset() { # <outdir> <ref>
	local out=$1 ref=$2 ver ts name stage
	[ -n "$out" ] || die "--asset needs an output directory"
	git -C "$repo" rev-parse -q --verify "$ref^{commit}" >/dev/null || die "unknown ref: $ref"
	ver=$(git -C "$repo" show "$ref:package.json" 2>/dev/null \
		| sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' | head -1)
	is_semver "$ver" || die "package.json at $ref holds no SemVer version ('$ver')"
	if printf '%s' "$ref" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' && [ "$ref" != "v$ver" ]; then
		die "tag $ref holds version $ver; refusing to build a mislabelled asset"
	fi
	stage=$(mktemp -d)
	# shellcheck disable=SC2064  # expand now: $stage is local, and a die exits the script
	trap "rm -rf '$stage'" EXIT
	git -C "$repo" archive --format=tar "$ref" src | tar -x -C "$stage"
	[ -f "$stage/src/index.html" ] || die "no src/index.html at $ref"
	grep -rlIZF '__QBV__' "$stage/src" | xargs -0 -r sed -i "s/__QBV__/$ver/g"
	if grep -rqF '__QBV__' "$stage/src"; then die "a __QBV__ cache key survived the stamp"; fi
	ts=$(git -C "$repo" log -1 --format=%ct "$ref")
	name="transmission-web-control-v$ver.tar.gz"
	mkdir -p "$out"
	tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$ts" \
		--mode='u+rwX,go+rX,go-w' -C "$stage" -cf - src | gzip -n -9 > "$out/$name"
	( cd "$out" && sha256sum "$name" > SHA256SUMS )
	echo "asset=$out/$name"
	echo "asset-version=$ver"
}

run_release() {
	is_semver "${version_override:-1.0.0}" || die "--version must be X.Y.Z"
	local base_ver range_base range kind new_ver date
	base_ver=$(highest_reachable_tag "$repo")
	if [ -n "$since_ref" ]; then range_base=$since_ref
	elif [ -n "$base_ver" ]; then range_base="v$base_ver"
	else range_base=""; fi
	if [ -n "$range_base" ]; then range="$range_base..HEAD"; else range="HEAD"; fi

	if [ -n "$version_override" ]; then
		new_ver=$version_override
		kind="(forced)"
	else
		[ -n "$base_ver" ] || die "no vX.Y.Z tag reachable from HEAD; pass --version to seed"
		kind=$(bump_kind "$repo" "$range")
		if [ "$kind" = none ]; then
			if [ "$ci" = 1 ]; then echo "nothing to release: no feat/fix/perf/refactor commits since v$base_ver"; exit 3; fi
			die "nothing to release: only docs/chore/test/style/ci commits since v$base_ver (pass --version to override)"
		fi
		new_ver=$(apply_bump "$base_ver" "$kind")
	fi

	date=$(date -u +%F)
	echo "base version:  ${base_ver:-<none>}"
	echo "range:         ${range}"
	echo "bump:          ${kind}"
	echo "next version:  ${new_ver}"
	echo "release date:  ${date}"
	echo "---- changelog preview ----"
	gen_changelog_body "$repo" "$new_ver" "$date" "$range" "$highlights_file"
	echo "---------------------------"

	if [ "$dry_run" = 1 ]; then echo "(dry-run: nothing written)"; return 0; fi

	mkdir -p "$repo/changelogs"
	local cf="$repo/changelogs/v$new_ver.md"
	if [ -s "$cf" ]; then
		echo "kept existing changelogs/v$new_ver.md (curated; not overwritten)"
	else
		gen_changelog_body "$repo" "$new_ver" "$date" "$range" "$highlights_file" > "$cf"
		echo "wrote $cf"
	fi
	gen_index "$repo" > "$repo/changelogs/index.json"
	gen_aggregate "$repo" > "$repo/CHANGELOG.md"
	write_package_version "$repo" "$new_ver"
	write_js_version "$repo" "$new_ver"

	if [ "$ci" = 1 ]; then
		echo "ci-version=$new_ver"
		return 0
	fi
	echo
	echo "Files written: package.json src/app/js/version.js changelogs/v$new_ver.md changelogs/index.json CHANGELOG.md"
	echo "Commit to make (do not tag or push):"
	echo "  git -C \"$repo\" add -A && git -C \"$repo\" commit -m 'chore(release): v$new_ver'"
}

selftest() {
	local fail=0 tmp d ver
	tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
	seed_tree() { # <dir> <version>
		mkdir -p "$1/src/app/js" "$1/bin"
		printf '{\n  "private": true,\n  "version": "%s",\n  "type": "module"\n}\n' "$2" > "$1/package.json"
		printf "export const VERSION = '%s';\n" "$2" > "$1/src/app/js/version.js"
	}
	mk() { # <dir> then subjects via stdin
		d="$tmp/$1"; mkdir -p "$d"; git -C "$d" init -q
		git -C "$d" config user.email t@t; git -C "$d" config user.name t
		seed_tree "$d" 1.0.0
		echo seed > "$d/f"; git -C "$d" add -A; git -C "$d" commit -qm 'chore: seed'
		git -C "$d" tag v1.0.0
		local s n=0
		while IFS= read -r s; do [ -n "$s" ] || continue; n=$((n+1)); echo "$n" > "$d/f$n"; git -C "$d" add -A; git -C "$d" commit -qm "$s"; done
	}
	expect() { # <dir> <expected-version> <label>
		local got; got=$(TWC_REPO="$tmp/$1" bash "$self" --dry-run 2>/dev/null | sed -nE 's/^next version:  //p')
		if [ "$got" = "$2" ]; then echo "selftest $3: PASS ($got)"; else echo "selftest $3: FAIL (got '$got', want '$2')"; fail=1; fi
	}
	expect_refuse() { # <dir> <label>
		local ec=0; TWC_REPO="$tmp/$1" bash "$self" --dry-run >/dev/null 2>&1 || ec=$?
		if [ "$ec" != 0 ]; then echo "selftest $2: PASS (refused)"; else echo "selftest $2: FAIL (did not refuse)"; fail=1; fi
	}
	ci_expect() { # <dir> <expected-version> <label>
		local out rc=0 got; out=$(TWC_REPO="$tmp/$1" bash "$self" --ci 2>/dev/null) || rc=$?
		got=$(printf '%s' "$out" | sed -nE 's/^ci-version=//p')
		if [ "$rc" = 0 ] && [ "$got" = "$2" ]; then echo "selftest $3: PASS ($got)"; else echo "selftest $3: FAIL (rc=$rc got '$got' want '$2')"; fail=1; fi
	}
	ci_expect_nothing() { # <dir> <label>
		local rc=0; TWC_REPO="$tmp/$1" bash "$self" --ci >/dev/null 2>&1 || rc=$?
		if [ "$rc" = 3 ]; then echo "selftest $2: PASS (exit 3)"; else echo "selftest $2: FAIL (rc=$rc)"; fail=1; fi
	}
	mk feat <<-'EOF'
	feat(ui): add a search field
	docs: tweak readme
	EOF
	mk fixonly <<-'EOF'
	fix(table): stop the status pill flicker
	chore(deps): bump actions/checkout
	EOF
	mk breaking <<-'EOF'
	feat(api): new loader
	refactor(rpc)!: drop the legacy dialect
	EOF
	mk docsonly <<-'EOF'
	docs: expand the readme
	chore: reorder
	EOF
	expect feat 1.1.0 "feat-history-minor"
	expect fixonly 1.0.1 "fix-only-patch"
	expect breaking 2.0.0 "breaking-major"
	expect_refuse docsonly "docs-only-refused"
	# --version override on a docs-only history still releases
	ver=$(TWC_REPO="$tmp/docsonly" bash "$self" --dry-run --version 9.9.9 2>/dev/null | sed -nE 's/^next version:  //p')
	if [ "$ver" = 9.9.9 ]; then echo "selftest version-override: PASS (9.9.9)"; else echo "selftest version-override: FAIL ($ver)"; fail=1; fi

	# no tag at all: refused unless seeded with --version, and --since bounds the notes
	d="$tmp/seed"; mkdir -p "$d"; git -C "$d" init -q
	git -C "$d" config user.email t@t; git -C "$d" config user.name t
	seed_tree "$d" 0.0.0
	echo a > "$d/a"; git -C "$d" add -A; git -C "$d" commit -qm 'feat: upstream era'
	since=$(git -C "$d" rev-parse HEAD)
	echo b > "$d/b"; git -C "$d" add -A; git -C "$d" commit -qm 'feat(webui): the rewrite'
	expect_refuse seed "untagged-unseeded-refused"
	TWC_REPO="$d" bash "$self" --ci --version 2.0.0 --since "$since" >/dev/null 2>&1 || true
	if grep -q 'The rewrite' "$d/changelogs/v2.0.0.md" 2>/dev/null && ! grep -q 'Upstream era' "$d/changelogs/v2.0.0.md"; then
		echo "selftest seed-since-bounds-notes: PASS"; else echo "selftest seed-since-bounds-notes: FAIL"; fail=1; fi
	if bash "$self_dir/check-version.sh" consistency "$d" >/dev/null 2>&1; then
		echo "selftest seed-writes-consistent-version: PASS"; else echo "selftest seed-writes-consistent-version: FAIL"; fail=1; fi

	# --ci generated path: writes files and reports the version; nothing-to-release exits 3
	ci_expect feat 1.1.0 "ci-generated-minor"
	if bash "$self_dir/check-version.sh" consistency "$tmp/feat" >/dev/null 2>&1; then
		echo "selftest ci-writes-consistent-version: PASS"; else echo "selftest ci-writes-consistent-version: FAIL"; fail=1; fi
	ci_expect_nothing docsonly "ci-nothing-to-release-exit3"

	# --ci must drop bot release commits and merges from the notes
	d="$tmp/excl"; mkdir -p "$d"; git -C "$d" init -q
	git -C "$d" config user.email t@t; git -C "$d" config user.name t
	seed_tree "$d" 1.0.0
	echo seed > "$d/f"; git -C "$d" add -A; git -C "$d" commit -qm 'chore: seed'
	git -C "$d" tag v1.0.0; base=$(git -C "$d" branch --show-current)
	echo a > "$d/a"; git -C "$d" add -A; git -C "$d" commit -qm 'feat(ui): add a real feature'
	git -C "$d" checkout -q -b side; echo b > "$d/b"; git -C "$d" add -A; git -C "$d" commit -qm 'fix(side): a side fix'
	git -C "$d" checkout -q "$base"; git -C "$d" merge -q --no-ff side -m 'Merge branch side'
	echo c > "$d/c"; git -C "$d" add -A; git -C "$d" commit -qm 'chore(release): v0.0.0'
	mkdir -p "$d/src/app/i18n/de"; echo '{}' > "$d/src/app/i18n/de/main.json"
	git -C "$d" add -A; git -C "$d" commit -qm 'feat: German strings'
	ci_expect excl 1.1.0 "ci-excludes-noise-version"
	f="$tmp/excl/changelogs/v1.1.0.md"
	if [ -f "$f" ] && grep -q 'real feature' "$f" && grep -q 'side fix' "$f" \
		&& ! grep -qiE 'Merge branch|chore\(release\)|v0\.0\.0' "$f" \
		&& sed -n '/### Translations/,$p' "$f" | grep -q 'German strings'; then
		echo "selftest ci-excludes-noise-notes: PASS"
	else echo "selftest ci-excludes-noise-notes: FAIL"; fail=1; fi

	# a prepared (pre-curated) per-version changelog survives a --ci run
	mk prep <<-'EOF'
	feat(x): a feature
	EOF
	mkdir -p "$tmp/prep/changelogs"; printf '## v1.1.0 (2000-01-01)\n\nhand-curated note\n' > "$tmp/prep/changelogs/v1.1.0.md"
	TWC_REPO="$tmp/prep" bash "$self" --ci >/dev/null 2>&1 || true
	if grep -q 'hand-curated note' "$tmp/prep/changelogs/v1.1.0.md"; then echo "selftest ci-preserves-curated: PASS"; else echo "selftest ci-preserves-curated: FAIL"; fail=1; fi

	# --asset: src/ only, every cache key stamped, checksum valid, reproducible, tag/version agree
	d="$tmp/asset"; mkdir -p "$d"; git -C "$d" init -q
	git -C "$d" config user.email t@t; git -C "$d" config user.name t
	seed_tree "$d" 1.2.3
	printf '<script type="module" src="app/js/main.js?v=__QBV__"></script>\n' > "$d/src/index.html"
	printf "import { VERSION } from './version.js?v=__QBV__';\n" > "$d/src/app/js/main.js"
	printf '\0\1__QBV__\2' > "$d/src/app/blob.bin"
	echo x > "$d/bin/tool.sh"; echo x > "$d/README.md"
	git -C "$d" add -A; git -C "$d" commit -qm 'chore: seed'; git -C "$d" tag v1.2.3
	rm "$d/src/app/blob.bin"; git -C "$d" commit -qam 'chore: drop blob'; git -C "$d" tag -f v1.2.3 >/dev/null
	local o1="$tmp/out1" o2="$tmp/out2" x="$tmp/x" tgz=transmission-web-control-v1.2.3.tar.gz
	TWC_REPO="$d" bash "$self" --asset "$o1" --ref v1.2.3 >/dev/null 2>&1 || true
	mkdir -p "$x"; tar -xzf "$o1/$tgz" -C "$x" 2>/dev/null || true
	if [ -f "$x/src/index.html" ] && [ -z "$(tar -tzf "$o1/$tgz" 2>/dev/null | grep -v '^src/' || true)" ]; then
		echo "selftest asset-src-only: PASS"; else echo "selftest asset-src-only: FAIL"; fail=1; fi
	if [ -f "$x/src/app/js/main.js" ] && ! grep -rqF '__QBV__' "$x" && grep -qF 'main.js?v=1.2.3' "$x/src/index.html"; then
		echo "selftest asset-stamped: PASS"; else echo "selftest asset-stamped: FAIL"; fail=1; fi
	if ( cd "$o1" && sha256sum -c --quiet SHA256SUMS ) >/dev/null 2>&1; then
		echo "selftest asset-checksum: PASS"; else echo "selftest asset-checksum: FAIL"; fail=1; fi
	TWC_REPO="$d" bash "$self" --asset "$o2" --ref v1.2.3 >/dev/null 2>&1 || true
	if [ -s "$o1/SHA256SUMS" ] && cmp -s "$o1/SHA256SUMS" "$o2/SHA256SUMS"; then
		echo "selftest asset-reproducible: PASS"; else echo "selftest asset-reproducible: FAIL"; fail=1; fi
	git -C "$d" tag v9.9.9
	local ec=0; TWC_REPO="$d" bash "$self" --asset "$tmp/out3" --ref v9.9.9 >/dev/null 2>&1 || ec=$?
	if [ "$ec" != 0 ] && [ ! -e "$tmp/out3/transmission-web-control-v9.9.9.tar.gz" ]; then
		echo "selftest asset-tag-mismatch-refused: PASS"; else echo "selftest asset-tag-mismatch-refused: FAIL"; fail=1; fi
	# a binary that still carries the placeholder is refused, never shipped half-stamped
	git -C "$d" checkout -q v1.2.3~1
	ec=0; TWC_REPO="$d" bash "$self" --asset "$tmp/out4" >/dev/null 2>&1 || ec=$?
	if [ "$ec" != 0 ] && [ ! -e "$tmp/out4/SHA256SUMS" ]; then
		echo "selftest asset-unstamped-binary-refused: PASS"; else echo "selftest asset-unstamped-binary-refused: FAIL"; fail=1; fi
	return "$fail"
}

if [ "$do_selftest" = 1 ]; then selftest; exit $?; fi
if [ -n "$asset_dir" ]; then build_asset "$asset_dir" "$asset_ref"; exit 0; fi
run_release
