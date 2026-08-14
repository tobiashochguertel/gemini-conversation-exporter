# Gemini Conversation Exporter

> **Fork notice:** This is a fork of
> [dikelps/gemini-conversation-exporter](https://github.com/dikelps/gemini-conversation-exporter)
> with refactoring improvements (modular architecture, extracted framework
> libraries, externalized CSS, JSON export, complete turn data preservation).
>
> The installable userscript is published via GitHub:
> [raw dist file](https://raw.githubusercontent.com/tobiashochguertel/gemini-conversation-exporter/main/dist/gemini-conversation-exporter.user.js)

A local Tampermonkey userscript that exports the currently open Gemini Web
conversation as Markdown or JSON.

Unlike DOM-scrolling exporters, it reads Gemini's own paginated conversation
history response. The exporter keeps the active branch in server order and
preserves Gemini's original Markdown and LaTeX source.

## Privacy

The userscript runs only on `https://gemini.google.com/*`. It remains hidden
outside conversation routes, including on the new-chat landing page, and
appears after a conversation is opened. It makes no third-party requests and
does not collect analytics. Conversation data stays between the signed-in
Gemini page and the file downloaded by the browser.

## Reliability behavior

- Retrieves every history page rather than relying on rendered/virtualized
  messages.
- Preserves Gemini's numeric account slot when requesting history, so secondary
  accounts such as `/u/1/` do not fall back to account 0.
- Reverses Gemini's observed response sequence only once: server pages arrive
  newest-first and the file is written oldest-first.
- Deduplicates overlapping history pages by stable response ID.
- Verifies that every turn has both a user message and a Gemini response.
- Verifies that the active response chain is continuous.
- Stops on repeated pagination cursors, missing content, duplicate IDs, or a
  changed response shape.
- Reports a deterministic validation fingerprint for comparing repeat exports.
- Makes no third-party requests. Conversation data stays between the browser,
  Gemini, and the downloaded local file.

## Build and test

```bash
npm run check
```

The installable result is:

```text
dist/gemini-conversation-exporter.user.js
```

## Install

### From GitHub (recommended)

1. Install and enable Tampermonkey in Chrome or Firefox.
2. Open the raw userscript URL:

   ```
   https://raw.githubusercontent.com/tobiashochguertel/gemini-conversation-exporter/main/dist/gemini-conversation-exporter.user.js
   ```

3. Approve the Tampermonkey installation or update.
4. Open or reload a Gemini conversation.

Tampermonkey will check for updates automatically via the `@updateURL`
metadata directive pointing to the same raw URL on the `main` branch.

### Greasy Fork

1. Install and enable Tampermonkey in Chrome or Firefox.
2. Open [Gemini Conversation Exporter on Greasy Fork][greasy-fork].
3. Select **Install this script**.
4. Open or reload a Gemini conversation.

### Local development build

1. Install and enable Tampermonkey in Chrome or Firefox.
2. Build and serve the project:

   ```bash
   npm run build
   python3 -m http.server 8765 --bind 127.0.0.1
   ```

3. Open this URL in the browser:

   ```text
   http://127.0.0.1:8765/dist/gemini-conversation-exporter.user.js
   ```

4. Approve the Tampermonkey installation or update.
5. Open or reload a Gemini conversation.

## Usage

The script adds two export buttons in the lower-right corner:

- **Export Markdown** (↓) — downloads the complete active branch as a `.md` file
- **Export JSON** ({ }) — downloads the complete active branch as a `.json` file

Use the adjacent **⋮** button to:

- include or omit the linked conversation outline;
- include or omit source, export, validation, and per-turn metadata;
- switch between the expanded and compact export control;
- choose a download strategy (see below).

All four preferences are stored by Tampermonkey and persist across browser
sessions. The outline and metadata are enabled by default.

### Download strategies

| Strategy | Description |
|----------|-------------|
| **Link only** (default) | Renders authenticated download URLs as links in the Markdown/JSON output. No file download. |
| **ZIP bundle** | Downloads all generated files (images, documents, etc.) and bundles them with the Markdown and JSON export into a single `.zip` file. Uses [fflate](https://github.com/101arrowz/fflate) for ZIP creation. |

The ZIP bundle strategy fetches generated files using the page's authenticated
session (Google cookies) and includes them in the archive under
`generated-files/`.

Tampermonkey stores the userscript in the current browser profile. It persists
across browser restarts; the local server is needed only while installing or
updating the script from a local build.

## Output

### Markdown

The `.md` file includes:

- conversation title and source URL;
- export timestamp, conversation ID, turn count, and validation fingerprint;
- a linked turn outline using short previews of user prompts and stable
  cross-renderer turn anchors;
- per-turn HTML metadata comments with: turn number, source index, response
  and parent response IDs, candidate and parent candidate IDs, timestamp,
  model, and language;
- explicit User, Thinking, and Gemini role boundaries;
- the original user and Gemini Markdown, including `$...$` and `$$...$$`
  equations, tables, lists, links, and fenced code;
- thinking/reasoning text in a collapsible `<details>` block;
- web search citations section;
- extension/tool results in a collapsible `<details>` block with JSON payload;
- feedback/rating groups in a collapsible `<details>` block with JSON payload.

### JSON

The `.json` file includes:

- `title`, `sourceUrl`, `conversationId`, `exportedAt`, `turnCount`;
- `validation` object with fingerprint, duplicate bodies, timestamp
  regressions, and markdown warnings;
- `turns` array where each turn contains: `index` (1-based chronological),
  `sourceIndex` (0-based raw API position), `userMarkdown`,
  `assistantMarkdown`, `responseId`, `parentResponseId`, `candidateId`,
  `parentCandidateId`, `timestamp`, `model`, `language`, `thinking`,
  `webCitations`, `extensions`, and `feedback`.

Both formats export the complete turn object — every field extracted from
Gemini's API response is preserved in the output.

## Scope and limitations

- Exports the active branch of the currently open conversation.
- Does not traverse the Gemini sidebar or bulk-export account history.
- Uses an undocumented Gemini Web RPC. If Google changes that response shape,
  the exporter is designed to stop with an error instead of silently writing a
  partial or reordered file.

## Browser compatibility

The userscript uses `@sandbox raw` (Tampermonkey's default), running in the
page context (`MAIN_WORLD`). This is required for the ZIP bundle feature to
work on Firefox — Firefox's `USERSCRIPT_WORLD` (used by `@sandbox JavaScript`)
applies Xray security wrappers that block access to `TypedArray`/
`ArrayBuffer` data across realms, breaking `TextEncoder`, `fetch.arrayBuffer()`,
`Blob`, and other Web APIs needed for binary file handling.

See the [JSZip Xray Test gist](https://gist.github.com/tobiashochguertel/eb70fbd57f5c7bdea7b4381d3bfdfec1)
for a detailed investigation of the Xray boundary issue.

## Development

### Release workflow

This project uses [conventional commits](https://www.conventionalcommits.org/)
enforced by [hk](https://hk.jdx.dev) git hooks:

- **commit-msg hook** — validates commit messages at commit time
- **pre-push hook** — safety net that validates commit messages before they
  reach the remote (catches `--no-verify` bypasses)

To cut a release:

```bash
npm run release
```

This auto-detects the bump level (patch/minor/major) from conventional
commits since the last tag, bumps the version, builds, tests, generates
changelog via [communique](https://communique.jdx.dev), commits, tags, and
pushes.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the daily workflow guide.

## Maintenance note

Gemini's history RPC and response indexes are private implementation details.
The script therefore validates the expected shape and refuses to produce a file
when that shape changes. A future Gemini update may require adjusting the RPC
identifier or turn-field indexes.

[greasy-fork]: https://greasyfork.org/en/scripts/588720-gemini-conversation-exporter
