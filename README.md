# Transmission web interface for QuickBox

This is the web UI that QuickBox installs for Transmission. It replaces the stock interface with one that looks and behaves like the QuickBox dashboard: same themes, same density, same keyboard habits. It is a static app. It talks to the Transmission daemon over its RPC endpoint and nothing else.

## Supported Transmission versions

| Transmission | RPC | What the UI does |
|---|---|---|
| 2.94 | 15 | Full control. Labels are kept in the browser. |
| 3.00 | 16 | Native labels, shared with every other client. |
| 4.0.x | 17 | Tracker lists edited as tiered text. |
| 4.1.x | 19, semver 6.x | JSON-RPC 2.0 on the wire, sequential download, IPv4 and IPv6 port checks. |

The UI detects the daemon once at startup and turns features on or off from that. Nothing is hard coded to a version number.

## Features

- Torrent list that stays fast with thousands of torrents. Only the rows on screen are rendered. Sort by any column.
- Sidebar filters for status, labels, trackers and folders, with live counts.
- Search with `Ctrl K`. Multi-select with click, Shift and Ctrl, or the keyboard. Bulk start, pause, remove, move, speed limits, queue order.
- Details for the selected torrent: general info, files with per-file priority, trackers, peers and per-torrent options.
- Add torrents by file, magnet link or drag and drop. Remove with or without data. Set location, rename, labels, replace trackers across torrents, and point a torrent at data that already exists on disk.
- Settings for the daemon: downloading, seeding, speed and schedule, peers, network and the peer port test.
- Status bar with live rates and limits, temporary speed limits, free space, port status and the daemon version.
- Four themes that follow the QuickBox dashboard: Spectre, Smoked, Reel and Light. Works from 375 px phones to 1920 px desktops. Screen reader friendly: the list is a real grid, every control has a name, and there are no native tooltips.

Torrent names, tracker messages and peer client strings are always rendered as text. The app never builds HTML from data.

## Install

The interface ships with QuickBox. `qb install transmission` puts it in place, and `qb update transmission` keeps it current. There is nothing to build and nothing to configure. Open Transmission from the QuickBox dashboard or at `/transmission/web/` on your server.

To go back to the interface that comes with Transmission, open `index.original.html` in the same folder, or use the link in the About dialog.

## Themes and language

The UI reads the dashboard's `qb_theme` cookie and follows it. You can also pick a theme from the palette button in the toolbar; that pick is remembered in this browser and wins over the cookie.

The language follows the dashboard's `Language` cookie, then the browser language. English ships today. The dashboard's other languages are added as their catalogs land in `src/app/i18n/`.

## Development

The app is plain ES modules, CSS and JSON. There is no build step and no dependency to install. Node 22 runs the checks:

```sh
bash bin/ci-local.sh
```

That runs the static gates (`node tools/check.mjs`), a syntax check of every module, the test suite, and the commit message and version checks, in the same order as CI. Tests run against recorded RPC captures from Transmission 2.94, 3.00, 4.0.6 and 4.1.3, so a change is checked against every supported daemon without one running.

## Releases

Development happens on `devop`; `main` is the release branch. A push to `main` derives the next version from the commit subjects, writes the changelog, tags, and publishes a stamped tarball of `src/` with its checksum. QuickBox installs pull that tarball through the QuickBox release service.

Release notes are in `CHANGELOG.md`. Notes from before the QuickBox version are in `CHANGELOG-EN.md`.

## Credits and license

Based on Transmission Web Control by ronggang (MIT). The QuickBox version is a rewrite of the interface under the same license; see `LICENSE`. Icon glyphs are from Material Design Icons; see `src/app/NOTICE`.
