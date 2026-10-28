# Translating the QuickBox Transmission web UI

The web UI speaks your language. It ships its own string catalogs and a translation for each of QuickBox's supported languages, and you are welcome to add more or improve what is there.

## Shipped languages

Seven languages are complete. They carry every string.

| Code | Language |
|---------|----------------------|
| `en` | English (the base catalog) |
| `da` | Danish |
| `de` | German |
| `es` | Spanish |
| `fr` | French |
| `pt-BR` | Portuguese (Brazil) |
| `zh-CN` | Chinese (Simplified) |

Ten more are partial. They translate part of the UI, and English fills in the rest.

| Code | Language |
|---------|----------------------|
| `hu` | Hungarian |
| `zh-TW` | Chinese (Traditional) |
| `nl` | Dutch |
| `ru` | Russian |
| `uk` | Ukrainian |
| `ko` | Korean |
| `it` | Italian |
| `ro` | Romanian |
| `pl` | Polish |
| `pt-PT` | Portuguese (Portugal) |

Codes are case sensitive in the folder names: `pt-BR`, `zh-CN`, `zh-TW` and `pt-PT` keep their capitals.

## How the language is chosen

The UI checks these sources in order and uses the first one that names a language it ships:

1. The language you pick in Settings, under Interface. It is saved in your browser as `qb-transmission-lang`. Choosing Auto clears it.
2. The `Language` cookie that the QuickBox dashboard writes.
3. Your browser languages, in the order the browser lists them.
4. English.

Tags are matched loosely. `pt-br`, `zh_TW` and `de-AT` all work. `pt` alone means `pt-BR`, and `zh` alone means `zh-CN`. A Chinese tag with `Hant`, `TW`, `HK` or `MO` in it means `zh-TW`.

Changing the language in Settings reloads the page.

## Where the catalogs live

Each language has one folder with four files:

```
src/app/i18n/<code>/core.json      shared words, status names, units, accessibility labels
src/app/i18n/<code>/main.json      the torrent list, toolbar, sidebar and status bar
src/app/i18n/<code>/details.json   the torrent details panel
src/app/i18n/<code>/dialogs.json   dialogs, Settings and the tools
```

A language must also be listed in `src/app/i18n/manifest.json`, so the UI only asks for files that exist:

```json
"nl": ["core", "details", "main", "dialogs"]
```

List only the files you actually ship. `node tools/check.mjs` fails if the manifest names a file that is missing, if a file on disk is not listed, or if it names a language or file the app does not know.

## Rules for the strings

Start from the English files in `src/app/i18n/en/`. They are the source of truth.

- **Same key tree.** Keep the same nested keys as `en`. Translate the values only. Never rename a key.
- **Keep every placeholder.** Tokens like `{count}`, `{name}`, `{total}`, `{message}` and `{n}` are filled in at run time. Keep each one exactly as written, with the same name. You may move a token to wherever your grammar needs it.
- **Plurals.** A value that is an object with plural categories is a plural message. The UI picks the category with the browser's plural rules for your language, using `{count}`. Always provide `other`. Add `one`, and any other category your language uses (`zero`, `two`, `few`, `many`). If a category is missing, `other` is used.
- **Plain text only.** Values are shown as text and never as markup. Do not add HTML tags or entities.
- **No links or color codes.** `tools/check.mjs` also scans the JSON files, so a value must not contain a full web address or a `#` followed by hex digits.
- **Names stay as written.** Transmission, QuickBox, RPC, JSON-RPC, µTP, TCP, IPv4, IPv6 and kB/s stay as they are, and so does the example announce URL.
- **Units.** `core.units.size1000` and `core.units.size1024` are lists of exactly six words separated by single spaces (bytes up to petabytes). Keep six. In `perSecond`, `day`, `hour`, `minute` and `second`, keep `{size}` and `{n}`.
- **Be short and plain.** These strings sit on buttons and in narrow columns. Use the same word for the same idea everywhere in your catalog.
- **Valid JSON.** Use UTF-8 and double quotes. The week days in `dialogs.json` are keyed `"0"` to `"6"`, starting with Sunday.

## English fills the gaps

Every key falls back to English on its own. If a key is missing from your file, or a whole file is missing, the UI shows the English text for it. If the English key is also missing, the key name shows. A partial translation is safe to ship, and nothing renders blank.

A value that is not text is ignored, so it falls back to English too.

## Check your work

From the repo root:

1. Run `node tools/check.mjs`. It scans the shipped app, including the catalogs and the manifest, and prints `check: ok` when all is well.
2. Run `node --test "tests/**/*.test.js"`.
3. Compare your files with `en`. There is no script for this, so do it by hand or with a few lines of your own. For each of the four files, flatten both JSON trees to dotted keys. A complete language has no key that `en` has and it lacks, and no key that `en` lacks. For every key, the set of `{placeholders}` must match English exactly, and no value may be empty. A plural message must have `other`. Partial languages may skip keys but must not add any.
4. Try it live. Pick your language in Settings under Interface, or set `qb-transmission-lang` in your browser, then hard-refresh so the new files load.

`bash bin/ci-local.sh` runs the full set of project checks in one go.

## Adding a language that is not listed

Make `src/app/i18n/<code>/` with your four files, and add the code to `src/app/i18n/manifest.json`.

A new code also has to be known to the app. A maintainer adds it to the language lists and its own-language name in `src/app/js/core/i18n.js` when your translation is merged. Until then `tools/check.mjs` reports the language as unknown. To test your files, add the code to those lists in your own copy.

## Submitting

Open a pull request against the `devop` branch of this repo.

Use a conventional commit subject that starts with `feat(i18n):`, for example `feat(i18n): add Dutch catalogs`. Use `fix(i18n):` when you correct existing strings. `bin/check-version.sh` rejects subjects that are not conventional commits.

Either way, thank you for helping more people use the web UI in their own language.
