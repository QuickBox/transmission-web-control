# Contributing

Thanks for helping with the QuickBox web interface for Transmission. This page tells you how the code is laid out, which checks a change must pass, and how a change becomes a release.

## What you are working on

The app is plain ES modules, CSS and JSON under `src/app/`. There is no build step and no dependency to install. Node 22 runs the checks. The browser loads `src/index.html`, which loads `app/js/main.js`; every module exports `mount(root, ctx)` and renders into its own region of the page.

## Setup and checks

Clone the repo, switch to `devop`, and run the same checks CI runs:

```sh
bash bin/ci-local.sh
```

That runs, in order: the static gates (`node tools/check.mjs`), their self-test, a syntax check of every module, the test suite (`node --test "tests/**/*.test.js"`), the commit message check, the version consistency check, and the release tool self-test. A change is ready when all of them pass.

## Rules the gates enforce

Each rule exists for a reason, and `tools/check.mjs` or the test suite fails the change when it is broken.

- Text only, never markup. Build DOM with `el()` from `core/dom.js`, which sets text through `textContent` and refuses markup sinks. Torrent names, tracker messages and peer client strings come from strangers.
- No hex colors outside `css/tokens.css`. Every color is a token, so the four themes stay consistent and a theme change is one file.
- No undefined tokens. A `var(--name)` must name a token that a stylesheet defines or a script sets, because an undefined one paints nothing and fails silently.
- No native `title=`. Tooltips go through `ctx.ui.tooltip`, which is keyboard reachable and themed; the browser one is neither.
- No remote URLs. The interface talks to the Transmission daemon beside it and nothing else, so nothing leaks and nothing breaks when a third party changes.
- No `rpc-version` reads outside `rpc/caps.js`. Feature gates come from `caps`, so a new Transmission release is handled in one place.
- Patch DOM in place on polls. Create interactive nodes once and update their text and attributes; rebuilding them steals keyboard focus and drops a click that spans a poll.
- Refresh after every torrent write. Call `refreshAfterWrite(ctx, ids)` after a successful write, because the daemon's activity delta does not report idle torrents, so the change would stay invisible until a reload.
- Modules are `.js` files imported with the `?v=__QBV__` stamp. The release build replaces the stamp with the version, so browsers never serve a stale module after an update.

## Supporting Transmission versions

The interface supports Transmission 2.94 through 4.1.x. Read the daemon version only through `caps` (`rpc/caps.js`); never compare an RPC number in a UI module. Tests run against recorded daemon captures under `tests/fixtures/`, one folder per version, so a change is checked against every supported daemon without one running. New captures are recorded from real daemons, never written by hand.

## Branches and commits

- The work branch is `devop`. Open pull requests against it. `main` is release only.
- Commit subjects are conventional: `type(scope): subject`, where the type is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `test` or `style`. `bin/check-version.sh messages` enforces this in CI.
- Only changes to what the release archive ships cut a version: `src/` and `LICENSE`. A commit that touches neither, such as README, `docs/`, this file, `TRANSLATING.md`, tests, tooling or workflows, never bumps the version or appears in the release notes. `feat` bumps the minor version, `fix`, `perf` and `refactor` the patch version, and a `!` or a `BREAKING CHANGE` body the major version.

## Translations

Catalogs live under `src/app/i18n/`. See `TRANSLATING.md` for how to add or update a language.

## Reporting issues and getting help

Issues are not tracked on this repository. Support for the interface is given only on the QuickBox Discord server: https://discord.gg/mca7RSv5pa

## License

MIT. See `LICENSE`.
