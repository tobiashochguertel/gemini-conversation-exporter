# Gemini Conversation Exporter

A local Tampermonkey userscript that exports the currently open Gemini Web
conversation as Markdown.

Unlike DOM-scrolling exporters, it reads Gemini's own paginated conversation
history response. The exporter keeps the active branch in server order and
preserves Gemini's original Markdown and LaTeX source.

## Privacy

The userscript runs only on Gemini conversation pages:
`https://gemini.google.com/app/*` and
`https://gemini.google.com/u/*/app/*`. It makes no third-party requests and
does not collect analytics. Conversation data stays between the signed-in
Gemini page and the Markdown file downloaded by the browser.

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

The script adds an **Export Markdown** button in the lower-right corner. One
click downloads the complete active branch as a `.md` file.

Use the adjacent **⋮** button to:

- include or omit the linked conversation outline;
- include or omit source, export, validation, and per-turn metadata;
- switch between the expanded and compact export control.

All three preferences are stored by Tampermonkey and persist across browser
sessions. The outline and metadata are enabled by default.

Tampermonkey stores the userscript in the current browser profile. It persists
across Codex tasks and project restarts; the local server is needed only while
installing or updating the script.

Greasy Fork automatically syncs released code from the committed userscript on
the `main` branch.

## Output

The file includes:

- conversation title and source URL;
- export timestamp, conversation ID, turn count, and validation fingerprint;
- stable response/candidate identifiers in HTML comments;
- a linked turn outline using short previews of user prompts and stable
  cross-renderer turn anchors;
- explicit User and Gemini role boundaries;
- the original user and Gemini Markdown, including `$...$` and `$$...$$`
  equations, tables, lists, links, and fenced code.

## Scope and limitations

- Exports the active branch of the currently open conversation.
- Does not traverse the Gemini sidebar or bulk-export account history.
- Does not download uploaded files or generated media.
- Uses an undocumented Gemini Web RPC. If Google changes that response shape,
  the exporter is designed to stop with an error instead of silently writing a
  partial or reordered file.

## Maintenance note

Gemini's history RPC and response indexes are private implementation details.
The script therefore validates the expected shape and refuses to produce a file
when that shape changes. A future Gemini update may require adjusting the RPC
identifier or turn-field indexes.

[greasy-fork]: https://greasyfork.org/en/scripts/588720-gemini-conversation-exporter
