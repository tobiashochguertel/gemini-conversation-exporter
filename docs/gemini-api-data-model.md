# Gemini Internal API — Data Model Reference

> **Observed:** 2026-08-14 against `gemini.google.com` build
> `boq_assistant-bard-web-server_20260813.10_p0`.
> Gemini's internal API is undocumented and changes frequently. This
> document describes what was observed at capture time.
>
> **Updated:** 2026-08-14 — documented generated file structure
> (`extension['59']`), file URLs, file tags in assistant markdown,
> and code execution metadata (`extension['33']`).

## Endpoint

```
POST https://gemini.google.com/_/BardChatUi/data/batchexecute
```

For account-scoped URLs the path is prefixed with the account slot:

```
POST https://gemini.google.com/u/<N>/_/BardChatUi/data/batchexecute
```

### Query parameters

| Parameter     | Source                          | Example value                                  |
| ------------- | ------------------------------- | ---------------------------------------------- |
| `rpcids`      | The RPC method to call          | `hNvQHb`                                       |
| `source-path` | `location.pathname`             | `/app/<conversationId>`                        |
| `bl`          | `WIZ_global_data.cfb2h`         | `boq_assistant-bard-web-server_<date>.<n>_p0` |
| `f.sid`       | `WIZ_global_data.FdrFJe`        | `<session-id>`                                 |
| `hl`          | `document.documentElement.lang` | `en`                                           |
| `_reqid`      | Random 7-digit ID               | `2877835`                                      |
| `rt`          | Response type                   | `c`                                            |
| `pageId`      | Optional, from `location.search`| —                                              |

### Request headers

```
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
X-Same-Domain: 1
```

`X-Same-Domain: 1` is required — without it the request is rejected
as an XSRF violation. Cookies are sent automatically with
`credentials: "same-origin"`.

### Request body

The body is URL-encoded with two fields:

| Field   | Description                                   |
| ------- | --------------------------------------------- |
| `f.req` | JSON-encoded RPC envelope (see below)         |
| `at`    | XSRF token from `WIZ_global_data.SNlM0e`      |

#### RPC envelope structure

```jsonc
// f.req = JSON.stringify([[rpcCall]])
[
  [
    ["<rpcId>", "<jsonStringifiedArgs>", null, "generic"]
  ]
]
```

Example for `hNvQHb` (history fetch):

```jsonc
[
  [
    [
      "hNvQHb",
      "[\"c_<conversationId>\",50,null,1,[0],[4],null,1]",
      null,
      "generic"
    ]
  ]
]
```

The RPC arguments for `hNvQHb` are:

| Index | Type    | Meaning                              |
| ----- | ------- | ------------------------------------ |
| 0     | string  | Conversation ID (prefixed with `c_`) |
| 1     | number  | Page size (50)                       |
| 2     | string? | Pagination cursor, or `null`         |
| 3     | number  | Unknown flag (1)                     |
| 4     | array   | `[0]`                                |
| 5     | array   | `[4]`                                |
| 6     | null    | —                                    |
| 7     | number  | Unknown flag (1)                     |

### Response format

The response is a streaming-style text format:

```
)]}'
<chunkLength>
<jsonChunk>
<chunkLength>
<jsonChunk>
...
```

The first line is always `)]}'` (an XSSI guard). Each subsequent
chunk is preceded by its byte length on its own line. The main payload
is the chunk whose JSON starts with `[["wrb.fr","<rpcId>",...`.

Parsing steps:
1. Strip the `)]}'` prefix
2. Split by newlines
3. For each `<length>\n<json>` pair, parse the JSON
4. Find the chunk where `parsed[0][0] === "wrb.fr"` and
   `parsed[0][1] === "<rpcId>"`
5. `parsed[0][2]` is a JSON string — parse it again to get the data

## `WIZ_global_data`

A global JS object on the Gemini page containing 129 configuration
keys. Three are required for history fetching:

| Key       | Purpose                              | Example                                  |
| --------- | ------------------------------------ | ---------------------------------------- |
| `cfb2h`   | Build label (`bl` query param)       | `boq_assistant-bard-web-server_...`      |
| `FdrFJe`  | Session ID (`f.sid` query param)     | `<session-id>`                           |
| `SNlM0e`  | XSRF token (`at` body field)         | `<xsrf-token>`                           |

## Observed RPC IDs

These RPC IDs were observed on a single conversation page load. Only
`hNvQHb` is used by this exporter; the others are listed for
reference.

| RPC ID    | Observed frequency | Purpose (inferred)                          |
| --------- | ------------------ | ------------------------------------------- |
| `hNvQHb`  | 2×                 | **History fetch** — returns conversation turns |
| `L5adhe`  | 6×                 | Conversation metadata / lightweight history |
| `CNgdBe`  | 3×                 | Unknown (frequent, possibly model config)   |
| `TUa2Cd`  | 1×                 | Unknown                                     |
| `aPya6c`  | 1×                 | Unknown                                     |
| `ku4Jyf`  | 1×                 | Unknown                                     |
| `o30O0e`  | 1×                 | Unknown                                     |
| `I4z33b`  | 1×                 | Unknown                                     |
| `ozz5Z`   | 1×                 | Unknown                                     |
| `whPPme`  | 1×                 | Unknown                                     |
| `qpEbW`   | 1×                 | Unknown                                     |
| `Te6DCf`  | 1×                 | Unknown                                     |
| `K4WWud`  | 1×                 | Unknown                                     |
| `maGuAc`  | 1×                 | Unknown (longest duration: 614ms)           |
| `GPRiHf`  | 1×                 | Unknown                                     |
| `cYRIkd`  | 1×                 | Unknown                                     |
| `ESY5D`   | 1×                 | Unknown                                     |
| `MaZiqc`  | 1×                 | Unknown                                     |
| `otAQ7b`  | 1×                 | Unknown                                     |
| `sJBwce`  | 1×                 | Unknown                                     |

## `hNvQHb` Response Data Model

After parsing, the response is a 4-element array:

```
parsedHistory = [
  turns[],    // [0] — array of turns, newest-first
  null,       // [1]
  null,       // [2]
  []          // [3]
]
```

### Turn structure

Each turn is a 5-element array:

```
turn = [
  header[2],      // [0] — conversation + response IDs
  parentRef[3]?,  // [1] — parent turn reference, or null for first turn
  metadata[11],   // [2] — user prompt metadata
  turnMeta[26],   // [3] — turn-level metadata + candidates
  footer[2]       // [4] — timestamp
]
```

#### `turn[0]` — header

| Index | Type   | Meaning          | Example                    |
| ----- | ------ | ---------------- | -------------------------- |
| 0     | string | Conversation ID  | `c_<conversationId>`       |
| 1     | string | Response ID      | `r_<responseId>`           |

#### `turn[1]` — parent reference (null for first turn)

| Index | Type   | Meaning                | Example                    |
| ----- | ------ | ---------------------- | -------------------------- |
| 0     | string | Conversation ID        | `c_<conversationId>`       |
| 1     | string | Parent response ID     | `r_<parentResponseId>`     |
| 2     | string | Parent candidate ID    | `rc_<parentCandidateId>`   |

#### `turn[2]` — user prompt metadata

| Index | Type     | Meaning                       | Example              |
| ----- | -------- | ----------------------------- | -------------------- |
| 0     | array[5] | Prompt wrapper (see below)    | —                    |
| 1     | number   | Prompt type flag              | `2`                  |
| 2     | null     | —                             | —                    |
| 3     | number   | Unknown flag                  | `0`                  |
| 4     | string   | Prompt ID                     | `<promptId>`         |
| 5–9   | null     | —                             | —                    |
| 10    | array    | Empty array                   | `[]`                 |

`turn[2][0]` — prompt wrapper:

| Index | Type   | Meaning             | Example                          |
| ----- | ------ | ------------------- | -------------------------------- |
| 0     | string | User prompt text    | `"<user prompt text>"`  |
| 1–3   | null   | —                   | —                                |
| 4     | array  | Attachments         | `[[]]`                           |

#### `turn[3]` — turn-level metadata (26 fields)

| Index | Type      | Meaning                          | Example                    |
| ----- | --------- | -------------------------------- | -------------------------- |
| 0     | array     | **Candidates** (see below)       | `[[candidate, ...]]`       |
| 1     | array[4]  | Feedback/rating arrays           | —                          |
| 2     | array[7]  | Web search citations             | —                          |
| 3     | string    | **Selected candidate ID**        | `rc_<candidateId>`         |
| 4     | array[4]  | Unknown                          | —                          |
| 5     | array[1]  | Unknown                          | —                          |
| 6–7   | null      | —                                | —                          |
| 8     | string    | **Language**                     | `DE`                       |
| 9     | boolean   | Unknown flag                     | `true`                     |
| 10–11 | null      | —                                | —                          |
| 12    | array[1]  | Unknown                          | —                          |
| 13    | null      | —                                | —                          |
| 14    | string    | Prompt ID                        | `<promptId>`               |
| 15–16 | null      | —                                | —                          |
| 17    | string    | Prompt ID (duplicate of [14])    | `<promptId>`               |
| 18–20 | null      | —                                | —                          |
| 21    | string    | **Model name**                   | `3.6 Flash Extended`       |
| 22–23 | null      | —                                | —                          |
| 24    | number    | Unknown flag                     | `1`                        |
| 25    | number    | Unknown flag                     | `2`                        |

#### `turn[4]` — timestamp

| Index | Type   | Meaning           | Example        |
| ----- | ------ | ----------------- | -------------- |
| 0     | number | Unix seconds      | `<unixSeconds>`   |
| 1     | number | Nanoseconds       | `<nanoseconds>`   |

### Candidate structure

`turn[3][0]` is an array of candidates (usually 1). Each candidate is
a 38-element array:

```
candidate = [
  candidateId,         // [0]
  content[1],          // [1] — assistant markdown
  citations[2],        // [2] — web citations
  null, null, null, null, null,  // [3-7]
  something[1],        // [8]
  lang,                // [9]
  null, null,          // [10-11]
  extensions[8],       // [12] — tool/extension results
  null × 15,           // [13-27]
  something[0],        // [28]
  null × 8,            // [29-36]
  thinking[2]          // [37] — **thinking/reasoning data**
]
```

| Index | Type      | Meaning                          | Example                    |
| ----- | --------- | -------------------------------- | -------------------------- |
| 0     | string    | **Candidate ID**                 | `rc_<candidateId>`         |
| 1     | array[1]  | **Assistant markdown** wrapper   | `[markdownString]`         |
| 2     | array[2]  | Citations: `[null, webCits[15]]` | —                          |
| 3–7   | null      | —                                | —                          |
| 8     | array[1]  | Unknown (`[2]`)                  | —                          |
| 9     | string    | Response language                | `en`                       |
| 10–11 | null      | —                                | —                          |
| 12    | array[8]  | Extension/tool results           | —                          |
| 13–27 | null      | —                                | —                          |
| 28    | array[0]  | Unknown (empty)                  | `[]`                       |
| 29–36 | null      | —                                | —                          |
| 37    | array[2]  | **Thinking/reasoning** (see below) | —                        |

#### `candidate[1]` — assistant markdown

```
candidate[1] = [markdownString]
```

The assistant's response as Markdown (with LaTeX, links, etc.).

#### `candidate[2]` — web citations

```
candidate[2] = [
  null,                    // [0]
  webCitations[15]         // [1] — array of citation objects
]
```

Each citation (`candidate[2][1][i]`) is a 4-element array:

| Index | Type      | Meaning              |
| ----- | --------- | -------------------- |
| 0     | array[4]  | Citation text/markup |
| 1     | array[1]  | Unknown              |
| 2     | array[1]  | Unknown              |
| 3     | string    | Source ID (`spp_...`) |

### Thinking structure (`candidate[37]`)

> **This field contains the model's reasoning/thinking data.**
> It is extracted by the exporter as `turn.thinking`.

```
thinking = [
  thinkingText[1],     // [0] — full thinking as markdown
  thinkingSteps[]      // [1] — structured thinking steps
]
```

#### `candidate[37][0]` — thinking text

```
candidate[37][0] = [markdownString]
```

The full thinking text as Markdown. Example structure:

```
**<Step Title>**

<Reasoning text for this step>

<Step Title>

<Reasoning text for this step>

...
```

Each thinking section is separated by `\n\n\n\n` (four newlines).

#### `candidate[37][1]` — structured thinking steps

An array of step objects (11–13 steps observed). Each step is a
7-element array:

| Index | Type     | Meaning                    |
| ----- | -------- | -------------------------- |
| 0     | array[1] | Step text `[markdownString]` |
| 1     | string   | Empty string               |
| 2     | string   | Empty string               |
| 3     | string   | Empty string               |
| 4     | array[1] | Structured markup of step  |
| 5     | string   | Empty string               |
| 6     | string   | Empty string               |

### Extension/tool results (`candidate[12]`)

> **This field contains tool/extension results, including generated
> files.** It is extracted by the exporter as `turn.extensions` with
> parsed `generatedFiles` when the `'59'` key is present.

`candidate[12]` is an array of 8 extension slots (most are `null`).
Each non-null slot is an object keyed by numeric string IDs. The key
`'59'` contains **generated files** (e.g. Word documents, images,
code-generated artifacts).

```
candidate[12] = [
  { '8': [], '33': [...], '59': [[fileEntry, ...]] },  // [0] — generated files
  null, null, null, null, null, null, null, []          // [1-7] — other slots
]
```

#### Extension object keys

| Key  | Type   | Meaning                          |
| ---- | ------ | -------------------------------- |
| `'8'`  | array  | Unknown (empty array observed)   |
| `'33'` | array  | Unknown (code execution metadata)|
| `'59'` | array  | **Generated files** (see below)  |

#### Generated file structure (`extension['59']`)

`extension['59']` is an array containing one element, which is itself
an array of file entries:

```
extension['59'] = [
  [fileEntry0, fileEntry1, ...]   // [0] — array of file entries
]
```

Each file entry is a 3-element array:

```
fileEntry = [
  fileTag,    // [0] — "[file-tag: code-generated-file-<uuid>]"
  null,       // [1]
  metadata[]  // [2] — file metadata (see below)
]
```

#### File metadata (`fileEntry[2]`)

| Index | Type     | Meaning              | Example                                                        |
| ----- | -------- | -------------------- | -------------------------------------------------------------- |
| 0     | null     | —                    | —                                                              |
| 1     | number   | Type code            | `10`                                                           |
| 2     | string   | **Filename**         | `"<filename>"`                                                 |
| 3     | null     | —                    | —                                                              |
| 4     | null     | —                    | —                                                              |
| 5     | string   | Data token           | `"$<base64-like token>"` (300+ chars)                         |
| 6     | null     | —                    | —                                                              |
| 7     | array[3] | **URLs** (see below) | —                                                              |
| 8–10  | null     | —                    | —                                                              |
| 11    | string   | **MIME type**        | `"<mime-type>"`                                                |

#### File URLs (`metadata[7]`)

| Index | Type   | Meaning          | Example                                                                                      |
| ----- | ------ | ---------------- | -------------------------------------------------------------------------------------------- |
| 0     | string | Thumbnail URL    | `https://drive.google.com/viewer/thumb?ds=...`                                               |
| 1     | string | **Download URL** | `https://contribution.usercontent.google.com/download?c=...&filename=<filename>&opi=...`    |
| 2     | string | Upload URL       | `https://drive.google.com/viewer/upload?ds=...`                                              |

The **download URL** (`metadata[7][1]`) is a direct link to download
the generated file. It includes the filename as a query parameter and
an opaque `c` parameter encoding the file's storage location. This URL
is authenticated via the user's Google cookies.

The exporter extracts this URL and renders it as a markdown download
link in the "Generated files" section, and as a `downloadUrl` field
in JSON output. File-tag placeholders in the assistant markdown are
replaced with these download links.

#### File tags in assistant markdown

The assistant markdown references generated files using inline tags:

```
[file-tag: code-generated-file-<uuid>]
```

Example:

```markdown
I've created the Word document for you.

[file-tag: code-generated-file-<uuid>]

The document contains...
```

These tags are cross-referenced with file entries in `extension['59']`
and replaced with download links during markdown rendering.

#### Code execution metadata (`extension['33']`)

Observed structure (when code execution is present):

```
extension['33'] = [
  null,
  [
    [null, null, null, null, 4],  // step 0
    [null, null, null, null, 4],  // step 1
    ...
  ]
]
```

The `4` value likely indicates a code execution step type. The
assistant markdown contains fenced code blocks with
`code_reference` and `code_stdout` tags that correspond to these
steps:

````markdown
```python?code_reference&code_event_index=1
<code>
```

```text?code_stdout&code_event_index=1
<output>
```
````

### User-uploaded files (`turn[2][0][4]`)

> **Not yet observed in captured data.** The field exists but was
> empty (`[[]]`) in all observed conversations.

`turn[2][0][4]` is the attachments array in the user prompt wrapper.
In conversations without file uploads, it is `[[]]` (array containing
an empty array). The exporter extracts this field as `turn.uploadedFiles`
(opaque `{ raw }` objects) when non-empty, but the structure has not
been confirmed from observed data.

To document uploaded file structure, a conversation with actual file
uploads (images, PDFs, documents) needs to be analyzed.

## Summary of fields the exporter extracts vs. renders

> The following table refers to the
> [gemini-conversation-exporter](https://github.com/tobiashochguertel/gemini-conversation-exporter)
> userscript — a fork of
> [dikelps/gemini-conversation-exporter](https://github.com/dikelps/gemini-conversation-exporter)
> with extended turn extraction and rendering.
>
> - **Extracted?** — whether `extractTurn()` in `src/core.js` reads the
>   field from the raw API response into the `Turn` object
> - **Markdown?** — whether `renderMarkdown()` outputs the field in the
>   exported `.md` file
> - **JSON?** — whether `renderJson()` outputs the field in the exported
>   `.json` file

| Field                           | Path                     | Extracted?  | Markdown?                         | JSON?                             |
| ------------------------------- | ------------------------ | ----------- | --------------------------------- | --------------------------------- |
| Conversation ID                 | `turn[0][0]`             | ✅          | ✅ (metadata comment)             | ✅ (top-level `conversationId`)   |
| Response ID                     | `turn[0][1]`             | ✅          | ✅ (metadata comment)             | ✅                                |
| Parent response ID              | `turn[1][1]`             | ✅          | ✅ (metadata comment)             | ✅                                |
| Parent candidate ID             | `turn[1][2]`             | ✅          | ✅ (metadata comment)             | ✅                                |
| User prompt                     | `turn[2][0][0]`          | ✅          | ✅ (User section)                 | ✅ (`userMarkdown`)               |
| Candidate ID                    | `candidate[0]`           | ✅          | ✅ (metadata comment)             | ✅                                |
| Assistant markdown              | `candidate[1][0]`        | ✅          | ✅ (Gemini section)               | ✅ (`assistantMarkdown`)          |
| Timestamp                       | `turn[4]`                | ✅          | ✅ (metadata comment)             | ✅                                |
| Model name                      | `turn[3][21]`            | ✅          | ✅ (metadata comment)             | ✅                                |
| Language                        | `turn[3][8]`             | ✅          | ✅ (metadata comment)             | ✅                                |
| Thinking text                   | `candidate[37][0][0]`    | ✅          | ✅ (`<details>` block)            | ✅ (`thinking`)                   |
| Thinking steps                  | `candidate[37][1]`       | ✅          | ✅ (in `<details>`)               | ✅ (in `thinking`)                |
| Web citations                   | `candidate[2][1]`        | ✅          | ✅ (Citations section)            | ✅ (`webCitations`)               |
| Extension/tool results          | `candidate[12]`          | ✅ (opaque) | ✅ (`<details>` block)            | ✅ (`extensions`)                 |
| Feedback/ratings                | `turn[3][1]`             | ✅          | ✅ (`<details>` block)            | ✅ (`feedback`)                   |
| Source index                    | (computed)               | ✅          | ✅ (metadata comment)             | ✅                                |
| **Generated file metadata**     | `candidate[12][0]['59']` | ✅ (structured `generatedFiles`) | ✅ (Generated files section with download links) | ✅ (in `extensions[].generatedFiles`) |
| **Generated file download URL** | `metadata[7][1]`         | ✅          | ✅ (as markdown link)             | ✅ (as `downloadUrl` field)       |
| **User-uploaded files**         | `turn[2][0][4]`          | ✅ (opaque `uploadedFiles`) | ✅ (collapsible JSON dump)        | ✅ (as `uploadedFiles`)           |

### What's still missing

1. **Generated file downloading** — the download URL at `metadata[7][1]` is now extracted and
   rendered as a link, but the actual file content is not downloaded during export. A future
   feature could fetch the file and save it alongside the markdown/JSON.
2. **User-uploaded files** — `turn[2][0][4]` is now extracted as opaque `uploadedFiles`, but
   the structure is not yet confirmed from observed data (it was empty in all captured
   conversations). A conversation with actual file uploads needs to be analyzed to document
   and parse this field's structure.

## How to reproduce this analysis

1. Open a Gemini conversation in Firefox with devtools
2. In the console, run:

```js
// Fetch history via the page's own auth context
const config = window.WIZ_global_data;
const convId = "c_" + location.pathname.split("/").pop();
const reqId = String(Math.floor(Math.random() * 9e6) + 1e6);
const rpcArgs = [convId, 50, null, 1, [0], [4], null, 1];
const rpcCall = ["hNvQHb", JSON.stringify(rpcArgs), null, "generic"];
const body = new URLSearchParams({
  "f.req": JSON.stringify([[rpcCall]]),
  at: config.SNlM0e,
});
const query = new URLSearchParams({
  rpcids: "hNvQHb",
  "source-path": location.pathname,
  bl: config.cfb2h,
  "f.sid": config.FdrFJe,
  hl: "en",
  _reqid: reqId,
  rt: "c",
});
const res = await fetch("/_/BardChatUi/data/batchexecute?" + query, {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "X-Same-Domain": "1",
  },
  body: body.toString(),
});
const text = await res.text();
// Parse the response
const lines = text.split("\n");
const payload = JSON.parse(lines.find((l) => l.startsWith('[["wrb.fr"')));
const inner = JSON.parse(payload[0][2]);
console.log(inner); // ← the full history data
```
