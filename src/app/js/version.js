/**
 * The web UI version. `bin/release.sh` writes it when a release is cut, and
 * `bin/check-version.sh consistency` keeps it equal to `package.json` and the
 * newest `changelogs/index.json` entry. 0.0.0 marks a tree before its first
 * release.
 */
export const VERSION = '0.0.0';
