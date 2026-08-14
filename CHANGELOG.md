# Changelog

## 0.3.1 - 2026-08-14

Version 0.3.1 (patch release).

## 0.3.0 - 2026-08-14

Version 0.3.0 (minor release).



## 0.2.1 - 2026-08-14

- Fix menu button toggle — inverted logic (`!panel.hidden` → `panel.hidden`)
  prevented the options panel from opening.
- Add configurable log level via Tampermonkey storage. Control from the
  browser console: `GeminiExporter.log.setLevel("none" | "error" | "warn" |
  "info" | "debug")`. Level persists across page reloads.
- Add `PreferenceStorage.readString` / `writeString` for string preferences.
- Replace all `console.*` calls with level-aware `log.*` methods.
- Fix `main` branch tracking — now tracks `origin/main` (fork) instead of
  `upstream/main`.

## 0.2.0 - 2026-07-27 (fork)

- Fork from [dikelps/gemini-conversation-exporter](https://github.com/dikelps/gemini-conversation-exporter).
- Externalize Shadow DOM CSS into `src/exporter-ui.css`, inlined at build time
  via a `__EXPORTER_UI_CSS__` token replaced with `JSON.stringify`.
- Extract generic Tampermonkey preference wrappers into `src/preference-storage.js`
  (`PreferenceStorage.readBoolean` / `writeBoolean`).
- Extract generic utilities into `src/utils.js` (`Utils.makeRequestId`,
  `Utils.cloneForPageRealm`, `Utils.downloadTextFile`).
- Extract generic paginated history fetcher into `src/history-fetcher.js`
  (`HistoryFetcher.fetchPage`) using an adapter pattern. Site-specific behavior
  is injected via `createGeminiAdapter` in `userscript-main.js`.
- Extract generic Shadow DOM UI builders into `src/ui.js` (`Ui.createShadowRoot`,
  `createToast`, `createCheckboxOption`, `createExportControl`, `createOptionsPanel`,
  `createStack`). Builders return state setters (`setOpen`, `setBusy`,
  `setCollapsed`, `setMenuExpanded`, `setCompactToggleLabel`) so callers compose
  UI state without touching DOM directly.
- Move static constants (`ROOT_ID`, `HISTORY_PAGE_SIZE`, `PREFERENCE_KEYS`) before
  the IIFE for a clear boundary between config and runtime logic.
- Remove the 240-line `createUi` wrapper — UI assembly is now inline in the IIFE
  using focused builder functions.
- Update author, homepage, support URL, and repository links to the fork.
- Add fork notice to README and dual copyright to LICENSE.
- Add 42 new tests across `test/preference-storage.test.js`,
  `test/utils.test.js`, `test/history-fetcher.test.js`, and `test/ui.test.js`.

## 0.1.8 - 2026-07-27

- Load the userscript throughout `https://gemini.google.com/*` so Gemini can
  navigate into a conversation from any same-origin route without requiring a
  page reload. The export control remains hidden outside conversation routes.

## 0.1.7 - 2026-07-27

- Load the userscript on the exact `/app` and `/u/<account>/app` new-chat
  landing routes so its existing SPA route watcher can reveal the export
  control after a prompt is sent or a conversation is selected.

## 0.1.6 - 2026-07-27

- Render turn headings as their literal stable anchors (`## turn-1`, `## turn-2`,
  and so on) so outline links work consistently across Obsidian and
  slug-based Markdown renderers.

## 0.1.5 - 2026-07-27

- Add a compact split export control with an on-page options popover.
- Remember compact mode and export preferences across browser sessions.
- Add optional export metadata, enabled by default.
- Add an optional linked conversation outline with prompt previews, enabled by
  default.

## 0.1.4 - 2026-07-27

- Preserve Gemini's `/u/<account>/` prefix on history RPC requests.
- Forward the active Gemini `pageId` query parameter to the history RPC.
- Fix HTTP 400 errors when exporting from secondary signed-in accounts.

## 0.1.3 - 2026-07-27

- Support account-scoped Gemini URLs such as `/u/0/app/...`.
- Use Tampermonkey's JavaScript sandbox so Firefox can inject through Gemini's
  Content Security Policy.
- Clone page-fetch request options into Firefox's page realm.

## 0.1.2 - 2026-07-27

- Prepare the first public release.
- Add project, support, author, and license metadata.
- Generate the userscript version from `package.json`.
- Document privacy, limitations, installation, and maintenance behavior.

## 0.1.1 - 2026-07-27

- Replace Shadow DOM `innerHTML` construction with Trusted Types-compatible
  DOM APIs.
- Add a regression test for Gemini's Trusted Types policy.

## 0.1.0 - 2026-07-27

- Initial working exporter using Gemini's paginated conversation history RPC.
