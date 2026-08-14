// ==UserScript==
// @name         Gemini Conversation Exporter
// @namespace    local.gemini-web-exporter
// @version      0.7.2
// @description  Export the current Gemini conversation as validated Markdown using Gemini's own paginated history data.
// @author       tobiashochguertel
// @contributor  dikelps <dikelps@users.noreply.github.com> (original author)
// @license      MIT
// @homepageURL  https://github.com/tobiashochguertel/gemini-conversation-exporter
// @supportURL   https://github.com/tobiashochguertel/gemini-conversation-exporter/issues
// @downloadURL  https://raw.githubusercontent.com/tobiashochguertel/gemini-conversation-exporter/main/dist/gemini-conversation-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/tobiashochguertel/gemini-conversation-exporter/main/dist/gemini-conversation-exporter.user.js
// @match        https://gemini.google.com/*
// @match        https://gemini.google.com/app
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/u/*/app
// @match        https://gemini.google.com/u/*/app/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      JavaScript
// @noframes
// ==/UserScript==

(function initializeGeminiExporterCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GeminiWebExporterCore = api;
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createGeminiExporterCore() {
    "use strict";

    /**
     * @typedef {Object} Thinking
     * @property {string} text          - Full thinking text as Markdown.
     * @property {string[]} steps       - Thinking step texts (one per section).
     */

    /**
     * @typedef {Object} WebCitation
     * @property {string|null} text     - Citation display text (usually a Markdown link).
     * @property {string|null} sourceId - Gemini source ID (e.g. `spp_…`).
     */

    /**
     * @typedef {Object} GeneratedFile
     * @property {string} fileTag       - File tag identifier (e.g. `[file-tag: code-generated-file-<uuid>]`).
     * @property {string} filename      - Filename (e.g. `test.docx`).
     * @property {string|null} mimeType - MIME type (e.g. `application/vnd.openxmlformats...`).
     * @property {string|null} downloadUrl  - Direct download URL.
     * @property {string|null} thumbnailUrl - Thumbnail/preview URL.
     * @property {string|null} uploadUrl    - Upload URL.
     * @property {string|null} dataToken    - Opaque data token (base64-like).
     * @property {number|null} typeCode     - Numeric type code (e.g. 10).
     */

    /**
     * @typedef {Object} UploadedFile
     * @property {*} raw                - Raw, opaque uploaded-file payload.
     */

    /**
     * @typedef {Object} ExtensionResult
     * @property {number} index              - Original position in candidate[12].
     * @property {*} raw                     - Raw, opaque extension/tool payload.
     * @property {GeneratedFile[]} [generatedFiles] - Parsed generated files from key '59' (if present).
     */

    /**
     * @typedef {Object} FeedbackGroup
     * @property {number} index         - Original position in turn[3][1].
     * @property {*[]} raw              - Raw feedback/rating array.
     */

    /**
     * @typedef {Object} Turn
     * @property {string|null} conversationId    - Gemini conversation ID (`c_…`).
     * @property {string|null} responseId        - Response ID (`r_…`).
     * @property {string|null} parentResponseId  - Parent response ID.
     * @property {string|null} candidateId       - Selected candidate ID (`rc_…`).
     * @property {string|null} parentCandidateId - Parent candidate ID.
     * @property {string} userMarkdown           - User prompt as Markdown.
     * @property {string} assistantMarkdown      - Assistant response as Markdown.
     * @property {string|null} timestamp         - ISO 8601 timestamp.
     * @property {string} [model]                - Model name (e.g. "3.6 Flash Extended").
     * @property {string} [language]             - Response language code (e.g. "DE").
     * @property {Thinking} [thinking]           - Thinking/reasoning data.
     * @property {WebCitation[]} [webCitations]  - Web search citations.
     * @property {ExtensionResult[]} [extensions]- Extension/tool results (with parsed generatedFiles).
     * @property {UploadedFile[]} [uploadedFiles]- User-uploaded files.
     * @property {FeedbackGroup[]} [feedback]    - Feedback/rating groups.
     * @property {number} sourceIndex            - Zero-based index in the raw history.
     */

    const HISTORY_RPC_ID = "hNvQHb";

    function invariant(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function parseJsonLines(rawResponse) {
      invariant(
        typeof rawResponse === "string" && rawResponse.length > 0,
        "Gemini returned an empty history response.",
      );

      const withoutXssiPrefix = rawResponse.replace(/^\)\]\}'\r?\n?/, "");
      const parsedLines = [];

      for (const rawLine of withoutXssiPrefix.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^\d+$/.test(line)) {
          continue;
        }

        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          // Batchexecute length markers and transport metadata are not payloads.
        }
      }

      invariant(
        parsedLines.length > 0,
        "Gemini's history response did not contain any JSON payloads.",
      );

      return parsedLines;
    }

    function findRpcPayload(value, rpcId) {
      if (!Array.isArray(value)) {
        return null;
      }

      if (
        value[0] === "wrb.fr" &&
        value[1] === rpcId &&
        typeof value[2] === "string"
      ) {
        return value[2];
      }

      for (const child of value) {
        const match = findRpcPayload(child, rpcId);
        if (match !== null) {
          return match;
        }
      }

      return null;
    }

    function parseBatchexecuteResponse(rawResponse, rpcId = HISTORY_RPC_ID) {
      const chunks = parseJsonLines(rawResponse);

      for (const chunk of chunks) {
        const encodedPayload = findRpcPayload(chunk, rpcId);
        if (encodedPayload === null) {
          continue;
        }

        try {
          return JSON.parse(encodedPayload);
        } catch (error) {
          throw new Error(
            `Gemini returned malformed JSON for history RPC ${rpcId}: ${error.message}`,
          );
        }
      }

      throw new Error(
        `Gemini's response did not contain history RPC ${rpcId}. The private API may have changed.`,
      );
    }

    function parseHistoryPage(rawResponse) {
      const payload = parseBatchexecuteResponse(rawResponse, HISTORY_RPC_ID);

      invariant(
        Array.isArray(payload) && Array.isArray(payload[0]),
        "Gemini returned an unrecognized history payload.",
      );

      const cursor =
        typeof payload[1] === "string" && payload[1].length > 0
          ? payload[1]
          : null;

      return {
        rawTurns: payload[0],
        cursor,
      };
    }

    async function collectHistoryPages(
      fetchPage,
      { maxPages = 200 } = {},
    ) {
      invariant(typeof fetchPage === "function", "fetchPage must be a function.");

      const pages = [];
      const seenCursors = new Set();
      let cursor = null;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const rawResponse = await fetchPage(cursor, pageNumber);
        const page =
          typeof rawResponse === "string"
            ? parseHistoryPage(rawResponse)
            : rawResponse;

        invariant(
          page && Array.isArray(page.rawTurns),
          `Gemini history page ${pageNumber + 1} was invalid.`,
        );

        pages.push(page);

        if (!page.cursor) {
          return {
            pages,
            rawTurnsNewestFirst: pages.flatMap(
              (historyPage) => historyPage.rawTurns,
            ),
          };
        }

        invariant(
          page.rawTurns.length > 0,
          "Gemini returned a continuation cursor with no turns.",
        );
        invariant(
          !seenCursors.has(page.cursor),
          "Gemini repeated a history cursor; export stopped to avoid duplicate turns.",
        );

        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }

      throw new Error(
        `Export exceeded ${maxPages} history pages. Stopped instead of producing a potentially incomplete file.`,
      );
    }

    function timestampToIso(timestampTuple) {
      if (
        !Array.isArray(timestampTuple) ||
        !Number.isFinite(Number(timestampTuple[0]))
      ) {
        return null;
      }

      const seconds = Number(timestampTuple[0]);
      const nanoseconds = Number(timestampTuple[1] || 0);
      const milliseconds = seconds * 1000 + nanoseconds / 1_000_000;
      const date = new Date(milliseconds);

      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function extractSelectedCandidate(rawTurn) {
      const candidates = rawTurn?.[3]?.[0];
      if (!Array.isArray(candidates)) {
        return null;
      }

      return (
        candidates.find(
          (candidate) =>
            Array.isArray(candidate) &&
            typeof candidate?.[1]?.[0] === "string" &&
            candidate[1][0].length > 0,
        ) || null
      );
    }

    /**
     * Extract thinking/reasoning data from a candidate.
     * @param {Array|null} candidate - The raw candidate array (38 fields).
     * @returns {Thinking|null} Thinking object, or null if no thinking data.
     */
    function extractThinking(candidate) {
      const thinking = candidate?.[37];
      if (!Array.isArray(thinking)) {
        return null;
      }

      const text = thinking?.[0]?.[0];
      const steps = Array.isArray(thinking?.[1]) ? thinking[1] : [];

      return {
        text: typeof text === "string" ? text : "",
        steps: steps
          .map((step) => {
            if (!Array.isArray(step)) return null;
            const stepText = step?.[0]?.[0];
            return typeof stepText === "string" ? stepText : null;
          })
          .filter((s) => s !== null),
      };
    }

    /**
     * Extract web citations from a candidate.
     * @param {Array|null} candidate - The raw candidate array (38 fields).
     * @returns {WebCitation[]} Array of citation objects (empty if none).
     */
    function extractWebCitations(candidate) {
      const citations = candidate?.[2]?.[1];
      if (!Array.isArray(citations)) {
        return [];
      }

      return citations
        .map((citation) => {
          if (!Array.isArray(citation)) return null;
          // citation[0] is a 4-element array containing the citation markup;
          // citation[0][0] holds the visible citation text (a markdown link).
          const text = citation?.[0]?.[0];
          const sourceId = citation?.[3];
          return {
            text: typeof text === "string" ? text : null,
            sourceId: typeof sourceId === "string" ? sourceId : null,
          };
        })
        .filter((c) => c !== null);
    }

    /**
     * Parse generated file entries from extension key '59'.
     * @param {*} ext59 - The raw value of extension key '59'.
     * @returns {GeneratedFile[]} Array of generated file objects (empty if none).
     */
    function parseGeneratedFiles(ext59) {
      if (!Array.isArray(ext59) || !Array.isArray(ext59[0])) {
        return [];
      }

      return ext59[0]
        .map((fileEntry) => {
          if (!Array.isArray(fileEntry)) return null;
          const fileTag = typeof fileEntry[0] === "string" ? fileEntry[0] : null;
          const meta = Array.isArray(fileEntry[2]) ? fileEntry[2] : null;
          if (!meta) return null;

          const urls = Array.isArray(meta[7]) ? meta[7] : [];

          return {
            fileTag,
            filename: typeof meta[2] === "string" ? meta[2] : null,
            mimeType: typeof meta[11] === "string" ? meta[11] : null,
            downloadUrl: typeof urls[1] === "string" ? urls[1] : null,
            thumbnailUrl: typeof urls[0] === "string" ? urls[0] : null,
            uploadUrl: typeof urls[2] === "string" ? urls[2] : null,
            dataToken: typeof meta[5] === "string" ? meta[5] : null,
            typeCode: typeof meta[1] === "number" ? meta[1] : null,
          };
        })
        .filter((f) => f !== null);
    }

    /**
     * Extract extension/tool results from a candidate.
     * Parses the '59' key into structured generatedFiles when present.
     * @param {Array|null} candidate - The raw candidate array (38 fields).
     * @returns {ExtensionResult[]} Array of extension entries (empty if none).
     */
    function extractExtensions(candidate) {
      const extensions = candidate?.[12];
      if (!Array.isArray(extensions)) {
        return [];
      }

      return extensions
        .map((ext, i) => {
          if (ext === null || ext === undefined) return null;
          const result = { index: i, raw: ext };
          // Parse the '59' key into structured generated files when present.
          if (ext && typeof ext === "object" && Array.isArray(ext["59"])) {
            const generatedFiles = parseGeneratedFiles(ext["59"]);
            if (generatedFiles.length > 0) {
              result.generatedFiles = generatedFiles;
            }
          }
          return result;
        })
        .filter((e) => e !== null);
    }

    /**
     * Extract feedback/rating groups from a raw turn.
     * @param {Array} rawTurn - The raw turn array.
     * @returns {FeedbackGroup[]|null} Array of feedback groups, or null.
     */
    function extractFeedback(rawTurn) {
      const feedback = rawTurn?.[3]?.[1];
      if (!Array.isArray(feedback)) {
        return null;
      }

      return feedback
        .map((group, i) => {
          if (!Array.isArray(group)) return null;
          return { index: i, raw: group };
        })
        .filter((g) => g !== null);
    }

    /**
     * Extract user-uploaded files from a raw turn's prompt metadata.
     * @param {Array} rawTurn - The raw turn array.
     * @returns {UploadedFile[]|null} Array of uploaded file objects, or null.
     */
    function extractUploadedFiles(rawTurn) {
      const attachments = rawTurn?.[2]?.[0]?.[4];
      if (!Array.isArray(attachments)) {
        return null;
      }

      const files = attachments
        .map((att) => {
          if (att === null || att === undefined) return null;
          if (Array.isArray(att) && att.length === 0) return null;
          // Uploaded file structure is not yet confirmed from observed data.
          // Preserve the raw payload for future parsing.
          return { raw: att };
        })
        .filter((f) => f !== null);

      return files.length > 0 ? files : null;
    }

    /**
     * Extract a structured Turn from a raw Gemini history turn.
     * @param {Array} rawTurn - The raw turn array from the hNvQHb response.
     * @param {number} sourceIndex - Zero-based index in the raw history.
     * @returns {Turn} Structured turn object.
     */
    function extractTurn(rawTurn, sourceIndex) {
      invariant(
        Array.isArray(rawTurn),
        `Gemini turn ${sourceIndex + 1} was not an array.`,
      );

      const userMarkdown = rawTurn?.[2]?.[0]?.[0];
      const candidate = extractSelectedCandidate(rawTurn);
      const assistantMarkdown = candidate?.[1]?.[0];
      const turnMeta = rawTurn?.[3];

      const model =
        typeof turnMeta?.[21] === "string" ? turnMeta[21] : null;
      const language =
        typeof turnMeta?.[8] === "string" ? turnMeta[8] : null;
      const thinking = extractThinking(candidate);
      const webCitations = extractWebCitations(candidate);
      const extensions = extractExtensions(candidate);
      const feedback = extractFeedback(rawTurn);
      const uploadedFiles = extractUploadedFiles(rawTurn);

      return {
        conversationId:
          typeof rawTurn?.[0]?.[0] === "string"
            ? rawTurn[0][0]
            : rawTurn?.[1]?.[0] || null,
        responseId:
          typeof rawTurn?.[0]?.[1] === "string" ? rawTurn[0][1] : null,
        parentResponseId:
          typeof rawTurn?.[1]?.[1] === "string" ? rawTurn[1][1] : null,
        candidateId:
          typeof candidate?.[0] === "string"
            ? candidate[0]
            : rawTurn?.[3]?.[3] || null,
        parentCandidateId:
          typeof rawTurn?.[1]?.[2] === "string" ? rawTurn[1][2] : null,
        userMarkdown:
          typeof userMarkdown === "string" ? userMarkdown : "",
        assistantMarkdown:
          typeof assistantMarkdown === "string" ? assistantMarkdown : "",
        timestamp: timestampToIso(rawTurn?.[4]),
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(thinking && thinking.text
          ? { thinking }
          : {}),
        ...(webCitations.length > 0 ? { webCitations } : {}),
        ...(extensions.length > 0 ? { extensions } : {}),
        ...(uploadedFiles ? { uploadedFiles } : {}),
        ...(feedback ? { feedback } : {}),
        sourceIndex,
      };
    }

    /**
     * Convert raw turns (newest-first) to chronological Turn objects.
     * @param {Array[]} rawTurnsNewestFirst - Raw turns from the history API.
     * @returns {Turn[]} Chronologically ordered Turn objects.
     */
    function historyToChronologicalTurns(rawTurnsNewestFirst) {
      invariant(
        Array.isArray(rawTurnsNewestFirst),
        "Gemini history turns were missing.",
      );

      const seenResponseIds = new Set();
      const uniqueNewestFirst = [];

      rawTurnsNewestFirst.forEach((rawTurn, sourceIndex) => {
        const turn = extractTurn(rawTurn, sourceIndex);
        const dedupeKey =
          turn.responseId ||
          `${turn.timestamp || "unknown"}\u0000${turn.userMarkdown}\u0000${turn.assistantMarkdown}`;

        if (seenResponseIds.has(dedupeKey)) {
          return;
        }

        seenResponseIds.add(dedupeKey);
        uniqueNewestFirst.push(turn);
      });

      return uniqueNewestFirst.reverse();
    }

    function countOccurrences(text, expression) {
      return (text.match(expression) || []).length;
    }

    function fnv1a(text) {
      let hash = 0x811c9dc5;

      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }

      return (hash >>> 0).toString(16).padStart(8, "0");
    }

    /**
     * Validate a set of turns and compute diagnostics.
     * @param {Turn[]} turns - Chronologically ordered turns.
     * @returns {{fingerprint: string, duplicateBodies: *, timestampRegressions: *, markdownWarnings: *}} Diagnostics.
     */
    function validateConversation(turns) {
      invariant(Array.isArray(turns), "Exported turns were missing.");
      invariant(turns.length > 0, "Gemini returned no conversation turns.");

      const missing = [];
      const responseIds = new Set();
      const duplicateResponseIds = [];
      const bodyFingerprints = new Set();
      const duplicateBodies = [];
      const chainBreaks = [];
      const timestampRegressions = [];
      const markdownWarnings = [];

      turns.forEach((turn, index) => {
        if (!turn.userMarkdown.trim()) {
          missing.push(`turn ${index + 1} user message`);
        }
        if (!turn.assistantMarkdown.trim()) {
          missing.push(`turn ${index + 1} Gemini response`);
        }

        if (turn.responseId) {
          if (responseIds.has(turn.responseId)) {
            duplicateResponseIds.push(turn.responseId);
          }
          responseIds.add(turn.responseId);
        }

        const bodyFingerprint = fnv1a(
          `${turn.userMarkdown}\u0000${turn.assistantMarkdown}`,
        );
        if (bodyFingerprints.has(bodyFingerprint)) {
          duplicateBodies.push(index + 1);
        }
        bodyFingerprints.add(bodyFingerprint);

        if (index > 0) {
          const previous = turns[index - 1];
          if (
            turn.parentResponseId &&
            previous.responseId &&
            turn.parentResponseId !== previous.responseId
          ) {
            chainBreaks.push({
              turn: index + 1,
              expectedParent: previous.responseId,
              actualParent: turn.parentResponseId,
            });
          }

          if (
            turn.timestamp &&
            previous.timestamp &&
            Date.parse(turn.timestamp) < Date.parse(previous.timestamp)
          ) {
            timestampRegressions.push(index + 1);
          }
        }

        for (const [role, markdown] of [
          ["user", turn.userMarkdown],
          ["Gemini", turn.assistantMarkdown],
        ]) {
          if (countOccurrences(markdown, /```/g) % 2 !== 0) {
            markdownWarnings.push(
              `turn ${index + 1} ${role} text has an unbalanced code fence`,
            );
          }

          if (countOccurrences(markdown, /\$\$/g) % 2 !== 0) {
            markdownWarnings.push(
              `turn ${index + 1} ${role} text has an unbalanced display-math delimiter`,
            );
          }
        }
      });

      invariant(
        missing.length === 0,
        `Export stopped because content was missing: ${missing.join(", ")}.`,
      );
      invariant(
        duplicateResponseIds.length === 0,
        "Export stopped because Gemini returned duplicate response IDs.",
      );
      if (chainBreaks.length > 0) {
        throw new Error(
          `Export stopped because the active conversation branch was discontinuous at turn ${chainBreaks[0].turn}.`,
        );
      }

      const fingerprint = fnv1a(
        turns
          .map(
            (turn) =>
              `${turn.responseId || ""}\u0000${turn.userMarkdown}\u0000${turn.assistantMarkdown}`,
          )
          .join("\u0001"),
      );

      return {
        turnCount: turns.length,
        duplicateBodies,
        timestampRegressions,
        markdownWarnings,
        fingerprint,
      };
    }

    function normalizeBlock(markdown) {
      return String(markdown)
        .replace(/\r\n?/g, "\n")
        .replace(/^\n+|\n+$/g, "");
    }

    /**
     * Collect all generated files from a turn's extensions.
     * @param {Turn} turn - The turn object.
     * @returns {GeneratedFile[]} Array of generated files (empty if none).
     */
    function collectGeneratedFiles(turn) {
      if (!turn.extensions) return [];
      return turn.extensions.flatMap((ext) => ext.generatedFiles || []);
    }

    /**
     * Replace [file-tag: ...] placeholders in assistant markdown with download links.
     * @param {string} markdown - The assistant markdown.
     * @param {GeneratedFile[]} generatedFiles - Generated files to match against.
     * @returns {string} Markdown with file tags replaced by download links.
     */
    function replaceFileTags(markdown, generatedFiles) {
      if (!generatedFiles.length) return markdown;
      const fileMap = new Map();
      for (const file of generatedFiles) {
        if (file.fileTag) {
          fileMap.set(file.fileTag, file);
        }
      }
      return markdown.replace(
        /\[file-tag:\s*code-generated-file-[^\]]+\]/g,
        (tag) => {
          const file = fileMap.get(tag);
          if (file && file.downloadUrl) {
            const label = file.filename || "Download file";
            return `[${escapeMarkdownLinkText(label)}](${escapeMarkdownLinkDestination(file.downloadUrl)})`;
          }
          if (file && file.filename) {
            return `*${escapeMarkdownLinkText(file.filename)}*`;
          }
          return tag;
        },
      );
    }

    function escapeMarkdownLinkDestination(url) {
      return String(url).replace(/[()\\]/g, "\\$&");
    }

    function turnPreview(markdown, maxLength = 72) {
      const plainText = normalizeBlock(markdown)
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/```[^\n]*\n?/g, " ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[`*_~#$>|]/g, " ")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .trim();

      if (plainText.length <= maxLength) {
        return plainText;
      }

      const candidate = plainText.slice(0, maxLength + 1);
      const lastSpace = candidate.lastIndexOf(" ");
      const clipped =
        lastSpace >= Math.floor(maxLength * 0.6)
          ? candidate.slice(0, lastSpace)
          : plainText.slice(0, maxLength);

      return `${clipped.trimEnd()}…`;
    }

    function escapeMarkdownLinkText(text) {
      return String(text).replace(/([\\[\]])/g, "\\$1");
    }

    /**
     * Render turns as a Markdown document.
     * @param {Object} opts
     * @param {string} opts.title
     * @param {string} opts.sourceUrl
     * @param {string} opts.conversationId
     * @param {string} opts.exportedAt
     * @param {Turn[]} opts.turns
     * @param {*} opts.diagnostics
     * @param {boolean} [opts.includeMetadata=true]
     * @param {boolean} [opts.includeOutline=true]
     * @returns {string} Markdown document.
     */
    function renderMarkdown({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata = true,
      includeOutline = true,
    }) {
      invariant(Array.isArray(turns) && turns.length > 0, "No turns to render.");

      const safeTitle = normalizeBlock(title || "Gemini conversation").replace(
        /\n+/g,
        " ",
      );
      const lines = [`# ${safeTitle}`, ""];

      if (includeMetadata) {
        lines.push(
          `> Source: [Google Gemini](${escapeMarkdownLinkDestination(sourceUrl)})`,
          `> Exported: ${exportedAt}`,
          `> Conversation: ${conversationId}`,
          `> Turns: ${turns.length}`,
          `> Validation fingerprint: \`${diagnostics.fingerprint}\``,
          "",
        );
      }

      if (includeOutline) {
        lines.push("## Conversation outline", "");
        turns.forEach((turn, index) => {
          const number = index + 1;
          const preview = turnPreview(turn.userMarkdown);
          const label = preview
            ? `Turn ${number} — ${preview}`
            : `Turn ${number}`;

          lines.push(
            `${number}. [${escapeMarkdownLinkText(label)}](#turn-${number})`,
          );
        });
        lines.push("");
      }

      turns.forEach((turn, index) => {
        if (index > 0) {
          lines.push("---", "");
        }

        if (includeMetadata) {
          const commentParts = [
            `turn=${index + 1}`,
            `sourceIndex=${turn.sourceIndex}`,
            turn.responseId ? `response=${turn.responseId}` : null,
            turn.parentResponseId
              ? `parentResponse=${turn.parentResponseId}`
              : null,
            turn.candidateId ? `candidate=${turn.candidateId}` : null,
            turn.parentCandidateId
              ? `parentCandidate=${turn.parentCandidateId}`
              : null,
            turn.timestamp ? `timestamp=${turn.timestamp}` : null,
            turn.model ? `model=${turn.model}` : null,
            turn.language ? `lang=${turn.language}` : null,
          ].filter(Boolean);

          lines.push(
            `<!-- gemini-export: ${commentParts.join(" ")} -->`,
            "",
          );
        }

        if (includeOutline) {
          lines.push(`## turn-${index + 1}`, "", "### User", "");
        } else {
          lines.push("## User", "");
        }

        lines.push(normalizeBlock(turn.userMarkdown), "");

        if (turn.thinking && turn.thinking.text) {
          if (includeOutline) {
            lines.push("### Thinking", "");
          } else {
            lines.push("## Thinking", "");
          }

          lines.push(
            "<details>",
            "",
            `<summary>Thinking process (${turn.thinking.steps.length || "?"} steps)</summary>`,
            "",
            normalizeBlock(turn.thinking.text),
            "",
            "</details>",
            "",
          );
        }

        if (includeOutline) {
          lines.push("### Gemini", "");
        } else {
          lines.push("## Gemini", "");
        }

        const generatedFiles = collectGeneratedFiles(turn);
        const assistantMd = generatedFiles.length
          ? replaceFileTags(normalizeBlock(turn.assistantMarkdown), generatedFiles)
          : normalizeBlock(turn.assistantMarkdown);

        lines.push(assistantMd, "");

        if (turn.webCitations && turn.webCitations.length > 0) {
          if (includeOutline) {
            lines.push("#### Citations", "");
          } else {
            lines.push("### Citations", "");
          }

          turn.webCitations.forEach((citation, i) => {
            const text = citation.text || `Source ${i + 1}`;
            const sid = citation.sourceId ? ` \`${citation.sourceId}\`` : "";
            lines.push(`${i + 1}. ${text}${sid}`);
          });
          lines.push("");
        }

        if (generatedFiles.length > 0) {
          if (includeOutline) {
            lines.push("#### Generated files", "");
          } else {
            lines.push("### Generated files", "");
          }

          generatedFiles.forEach((file, i) => {
            const num = i + 1;
            const filename = file.filename || `File ${num}`;
            const link = file.downloadUrl
              ? `[${escapeMarkdownLinkText(filename)}](${escapeMarkdownLinkDestination(file.downloadUrl)})`
              : escapeMarkdownLinkText(filename);
            const mime = file.mimeType ? ` \`${file.mimeType}\`` : "";
            lines.push(`${num}. ${link}${mime}`);
          });
          lines.push("");
        }

        if (turn.uploadedFiles && turn.uploadedFiles.length > 0) {
          if (includeOutline) {
            lines.push("#### Uploaded files", "");
          } else {
            lines.push("### Uploaded files", "");
          }

          lines.push("<details>", "");
          lines.push(
            `<summary>Uploaded files (${turn.uploadedFiles.length})</summary>`,
            "",
          );
          lines.push("```json");
          lines.push(JSON.stringify(turn.uploadedFiles, null, 2));
          lines.push("```", "");
          lines.push("</details>", "");
        }

        if (turn.extensions && turn.extensions.length > 0) {
          if (includeOutline) {
            lines.push("#### Extensions", "");
          } else {
            lines.push("### Extensions", "");
          }

          lines.push("<details>", "");
          lines.push(
            `<summary>Extension/tool results (${turn.extensions.length})</summary>`,
            "",
          );
          lines.push("```json");
          lines.push(JSON.stringify(turn.extensions, null, 2));
          lines.push("```", "");
          lines.push("</details>", "");
        }

        if (turn.feedback && turn.feedback.length > 0) {
          if (includeOutline) {
            lines.push("#### Feedback", "");
          } else {
            lines.push("### Feedback", "");
          }

          lines.push("<details>", "");
          lines.push(
            `<summary>Feedback/rating groups (${turn.feedback.length})</summary>`,
            "",
          );
          lines.push("```json");
          lines.push(JSON.stringify(turn.feedback, null, 2));
          lines.push("```", "");
          lines.push("</details>", "");
        }
      });

      return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
    }

    /**
     * Render turns as a JSON string.
     * @param {Object} opts
     * @param {string} opts.title
     * @param {string} opts.sourceUrl
     * @param {string} opts.conversationId
     * @param {string} opts.exportedAt
     * @param {Turn[]} opts.turns
     * @param {*} opts.diagnostics
     * @param {boolean} [opts.includeMetadata=true]
     * @returns {string} JSON string (with trailing newline).
     */
    function renderJson({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata = true,
    }) {
      invariant(Array.isArray(turns) && turns.length > 0, "No turns to render.");

      const data = {
        title: String(title || "Gemini conversation"),
        turns: turns.map((turn, index) => ({
          index: index + 1,
          sourceIndex: turn.sourceIndex,
          userMarkdown: turn.userMarkdown,
          assistantMarkdown: turn.assistantMarkdown,
          ...(turn.responseId ? { responseId: turn.responseId } : {}),
          ...(turn.candidateId ? { candidateId: turn.candidateId } : {}),
          ...(turn.parentResponseId
            ? { parentResponseId: turn.parentResponseId }
            : {}),
          ...(turn.parentCandidateId
            ? { parentCandidateId: turn.parentCandidateId }
            : {}),
          ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
          ...(turn.model ? { model: turn.model } : {}),
          ...(turn.language ? { language: turn.language } : {}),
          ...(turn.thinking ? { thinking: turn.thinking } : {}),
          ...(turn.webCitations
            ? { webCitations: turn.webCitations }
            : {}),
          ...(turn.extensions ? { extensions: turn.extensions } : {}),
          ...(turn.uploadedFiles ? { uploadedFiles: turn.uploadedFiles } : {}),
          ...(turn.feedback ? { feedback: turn.feedback } : {}),
        })),
      };

      if (includeMetadata) {
        data.sourceUrl = sourceUrl;
        data.conversationId = conversationId;
        data.exportedAt = exportedAt;
        data.turnCount = turns.length;
        data.validation = {
          fingerprint: diagnostics.fingerprint,
          duplicateBodies: diagnostics.duplicateBodies || [],
          timestampRegressions: diagnostics.timestampRegressions || [],
          markdownWarnings: diagnostics.markdownWarnings || [],
        };
      }

      return `${JSON.stringify(data, null, 2)}\n`;
    }

    function conversationIdFromPath(pathname) {
      const parts = String(pathname).split("/").filter(Boolean);
      const appIndex =
        parts[0] === "u" && /^\d+$/.test(parts[1] || "") ? 2 : 0;

      if (parts[appIndex] !== "app" || !parts[appIndex + 1]) {
        return null;
      }

      const conversationId = parts[appIndex + 1];
      return conversationId.startsWith("c_")
        ? conversationId
        : `c_${conversationId}`;
    }

    function accountScopedPath(pathname, targetPath) {
      const accountMatch = String(pathname).match(/^\/u\/(\d+)(?:\/|$)/);
      const normalizedTarget = `/${String(targetPath).replace(/^\/+/, "")}`;

      return accountMatch
        ? `/u/${accountMatch[1]}${normalizedTarget}`
        : normalizedTarget;
    }

    function cleanDocumentTitle(documentTitle) {
      const withoutProduct = String(documentTitle || "")
        .replace(/\s*[-–—]\s*Google Gemini\s*$/i, "")
        .trim();

      return withoutProduct || "Gemini conversation";
    }

    function safeFilename(title, extension = "md") {
      const cleaned = String(title || "Gemini conversation")
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[.\s-]+$/g, "")
        .trim()
        .slice(0, 120);

      return `${cleaned || "Gemini conversation"}.${extension}`;
    }

    return Object.freeze({
      HISTORY_RPC_ID,
      accountScopedPath,
      cleanDocumentTitle,
      collectHistoryPages,
      conversationIdFromPath,
      extractTurn,
      fnv1a,
      historyToChronologicalTurns,
      parseBatchexecuteResponse,
      parseHistoryPage,
      renderMarkdown,
      renderJson,
      safeFilename,
      turnPreview,
      validateConversation,
    });
  },
);

/**
 * Generic Tampermonkey preference utilities.
 *
 * Provides safe wrappers around GM_getValue / GM_setValue for boolean
 * preferences with graceful fallback when the GM APIs are unavailable
 * (e.g. running outside Tampermonkey).
 */

const PreferenceStorage = Object.freeze({
  /**
   * Read a boolean preference from Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {boolean} fallback - Value returned if GM_getValue is unavailable
   *   or the stored value is not a boolean.
   * @returns {boolean}
   */
  readBoolean(key, fallback) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return typeof value === "boolean" ? value : fallback;
    } catch (error) {
      console.warn("[PreferenceStorage] Could not read preference", key, error);
      return fallback;
    }
  },

  /**
   * Write a boolean preference to Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {boolean} value - The value to store.
   */
  writeBoolean(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, Boolean(value));
    } catch (error) {
      console.warn("[PreferenceStorage] Could not save preference", key, error);
    }
  },

  /**
   * Read a string preference from Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {string} fallback - Value returned if GM_getValue is unavailable
   *   or the stored value is not a string.
   * @returns {string}
   */
  readString(key, fallback) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return typeof value === "string" ? value : fallback;
    } catch (error) {
      console.warn("[PreferenceStorage] Could not read preference", key, error);
      return fallback;
    }
  },

  /**
   * Write a string preference to Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {string} value - The value to store.
   */
  writeString(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, String(value));
    } catch (error) {
      console.warn("[PreferenceStorage] Could not save preference", key, error);
    }
  },
});

/**
 * Generic configurable logger for userscripts.
 *
 * Provides leveled logging (none, error, warn, info, debug) with an
 * optional persistence layer. The logger is not specific to any site —
 * it accepts a tag prefix and a storage adapter so it can be reused
 * across different userscripts.
 *
 * Usage:
 *   const log = Logger.create({
 *     tag: "[My Script]",
 *     level: "debug",
 *     storage: PreferenceStorage,  // optional: must expose readString/writeString
 *     storageKey: "myScript.logLevel",
 *   });
 *   log.info("hello");
 *   log.setLevel("warn");
 */

const Logger = Object.freeze({
  /**
   * Log level name → numeric value mapping.
   */
  LEVELS: Object.freeze({
    none: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
  }),

  /**
   * Create a logger instance.
   *
   * @param {object} opts
   * @param {string} opts.tag - Prefix string prepended to every message.
   * @param {string} [opts.level="debug"] - Initial log level name.
   * @param {object} [opts.storage] - Optional storage adapter with
   *   `readString(key, fallback)` and `writeString(key, value)`.
   * @param {string} [opts.storageKey] - Key for persisting the level
   *   via the storage adapter. Required if `storage` is provided.
   * @returns {{ level: number, error: Function, warn: Function, info: Function, debug: Function, setLevel: Function }}
   */
  create({ tag, level = "debug", storage, storageKey }) {
    const levels = Logger.LEVELS;
    const initialLevel =
      storage && storageKey
        ? levels[storage.readString(storageKey, level)] ?? levels[level]
        : levels[level] ?? levels.debug;

    const instance = {
      level: initialLevel,

      error(...args) {
        if (this.level >= levels.error) console.error(tag, ...args);
      },
      warn(...args) {
        if (this.level >= levels.warn) console.warn(tag, ...args);
      },
      info(...args) {
        if (this.level >= levels.info) console.info(tag, ...args);
      },
      debug(...args) {
        if (this.level >= levels.debug) console.debug(tag, ...args);
      },

      setLevel(name) {
        const value = levels[name];
        if (value === undefined) {
          console.warn(tag, "unknown log level:", name);
          return;
        }
        this.level = value;
        if (storage && storageKey) {
          storage.writeString(storageKey, name);
        }
        console.info(tag, "log level set to", name);
      },
    };

    return instance;
  },
});

/**
 * Generic browser and Tampermonkey utility functions.
 *
 * These helpers are not specific to any particular site — they provide
 * cross-realm cloning, random ID generation, and file download support.
 */

const Utils = Object.freeze({
  /**
   * Generate a random 7-digit request ID string.
   *
   * Used for Google RPC request correlation. Not cryptographically unique.
   *
   * @returns {string}
   */
  makeRequestId() {
    return String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  },

  /**
   * Clone a value into the page realm for Firefox cross-realm safety.
   *
   * Firefox's security boundary requires objects passed to page APIs
   * (e.g. fetch options) to originate from the page realm. `cloneInto`
   * is a Firefox/Tampermonkey global; on other browsers it is undefined
   * and the value is returned as-is.
   *
   * @param {*} value - The value to clone.
   * @param {object} pageWindow - The page's window object (unsafeWindow).
   * @returns {*}
   */
  cloneForPageRealm(value, pageWindow) {
    return typeof cloneInto === "function"
      ? cloneInto(value, pageWindow)
      : value;
  },

  /**
   * Trigger a browser download of a text file.
   *
   * Creates a Blob, generates an object URL, programmatically clicks
   * a temporary anchor element, and revokes the URL after 30 seconds.
   *
   * @param {string} content - The file content.
   * @param {string} filename - The download filename.
   * @param {string} [mimeType="text/markdown;charset=utf-8"] - The MIME type.
   */
  downloadTextFile(content, filename, mimeType = "text/markdown;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  },

  /**
   * Trigger a browser download of a binary Blob.
   *
   * @param {Blob} blob - The binary content as a Blob.
   * @param {string} filename - The download filename.
   */
  downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  },
});

/**
 * Generic paginated history fetcher.
 *
 * Implements the common flow for fetching paginated conversation history
 * from a web app's internal RPC endpoint:
 *
 *   1. Get site config (auth tokens, etc.)
 *   2. Build query parameters
 *   3. Build request body
 *   4. Build the endpoint URL
 *   5. Build fetch options (with cross-realm cloning for Firefox)
 *   6. Execute the fetch
 *   7. Validate the response
 *
 * Site-specific behavior is injected via an adapter object that provides:
 *
 *   - pageWindow:     the window object to fetch from
 *   - getConfig():    returns site-specific auth/config values
 *   - buildQuery(config, cursor):  returns URLSearchParams for the query string
 *   - buildBody(config, cursor):   returns a string (URL-encoded body)
 *   - buildEndpoint(query):        returns the full request URL string
 *   - buildFetchOptions(body):     returns the fetch options object
 *     (the fetcher handles cloneForPageRealm internally)
 */

const HistoryFetcher = Object.freeze({
  /**
   * Fetch a single page of conversation history.
   *
   * @param {object} adapter - Site-specific adapter (see module docs).
   * @param {string|null} cursor - Pagination cursor from the previous page, or null for the first page.
   * @returns {Promise<string>} Raw response text from the RPC endpoint.
   * @throws {Error} If the fetch fails or the response is not OK.
   */
  async fetchPage(adapter, cursor) {
    const config = adapter.getConfig();
    const query = adapter.buildQuery(config, cursor);
    const body = adapter.buildBody(config, cursor);
    const endpoint = adapter.buildEndpoint(query);
    const requestOptions = Utils.cloneForPageRealm(
      adapter.buildFetchOptions(body),
      adapter.pageWindow,
    );

    const response = await adapter.pageWindow.fetch(endpoint, requestOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `History request failed with HTTP ${response.status}.`,
      );
    }

    return text;
  },
});

/**
 * Generic Shadow DOM UI builders for userscripts.
 *
 * All functions are pure DOM construction — no site-specific labels,
 * preference keys, or business logic. Callers pass in all text and
 * behavior via parameters so the same builders can be reused across
 * different userscripts.
 */

const Ui = Object.freeze({
  /**
   * Create a Shadow DOM host with an injected stylesheet.
   *
   * @param {string} rootId - ID for the host element.
   * @param {string} cssText - CSS content for the shadow root.
   * @returns {{ host: HTMLElement, shadow: ShadowRoot }}
   */
  createShadowRoot(rootId, cssText) {
    const host = document.createElement("div");
    host.id = rootId;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.append(style);
    return { host, shadow };
  },

  /**
   * Create a toast notification element with auto-hide.
   *
   * @returns {{ element: HTMLElement, show: (message: string, kind?: string, duration?: number) => void }}
   */
  createToast() {
    const element = document.createElement("div");
    element.className = "toast";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    let timer = null;

    function show(message, kind = "success", duration = 8_000) {
      clearTimeout(timer);
      element.textContent = message;
      element.dataset.kind = kind;
      element.style.display = "block";
      timer = setTimeout(() => {
        element.style.display = "none";
      }, duration);
    }

    return { element, show };
  },

  /**
   * Create a labeled checkbox option row.
   *
   * @param {object} opts
   * @param {string} opts.label - Option label text.
   * @param {string} opts.description - Option description text.
   * @param {boolean} opts.checked - Initial checked state.
   * @param {(value: boolean) => void} opts.onChange - Change callback.
   * @returns {{ option: HTMLElement, input: HTMLInputElement }}
   */
  createCheckboxOption({ label, description, checked, onChange }) {
    const option = document.createElement("label");
    option.className = "option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));

    const copy = document.createElement("span");
    copy.className = "option-copy";

    const optionLabel = document.createElement("span");
    optionLabel.className = "option-label";
    optionLabel.textContent = label;

    const optionDescription = document.createElement("span");
    optionDescription.className = "option-description";
    optionDescription.textContent = description;

    copy.append(optionLabel, optionDescription);
    option.append(input, copy);
    return { option, input };
  },

  /**
   * Create a select dropdown option.
   *
   * @param {object} opts
   * @param {string} opts.label - Option label text.
   * @param {string} opts.description - Option description text.
   * @param {string} opts.value - Currently selected value.
   * @param {Array<{value: string, label: string}>} opts.choices - Select options.
   * @param {(value: string) => void} opts.onChange - Change callback.
   * @returns {{ option: HTMLElement, select: HTMLSelectElement }}
   */
  createSelectOption({ label, description, value, choices, onChange }) {
    const option = document.createElement("label");
    option.className = "option";

    const copy = document.createElement("span");
    copy.className = "option-copy";

    const optionLabel = document.createElement("span");
    optionLabel.className = "option-label";
    optionLabel.textContent = label;

    const optionDescription = document.createElement("span");
    optionDescription.className = "option-description";
    optionDescription.textContent = description;

    const select = document.createElement("select");
    select.className = "option-select";
    for (const choice of choices) {
      const opt = document.createElement("option");
      opt.value = choice.value;
      opt.textContent = choice.label;
      select.append(opt);
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));

    copy.append(optionLabel, optionDescription);
    option.append(select, copy);
    return { option, select };
  },

  /**
   * Create an export control bar with one or more export buttons and a
   * menu button.
   *
   * Returns state setters that encapsulate DOM manipulation:
   *   - setMenuExpanded(expanded): toggle aria-expanded on the menu button
   *   - setBusy(busy, index, { icon, label, ariaLabel }): disable all
   *     buttons, swap icon/label on button[index]
   *   - setCollapsed(collapsed, { titles }): toggle dataset.collapsed +
   *     button titles (titles is an array matching the buttons order)
   *
   * @param {object} opts
   * @param {Array<{ label: string, ariaLabel: string, icon?: string }>} opts.buttons - Export button configs (left to right).
   * @param {string} opts.menuAriaLabel - Menu button aria-label.
   * @param {string} [opts.menuIcon="⋮"] - Icon character for the menu button.
   * @returns {{ control, buttons, menuButton, setMenuExpanded, setBusy, setCollapsed }}
   */
  createExportControl({
    buttons: buttonConfigs,
    menuAriaLabel,
    menuIcon = "⋮",
  }) {
    const control = document.createElement("div");
    control.className = "control";

    const buttons = buttonConfigs.map(({ label, ariaLabel, icon = "↓" }, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "export-button";
      button.setAttribute("aria-label", ariaLabel);

      const downloadIcon = document.createElement("span");
      downloadIcon.className = "download-icon";
      downloadIcon.setAttribute("aria-hidden", "true");
      downloadIcon.textContent = icon;

      const exportLabel = document.createElement("span");
      exportLabel.className = "export-label";
      exportLabel.textContent = label;

      button.append(downloadIcon, exportLabel);

      if (index > 0) {
        button.classList.add("export-button--secondary");
      }

      return { button, downloadIcon, exportLabel };
    });

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "menu-button";
    menuButton.textContent = menuIcon;
    menuButton.setAttribute("aria-label", menuAriaLabel);
    menuButton.setAttribute("aria-haspopup", "dialog");
    menuButton.setAttribute("aria-expanded", "false");

    control.append(...buttons.map((b) => b.button), menuButton);

    function setMenuExpanded(expanded) {
      menuButton.setAttribute("aria-expanded", String(expanded));
    }

    function setBusy(busy, index, { icon, label, ariaLabel } = {}) {
      buttons.forEach((b) => {
        b.button.disabled = busy;
      });
      if (index !== undefined && buttons[index]) {
        const b = buttons[index];
        if (icon !== undefined) b.downloadIcon.textContent = icon;
        if (label !== undefined) b.exportLabel.textContent = label;
        if (ariaLabel !== undefined) b.button.setAttribute("aria-label", ariaLabel);
      }
    }

    function setCollapsed(collapsed, { titles } = {}) {
      control.dataset.collapsed = String(collapsed);
      buttons.forEach((b, index) => {
        b.button.title = collapsed ? (titles?.[index] ?? "") : "";
      });
    }

    return {
      control,
      buttons: buttons.map((b) => b.button),
      menuButton,
      setMenuExpanded,
      setBusy,
      setCollapsed,
    };
  },

  /**
   * Create a vertical stack container and append children to it.
   *
   * @param {string} className - CSS class for the stack element.
   * @param {...HTMLElement} children - Elements to append.
   * @returns {HTMLElement}
   */
  createStack(className, ...children) {
    const stack = document.createElement("div");
    stack.className = className;
    stack.append(...children);
    return stack;
  },

  /**
   * Create an options panel with heading, checkbox options, and a compact toggle.
   *
   * Returns state setters:
   *   - setOpen(open): toggle panel.hidden
   *   - setCompactToggleLabel(text): set compactToggle.textContent
   *
   * @param {object} opts
   * @param {string} opts.heading - Panel heading text.
   * @param {string} opts.ariaLabel - Panel aria-label.
   * @param {Array<{ label: string, description: string, checked: boolean, onChange: (value: boolean) => void }>} opts.options - Checkbox option configs.
   * @returns {{ panel, compactToggle, setOpen, setCompactToggleLabel }}
   */
  createOptionsPanel({ heading, ariaLabel, options }) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", ariaLabel);

    const panelHeading = document.createElement("p");
    panelHeading.className = "panel-heading";
    panelHeading.textContent = heading;

    panel.append(panelHeading);

    for (const optionConfig of options) {
      const { option } = Ui.createCheckboxOption(optionConfig);
      panel.append(option);
    }

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "compact-toggle";

    panel.append(compactToggle);

    function setOpen(open) {
      panel.hidden = !open;
    }

    function setCompactToggleLabel(text) {
      compactToggle.textContent = text;
    }

    return { panel, compactToggle, setOpen, setCompactToggleLabel };
  },
});

/**
 * Download strategy pattern for generated files.
 *
 * Each strategy implements:
 *   id          — unique identifier (stored in preferences)
 *   label       — human-readable label for UI
 *   description — short description for UI
 *   async execute(context) — performs the download/export
 *
 * The context object contains:
 *   turns          — chronological Turn objects (with generatedFiles in extensions)
 *   title          — conversation title
 *   conversationId — conversation ID
 *   sourceUrl      — source URL
 *   exportedAt     — ISO timestamp
 *   diagnostics    — validation diagnostics
 *   preferences    — { includeMetadata, includeOutline }
 *   pageWindow     — page window object (for fetch with cookies)
 *   Core           — core module reference
 *   Utils          — utils module reference
 *   fflate         — fflate library reference (for ZIP strategies)
 */

const DownloadStrategies = Object.freeze({
  /**
   * List all available strategy definitions.
   * Each has: id, label, description
   */
  definitions: Object.freeze([
    {
      id: "link-only",
      label: "Link only",
      description: "Render authenticated download URLs as links (no file download)",
    },
    {
      id: "zip-bundle",
      label: "ZIP bundle",
      description: "Download generated files and bundle with markdown/JSON into a ZIP",
    },
  ]),

  /**
   * Collect all generated files from all turns.
   * @param {Array} turns - Chronological Turn objects.
   * @returns {Array} Array of { turn, file } objects.
   */
  collectAllGeneratedFiles(turns) {
    const files = [];
    for (const turn of turns) {
      if (!turn.extensions) continue;
      for (const ext of turn.extensions) {
        if (!ext.generatedFiles) continue;
        for (const file of ext.generatedFiles) {
          files.push({ turn, file });
        }
      }
    }
    return files;
  },

  /**
   * Fetch a file's binary content using the page's fetch (with Google cookies).
   * @param {string} url - Download URL.
   * @param {object} pageWindow - Page window object.
   * @returns {Promise<Uint8Array>} File content as byte array.
   */
  async fetchFileContent(url, pageWindow) {
    const fetchFn = pageWindow.fetch.bind(pageWindow);
    const res = await fetchFn(url, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  },

  /**
   * Sanitize a filename for use inside a ZIP.
   * @param {string} name - Original filename.
   * @returns {string} Sanitized filename.
   */
  sanitizeZipFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
  },

  /**
   * Build a ZIP file containing the exported content and all generated files.
   * @param {object} context - Export context (see module docs).
   * @returns {Promise<{ blob: Blob, filename: string }>} ZIP blob and filename.
   */
  async buildZipBundle(context) {
    const { turns, title, sourceUrl, conversationId, exportedAt, diagnostics,
            preferences, pageWindow, Core, fflate } = context;

    const safeTitle = Core.safeFilename(title);
    const zipData = {};

    // Generate markdown content for the ZIP
    const markdown = Core.renderMarkdown({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata: preferences.includeMetadata,
      includeOutline: preferences.includeOutline,
    });
    zipData[`${safeTitle}.md`] = new TextEncoder().encode(markdown);

    // Generate JSON content for the ZIP
    const json = Core.renderJson({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata: preferences.includeMetadata,
    });
    zipData[`${safeTitle}.json`] = new TextEncoder().encode(json);

    // Download generated files
    const generatedFiles = DownloadStrategies.collectAllGeneratedFiles(turns);
    const filesDir = "generated-files";
    const usedNames = new Set();

    for (const { turn, file } of generatedFiles) {
      if (!file.downloadUrl || !file.filename) continue;
      try {
        const content = await DownloadStrategies.fetchFileContent(
          file.downloadUrl,
          pageWindow,
        );
        // Avoid name collisions in the ZIP
        let name = DownloadStrategies.sanitizeZipFilename(file.filename);
        let candidate = `${filesDir}/${name}`;
        let counter = 1;
        while (usedNames.has(candidate)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          candidate = `${filesDir}/${base}-${counter}${ext}`;
          counter++;
        }
        usedNames.add(candidate);
        zipData[candidate] = content;
      } catch (err) {
        // If a file fails, include an error note but continue
        const errorName = `${filesDir}/${DownloadStrategies.sanitizeZipFilename(file.filename)}.ERROR.txt`;
        zipData[errorName] = new TextEncoder().encode(
          `Failed to download ${file.filename}: ${err.message}\nURL: ${file.downloadUrl}\n`,
        );
      }
    }

    const zipBytes = fflate.zipSync(zipData);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const filename = `${safeTitle}.zip`;
    return { blob, filename };
  },

  /**
   * Execute a download strategy.
   * @param {string} strategyId - Strategy ID (e.g. "link-only", "zip-bundle").
   * @param {object} context - Export context (see module docs).
   * @param {string} formatId - Export format ("markdown" or "json").
   * @returns {Promise<void>}
   */
  async execute(strategyId, context, formatId) {
    switch (strategyId) {
      case "link-only":
        // Link-only: just download the text file as before.
        // The markdown/JSON already contains download links.
        return { mode: "text" };

      case "zip-bundle": {
        const { blob, filename } = await DownloadStrategies.buildZipBundle(context);
        // Trigger browser download of the ZIP
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.style.display = "none";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
        return { mode: "zip", filename };
      }

      default:
        throw new Error(`Unknown download strategy: ${strategyId}`);
    }
  },
});

!function(f){typeof module!='undefined'&&typeof exports=='object'?module.exports=f():typeof define!='undefined'&&define.amd?define(f):(typeof self!='undefined'?self:this).fflate=f()}(function(){var _e={};"use strict";_e.deflate=zt,_e.deflateSync=kt,_e.inflate=At,_e.inflateSync=Tt,_e.gzip=It,_e.compress=It,_e.gzipSync=Ut,_e.compressSync=Ut,_e.gunzip=Zt,_e.gunzipSync=qt,_e.zlib=Lt,_e.zlibSync=Bt,_e.unzlib=Nt,_e.unzlibSync=Pt,_e.gzip=It,_e.compress=It,_e.decompress=Jt,_e.decompressSync=Kt,_e.strToU8=nn,_e.strFromU8=rn,_e.zip=dn,_e.zipSync=gn,_e.unzip=zn,_e.unzipSync=kn;var t=(typeof module!='undefined'&&typeof exports=='object'?function(_f){"use strict";var e,r,t,n=";var __w=require('worker_threads');__w.parentPort.on('message',function(m){onmessage({data:m})}),postMessage=function(m,t){__w.parentPort.postMessage(m,t)},close=process.exit;self=global";try{e=require("worker_threads"),r=e.Worker,t=e.isMarkedAsUntransferable}catch(e){}exports.default=r?function(e,o,a,s,u){var i=!1,l=new r(e+n,{eval:!0}).on("error",function(e){return u(e,null)}).on("message",function(e){return u(null,e)}).on("exit",function(e){e&&!i&&u(Error("exited with code "+e),null)});return t&&(s=s.filter(function(e){return!t(e)})),l.postMessage(a,s),l.terminate=function(){return i=!0,r.prototype.terminate.call(l)},l}:function(e,r,t,n,o){setImmediate(function(){return o(Error("async operations unsupported - update to Node 12+ (or Node 10-11 with the --experimental-worker CLI flag)"),null)});var a=function(){};return{terminate:a,postMessage:a}};return _f}:function(_f){"use strict";var e={};_f.default=function(r,t,s,a,n){var o=new Worker(e[t]||(e[t]=URL.createObjectURL(new Blob([r+';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'],{type:"text/javascript"}))));return o.onmessage=function(e){var r=e.data,t=r.$e$;if(t){var s=Error(t[0]);s.code=t[1],s.stack=t[2],n(s,null)}else n(null,r)},o.postMessage(s,a),o};return _f})({}),n=Uint8Array,r=Uint16Array,i=Int32Array,e=new n([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),o=new n([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),s=new n([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),a=function(t,n){for(var e=new r(31),o=0;o<31;++o)e[o]=n+=1<<t[o-1];var s=new i(e[30]);for(o=1;o<30;++o)for(var a=e[o];a<e[o+1];++a)s[a]=a-e[o]<<5|o;return{b:e,r:s}},u=a(e,2),h=u.b,f=u.r;h[28]=258,f[258]=28;for(var c=a(o,0),l=c.b,p=c.r,v=new r(32768),d=0;d<32768;++d){var g=(43690&d)>>1|(21845&d)<<1;v[d]=((65280&(g=(61680&(g=(52428&g)>>2|(13107&g)<<2))>>4|(3855&g)<<4))>>8|(255&g)<<8)>>1}var y=function(t,n,i){for(var e=t.length,o=0,s=new r(n);o<e;++o)t[o]&&++s[t[o]-1];var a,u=new r(n);for(o=1;o<n;++o)u[o]=u[o-1]+s[o-1]<<1;if(i){a=new r(1<<n);var h=15-n;for(o=0;o<e;++o)if(t[o])for(var f=o<<4|t[o],c=n-t[o],l=u[t[o]-1]++<<c,p=l|(1<<c)-1;l<=p;++l)a[v[l]>>h]=f}else for(a=new r(e),o=0;o<e;++o)t[o]&&(a[o]=v[u[t[o]-1]++]>>15-t[o]);return a},m=new n(288);for(d=0;d<144;++d)m[d]=8;for(d=144;d<256;++d)m[d]=9;for(d=256;d<280;++d)m[d]=7;for(d=280;d<288;++d)m[d]=8;var b=new n(32);for(d=0;d<32;++d)b[d]=5;var w=y(m,9,0),x=y(m,9,1),z=y(b,5,0),k=y(b,5,1),M=function(t){for(var n=t[0],r=1;r<t.length;++r)t[r]>n&&(n=t[r]);return n},S=function(t,n,r){var i=n/8|0;return(t[i]|t[i+1]<<8)>>(7&n)&r},A=function(t,n){var r=n/8|0;return(t[r]|t[r+1]<<8|t[r+2]<<16)>>(7&n)},T=function(t){return(t+7)/8|0},D=function(t,r,i){return(null==r||r<0)&&(r=0),(null==i||i>t.length)&&(i=t.length),new n(t.subarray(r,i))};_e.FlateErrorCode={UnexpectedEOF:0,InvalidBlockType:1,InvalidLengthLiteral:2,InvalidDistance:3,StreamFinished:4,NoStreamHandler:5,InvalidHeader:6,NoCallback:7,InvalidUTF8:8,ExtraFieldTooLong:9,InvalidDate:10,FilenameTooLong:11,StreamFinishing:12,InvalidZipData:13,UnknownCompressionMethod:14};var C=["unexpected EOF","invalid block type","invalid length/literal","invalid distance","stream finished","no stream handler",,"no callback","invalid UTF-8 data","extra field too long","date not in range 1980-2099","filename too long","stream finishing","invalid zip data"],I=function(t,n,r){var i=Error(n||C[t]);if(i.code=t,Error.captureStackTrace&&Error.captureStackTrace(i,I),!r)throw i;return i},U=function(t,r,i,a){var u=t.length,f=a?a.length:0;if(!u||r.f&&!r.l)return i||new n(0);var c=!i,p=c||2!=r.i,v=r.i;c&&(i=new n(3*u));var d=function(t){var r=i.length;if(t>r){var e=new n(Math.max(2*r,t));e.set(i),i=e}},g=r.f||0,m=r.p||0,b=r.b||0,w=r.l,z=r.d,C=r.m,U=r.n,F=8*u;do{if(!w){g=S(t,m,1);var E=S(t,m+1,3);if(m+=3,!E){var Z=t[(Y=T(m)+4)-4]|t[Y-3]<<8,q=Y+Z;if(q>u){v&&I(0);break}p&&d(b+Z),i.set(t.subarray(Y,q),b),r.b=b+=Z,r.p=m=8*q,r.f=g;continue}if(1==E)w=x,z=k,C=9,U=5;else if(2==E){var O=S(t,m,31)+257,G=S(t,m+10,15)+4,L=O+S(t,m+5,31)+1;m+=14;for(var B=new n(L),H=new n(19),j=0;j<G;++j)H[s[j]]=S(t,m+3*j,7);m+=3*G;var N=M(H),P=(1<<N)-1,V=y(H,N,1);for(j=0;j<L;){var Y,J=V[S(t,m,P)];if(m+=15&J,(Y=J>>4)<16)B[j++]=Y;else{var K=0,Q=0;for(16==Y?(Q=3+S(t,m,3),m+=2,K=B[j-1]):17==Y?(Q=3+S(t,m,7),m+=3):18==Y&&(Q=11+S(t,m,127),m+=7);Q--;)B[j++]=K}}var R=B.subarray(0,O),W=B.subarray(O);C=M(R),U=M(W),w=y(R,C,1),z=y(W,U,1)}else I(1);if(m>F){v&&I(0);break}}p&&d(b+131072);for(var X=(1<<C)-1,$=(1<<U)-1,_=m;;_=m){var tt=(K=w[A(t,m)&X])>>4;if((m+=15&K)>F){v&&I(0);break}if(K||I(2),tt<256)i[b++]=tt;else{if(256==tt){_=m,w=null;break}var nt=tt-254;tt>264&&(nt=S(t,m,(1<<(et=e[j=tt-257]))-1)+h[j],m+=et);var rt=z[A(t,m)&$],it=rt>>4;if(rt||I(3),m+=15&rt,W=l[it],it>3){var et=o[it];W+=A(t,m)&(1<<et)-1,m+=et}if(m>F){v&&I(0);break}p&&d(b+131072);var ot=b+nt;if(b<W){var st=f-W,at=Math.min(W,ot);for(st+b<0&&I(3);b<at;++b)i[b]=a[st+b]}for(;b<ot;++b)i[b]=i[b-W]}}r.l=w,r.p=_,r.b=b,r.f=g,w&&(g=1,r.m=C,r.d=z,r.n=U)}while(!g);return b!=i.length&&c?D(i,0,b):i.subarray(0,b)},F=function(t,n,r){var i=n/8|0;t[i]|=r<<=7&n,t[i+1]|=r>>8},E=function(t,n,r){var i=n/8|0;t[i]|=r<<=7&n,t[i+1]|=r>>8,t[i+2]|=r>>16},Z=function(t,i){for(var e=[],o=0;o<t.length;++o)t[o]&&e.push({s:o,f:t[o]});var s=e.length,a=e.slice();if(!s)return{t:j,l:0};if(1==s){var u=new n(e[0].s+1);return u[e[0].s]=1,{t:u,l:1}}e.sort(function(t,n){return t.f-n.f}),e.push({s:-1,f:25001});var h=e[0],f=e[1],c=0,l=1,p=2;for(e[0]={s:-1,f:h.f+f.f,l:h,r:f};l!=s-1;)h=e[e[c].f<e[p].f?c++:p++],f=e[c!=l&&e[c].f<e[p].f?c++:p++],e[l++]={s:-1,f:h.f+f.f,l:h,r:f};var v=a[0].s;for(o=1;o<s;++o)a[o].s>v&&(v=a[o].s);var d=new r(v+1),g=q(e[l-1],d,0);if(g>i){o=0;var y=0,m=g-i,b=1<<m;for(a.sort(function(t,n){return d[n.s]-d[t.s]||t.f-n.f});o<s;++o){var w=a[o].s;if(!(d[w]>i))break;y+=b-(1<<g-d[w]),d[w]=i}for(y>>=m;y>0;){var x=a[o].s;d[x]<i?y-=1<<i-d[x]++-1:++o}for(;o>=0&&y;--o){var z=a[o].s;d[z]==i&&(--d[z],++y)}g=i}return{t:new n(d),l:g}},q=function(t,n,r){return-1==t.s?Math.max(q(t.l,n,r+1),q(t.r,n,r+1)):n[t.s]=r},O=function(t){for(var n=t.length;n&&!t[--n];);for(var i=new r(++n),e=0,o=t[0],s=1,a=function(t){i[e++]=t},u=1;u<=n;++u)if(t[u]==o&&u!=n)++s;else{if(!o&&s>2){for(;s>138;s-=138)a(32754);s>2&&(a(s>10?s-11<<5|28690:s-3<<5|12305),s=0)}else if(s>3){for(a(o),--s;s>6;s-=6)a(8304);s>2&&(a(s-3<<5|8208),s=0)}for(;s--;)a(o);s=1,o=t[u]}return{c:i.subarray(0,e),n:n}},G=function(t,n){for(var r=0,i=0;i<n.length;++i)r+=t[i]*n[i];return r},L=function(t,n,r){var i=r.length,e=T(n+2);t[e]=255&i,t[e+1]=i>>8,t[e+2]=255^t[e],t[e+3]=255^t[e+1];for(var o=0;o<i;++o)t[e+o+4]=r[o];return 8*(e+4+i)},B=function(t,n,i,a,u,h,f,c,l,p,v){F(n,v++,i),++u[256];for(var d=Z(u,15),g=d.t,x=d.l,k=Z(h,15),M=k.t,S=k.l,A=O(g),T=A.c,D=A.n,C=O(M),I=C.c,U=C.n,q=new r(19),B=0;B<T.length;++B)++q[31&T[B]];for(B=0;B<I.length;++B)++q[31&I[B]];for(var H=Z(q,7),j=H.t,N=H.l,P=19;P>4&&!j[s[P-1]];--P);var V,Y,J,K,Q=p+5<<3,R=G(u,m)+G(h,b)+f,W=G(u,g)+G(h,M)+f+14+3*P+G(q,j)+2*q[16]+3*q[17]+7*q[18];if(l>=0&&Q<=R&&Q<=W)return L(n,v,t.subarray(l,l+p));if(F(n,v,1+(W<R)),v+=2,W<R){V=y(g,x,0),Y=g,J=y(M,S,0),K=M;var X=y(j,N,0);for(F(n,v,D-257),F(n,v+5,U-1),F(n,v+10,P-4),v+=14,B=0;B<P;++B)F(n,v+3*B,j[s[B]]);v+=3*P;for(var $=[T,I],_=0;_<2;++_){var tt=$[_];for(B=0;B<tt.length;++B)F(n,v,X[rt=31&tt[B]]),v+=j[rt],rt>15&&(F(n,v,tt[B]>>5&127),v+=tt[B]>>12)}}else V=w,Y=m,J=z,K=b;for(B=0;B<c;++B){var nt=a[B];if(nt>255){var rt;E(n,v,V[257+(rt=nt>>18&31)]),v+=Y[rt+257],rt>7&&(F(n,v,nt>>23&31),v+=e[rt]);var it=31&nt;E(n,v,J[it]),v+=K[it],it>3&&(E(n,v,nt>>5&8191),v+=o[it])}else E(n,v,V[nt]),v+=Y[nt]}return E(n,v,V[256]),v+Y[256]},H=new i([65540,131080,131088,131104,262176,1048704,1048832,2114560,2117632]),j=new n(0),N=function(t,s,a,u,h,c){var l=c.z||t.length,v=new n(u+l+5*(1+Math.ceil(l/7e3))+h),d=v.subarray(u,v.length-h),g=c.l,y=7&(c.r||0);if(s){y&&(d[0]=c.r>>3);for(var m=H[s-1],b=m>>13,w=8191&m,x=(1<<a)-1,z=c.p||new r(32768),k=c.h||new r(x+1),M=Math.ceil(a/3),S=2*M,A=function(n){return(t[n]^t[n+1]<<M^t[n+2]<<S)&x},C=new i(25e3),I=new r(288),U=new r(32),F=0,E=0,Z=c.i||0,q=0,O=c.w||0,G=0;Z+2<l;++Z){var j=A(Z),N=32767&Z,P=k[j];if(z[N]=P,k[j]=N,O<=Z){var V=l-Z;if((F>7e3||q>24576)&&(V>423||!g)){y=B(t,d,0,C,I,U,E,q,G,Z-G,y),q=F=E=0,G=Z;for(var Y=0;Y<286;++Y)I[Y]=0;for(Y=0;Y<30;++Y)U[Y]=0}var J=2,K=0,Q=w,R=N-P&32767;if(V>2&&j==A(Z-R))for(var W=Math.min(b,V)-1,X=Math.min(32767,Z),$=Math.min(258,V);R<=X&&--Q&&N!=P;){if(t[Z+J]==t[Z+J-R]){for(var _=0;_<$&&t[Z+_]==t[Z+_-R];++_);if(_>J){if(J=_,K=R,_>W)break;var tt=Math.min(R,_-2),nt=0;for(Y=0;Y<tt;++Y){var rt=Z-R+Y&32767,it=rt-z[rt]&32767;it>nt&&(nt=it,P=rt)}}}R+=(N=P)-(P=z[N])&32767}if(K){C[q++]=268435456|f[J]<<18|p[K];var et=31&f[J],ot=31&p[K];E+=e[et]+o[ot],++I[257+et],++U[ot],O=Z+J,++F}else C[q++]=t[Z],++I[t[Z]]}}for(Z=Math.max(Z,O);Z<l;++Z)C[q++]=t[Z],++I[t[Z]];y=B(t,d,g,C,I,U,E,q,G,Z-G,y),g||(c.r=7&y|d[y/8|0]<<3,y-=7,c.h=k,c.p=z,c.i=Z,c.w=O)}else{for(Z=c.w||0;Z<l+g;Z+=65535){var st=Z+65535;st>=l&&(d[y/8|0]=g,st=l),y=L(d,y+1,t.subarray(Z,st))}c.i=l}return D(v,0,u+T(y)+h)},P=function(){for(var t=new Int32Array(256),n=0;n<256;++n){for(var r=n,i=9;--i;)r=(1&r&&-306674912)^r>>>1;t[n]=r}return t}(),V=function(){var t=-1;return{p:function(n){for(var r=t,i=0;i<n.length;++i)r=P[255&r^n[i]]^r>>>8;t=r},d:function(){return~t}}},Y=function(){var t=1,n=0;return{p:function(r){for(var i=t,e=n,o=0|r.length,s=0;s!=o;){for(var a=Math.min(s+2655,o);s<a;++s)e+=i+=r[s];i=(65535&i)+15*(i>>16),e=(65535&e)+15*(e>>16)}t=i,n=e},d:function(){return(255&(t%=65521))<<24|(65280&t)<<8|(255&(n%=65521))<<8|n>>8}}},J=function(t,r,i,e,o){if(!o&&(o={l:1},r.dictionary)){var s=r.dictionary.subarray(-32768),a=new n(s.length+t.length);a.set(s),a.set(t,s.length),t=a,o.w=s.length}return N(t,null==r.level?6:r.level,null==r.mem?o.l?Math.ceil(1.5*Math.max(8,Math.min(13,Math.log(t.length)))):20:12+r.mem,i,e,o)},K=function(t,n){var r={};for(var i in t)r[i]=t[i];for(var i in n)r[i]=n[i];return r},Q=function(t,n,r){for(var i=t(),e=""+t,o=e.slice(e.indexOf("[")+1,e.lastIndexOf("]")).replace(/\s+/g,"").split(","),s=0;s<i.length;++s){var a=i[s],u=o[s];if("function"==typeof a){n+=";"+u+"=";var h=""+a;if(a.prototype)if(-1!=h.indexOf("[native code]")){var f=h.indexOf(" ",8)+1;n+=h.slice(f,h.indexOf("(",f))}else for(var c in n+=h,a.prototype)n+=";"+u+".prototype."+c+"="+a.prototype[c];else n+=h}else r[u]=a}return n},R=[],W=function(t){var n=[];for(var r in t)t[r].buffer&&n.push((t[r]=new t[r].constructor(t[r])).buffer);return n},X=function(n,r,i,e){if(!R[i]){for(var o="",s={},a=n.length-1,u=0;u<a;++u)o=Q(n[u],o,s);R[i]={c:Q(n[a],o,s),e:s}}var h=K({},R[i].e);return(0,t.default)(R[i].c+";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage="+r+"}",i,h,W(h),e)},$=function(){return[n,r,i,e,o,s,h,l,x,k,v,C,y,M,S,A,T,D,I,U,Tt,et,ot]},_=function(){return[n,r,i,e,o,s,f,p,w,m,z,b,v,H,j,y,F,E,Z,q,O,G,L,B,T,D,N,J,kt,et]},tt=function(){return[pt,gt,lt,V,P]},nt=function(){return[vt,dt]},rt=function(){return[yt,lt,Y]},it=function(){return[mt]},et=function(t){return postMessage(t,[t.buffer])},ot=function(t){return t&&{out:t.size&&new n(t.size),dictionary:t.dictionary}},st=function(t,n,r,i,e,o){var s=X(r,i,e,function(t,n){s.terminate(),o(t,n)});return s.postMessage([t,n],n.consume?[t.buffer]:[]),function(){s.terminate()}},at=function(t){return t.ondata=function(t,n){return postMessage([t,n],[t.buffer])},function(n){n.data[0]?(t.push(n.data[0],n.data[1]),postMessage([n.data[0].length])):t.flush(n.data[1])}},ut=function(t,n,r,i,e,o,s){var a,u=X(t,i,e,function(t,r){t?(u.terminate(),n.ondata.call(n,t)):Array.isArray(r)?1==r.length?(n.queuedSize-=r[0],n.ondrain&&n.ondrain(r[0])):(r[1]&&u.terminate(),n.ondata.call(n,t,r[0],r[1])):s(r)});u.postMessage(r),n.queuedSize=0,n.push=function(t,r){n.ondata||I(5),a&&n.ondata(I(4,0,1),null,!!r),n.queuedSize+=t.length,u.postMessage([t,a=r],t.buffer instanceof ArrayBuffer?[t.buffer]:[])},n.terminate=function(){u.terminate()},o&&(n.flush=function(t){u.postMessage([0,t])})},ht=function(t,n){return t[n]|t[n+1]<<8},ft=function(t,n){return(t[n]|t[n+1]<<8|t[n+2]<<16|t[n+3]<<24)>>>0},ct=function(t,n){return ft(t,n)+4294967296*ft(t,n+4)},lt=function(t,n,r){for(;r;++n)t[n]=r,r>>>=8},pt=function(t,n){var r=n.filename;if(t[0]=31,t[1]=139,t[2]=8,t[8]=n.level<2?4:9==n.level?2:0,t[9]=3,0!=n.mtime&&lt(t,4,Math.floor(new Date(n.mtime||Date.now())/1e3)),r){t[3]=8;for(var i=0;i<=r.length;++i)t[i+10]=r.charCodeAt(i)}},vt=function(t){31==t[0]&&139==t[1]&&8==t[2]||I(6,"invalid gzip data");var n=t[3],r=10;4&n&&(r+=2+(t[10]|t[11]<<8));for(var i=(n>>3&1)+(n>>4&1);i>0;i-=!t[r++]);return r+(2&n)},dt=function(t){var n=t.length;return(t[n-4]|t[n-3]<<8|t[n-2]<<16|t[n-1]<<24)>>>0},gt=function(t){return 10+(t.filename?t.filename.length+1:0)},yt=function(t,n){var r=n.level,i=0==r?0:r<6?1:9==r?3:2;if(t[0]=120,t[1]=i<<6|(n.dictionary&&32),t[1]|=31-(t[0]<<8|t[1])%31,n.dictionary){var e=Y();e.p(n.dictionary),lt(t,2,e.d())}},mt=function(t,n){return(8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31)&&I(6,"invalid zlib data"),(t[1]>>5&1)==+!n&&I(6,"invalid zlib data: "+(32&t[1]?"need":"unexpected")+" dictionary"),2+(t[1]>>3&4)};function bt(t,n){return"function"==typeof t&&(n=t,t={}),this.ondata=n,t}var wt=function(){function t(t,r){if("function"==typeof t&&(r=t,t={}),this.ondata=r,this.o=t||{},this.s={l:0,i:32768,w:32768,z:32768},this.b=new n(98304),this.o.dictionary){var i=this.o.dictionary.subarray(-32768);this.b.set(i,32768-i.length),this.s.i=32768-i.length}}return t.prototype.p=function(t,n){this.ondata(J(t,this.o,0,0,this.s),n)},t.prototype.push=function(t,r){this.ondata||I(5),this.s.l&&I(4);var i=t.length+this.s.z;if(i>this.b.length){if(i>2*this.b.length-32768){var e=new n(-32768&i);e.set(this.b.subarray(0,this.s.z)),this.b=e}var o=this.b.length-this.s.z;this.b.set(t.subarray(0,o),this.s.z),this.s.z=this.b.length,this.p(this.b,!1),this.b.set(this.b.subarray(-32768)),this.b.set(t.subarray(o),32768),this.s.z=t.length-o+32768,this.s.i=32766,this.s.w=32768}else this.b.set(t,this.s.z),this.s.z+=t.length;this.s.l=1&r,(this.s.z>this.s.w+8191||r)&&(this.p(this.b,r||!1),this.s.w=this.s.i,this.s.i-=2),r&&(this.s=this.o={},this.b=j)},t.prototype.flush=function(t){if(this.ondata||I(5),this.s.l&&I(4),this.p(this.b,!1),this.s.w=this.s.i,this.s.i-=2,t){var r=new n(6);r[0]=this.s.r>>3;var i=L(r,this.s.r,j);this.s.r=0,this.ondata(r.subarray(0,i>>3),!1)}},t}();_e.Deflate=wt;var xt=function(){return function(t,n){ut([_,function(){return[at,wt]}],this,bt.call(this,t,n),function(t){var n=new wt(t.data);onmessage=at(n)},6,1)}}();function zt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_],function(t){return et(kt(t.data[0],t.data[1]))},0,r)}function kt(t,n){return J(t,n||{},0,0)}_e.AsyncDeflate=xt;var Mt=function(){function t(t,r){"function"==typeof t&&(r=t,t={}),this.ondata=r;var i=t&&t.dictionary&&t.dictionary.subarray(-32768);this.s={i:0,b:i?i.length:0},this.o=new n(32768),this.p=new n(0),i&&this.o.set(i)}return t.prototype.e=function(t){if(this.ondata||I(5),this.d&&I(4),this.p.length){if(t.length){var r=new n(this.p.length+t.length);r.set(this.p),r.set(t,this.p.length),this.p=r}}else this.p=t},t.prototype.c=function(t){this.s.i=+(this.d=t||!1);var n=this.s.b,r=U(this.p,this.s,this.o);this.ondata(D(r,n,this.s.b),this.d),this.o=D(r,this.s.b-32768),this.s.b=this.o.length,this.p=D(this.p,this.s.p/8|0),this.s.p&=7},t.prototype.push=function(t,n){this.e(t),this.c(n)},t}();_e.Inflate=Mt;var St=function(){return function(t,n){ut([$,function(){return[at,Mt]}],this,bt.call(this,t,n),function(t){var n=new Mt(t.data);onmessage=at(n)},7,0)}}();function At(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$],function(t){return et(Tt(t.data[0],ot(t.data[1])))},1,r)}function Tt(t,n){return U(t,{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncInflate=St;var Dt=function(){function t(t,n){this.c=V(),this.l=0,this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),this.l+=t.length,wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=J(t,this.o,this.v&&gt(this.o),n&&8,this.s);this.v&&(pt(r,this.o),this.v=0),n&&(lt(r,r.length-8,this.c.d()),lt(r,r.length-4,this.l)),this.ondata(r,n)},t.prototype.flush=function(t){wt.prototype.flush.call(this,t)},t}();_e.Gzip=Dt,_e.Compress=Dt;var Ct=function(){return function(t,n){ut([_,tt,function(){return[at,wt,Dt]}],this,bt.call(this,t,n),function(t){var n=new Dt(t.data);onmessage=at(n)},8,1)}}();function It(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_,tt,function(){return[Ut]}],function(t){return et(Ut(t.data[0],t.data[1]))},2,r)}function Ut(t,n){n||(n={});var r=V(),i=t.length;r.p(t);var e=J(t,n,gt(n),8),o=e.length;return pt(e,n),lt(e,o-8,r.d()),lt(e,o-4,i),e}_e.AsyncGzip=Ct,_e.AsyncCompress=Ct;var Ft=function(){function t(t,n){this.v=1,this.r=0,Mt.call(this,t,n)}return t.prototype.push=function(t,r){if(Mt.prototype.e.call(this,t),this.r+=t.length,this.v){var i=this.p.subarray(this.v-1),e=i.length>3?vt(i):4;if(e>i.length){if(!r)return}else this.v>1&&this.onmember&&this.onmember(this.r-i.length);this.p=i.subarray(e),this.v=0}Mt.prototype.c.call(this,0),this.s.f&&!this.s.l?(this.v=T(this.s.p)+9,this.s={i:0},this.o=new n(0),this.push(new n(0),r)):r&&Mt.prototype.c.call(this,r)},t}();_e.Gunzip=Ft;var Et=function(){return function(t,n){var r=this;ut([$,nt,function(){return[at,Mt,Ft]}],this,bt.call(this,t,n),function(t){var n=new Ft(t.data);n.onmember=function(t){return postMessage(t)},onmessage=at(n)},9,0,function(t){return r.onmember&&r.onmember(t)})}}();function Zt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$,nt,function(){return[qt]}],function(t){return et(qt(t.data[0],t.data[1]))},3,r)}function qt(t,r){var i=vt(t);return i+8>t.length&&I(6,"invalid gzip data"),U(t.subarray(i,-8),{i:2},r&&r.out||new n(dt(t)),r&&r.dictionary)}_e.AsyncGunzip=Et;var Ot=function(){function t(t,n){this.c=Y(),this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=J(t,this.o,this.v&&(this.o.dictionary?6:2),n&&4,this.s);this.v&&(yt(r,this.o),this.v=0),n&&lt(r,r.length-4,this.c.d()),this.ondata(r,n)},t.prototype.flush=function(t){wt.prototype.flush.call(this,t)},t}();_e.Zlib=Ot;var Gt=function(){return function(t,n){ut([_,rt,function(){return[at,wt,Ot]}],this,bt.call(this,t,n),function(t){var n=new Ot(t.data);onmessage=at(n)},10,1)}}();function Lt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_,rt,function(){return[Bt]}],function(t){return et(Bt(t.data[0],t.data[1]))},4,r)}function Bt(t,n){n||(n={});var r=Y();r.p(t);var i=J(t,n,n.dictionary?6:2,4);return yt(i,n),lt(i,i.length-4,r.d()),i}_e.AsyncZlib=Gt;var Ht=function(){function t(t,n){Mt.call(this,t,n),this.v=t&&t.dictionary?2:1}return t.prototype.push=function(t,n){if(Mt.prototype.e.call(this,t),this.v){if(this.p.length<6&&!n)return;this.p=this.p.subarray(mt(this.p,this.v-1)),this.v=0}n&&(this.p.length<4&&I(6,"invalid zlib data"),this.p=this.p.subarray(0,-4)),Mt.prototype.c.call(this,n)},t}();_e.Unzlib=Ht;var jt=function(){return function(t,n){ut([$,it,function(){return[at,Mt,Ht]}],this,bt.call(this,t,n),function(t){var n=new Ht(t.data);onmessage=at(n)},11,0)}}();function Nt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$,it,function(){return[Pt]}],function(t){return et(Pt(t.data[0],ot(t.data[1])))},5,r)}function Pt(t,n){return U(t.subarray(mt(t,n&&n.dictionary),-4),{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncUnzlib=jt;var Vt=function(){function t(t,n){this.o=bt.call(this,t,n)||{},this.G=Ft,this.I=Mt,this.Z=Ht}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r){t.ondata(n,r)}},t.prototype.push=function(t,r){if(this.ondata||I(5),this.s)this.s.push(t,r);else{if(this.p&&this.p.length){var i=new n(this.p.length+t.length);i.set(this.p),i.set(t,this.p.length)}else this.p=t;this.p.length>2&&(this.s=31==this.p[0]&&139==this.p[1]&&8==this.p[2]?new this.G(this.o):8!=(15&this.p[0])||this.p[0]>>4>7||(this.p[0]<<8|this.p[1])%31?new this.I(this.o):new this.Z(this.o),this.i(),this.s.push(this.p,r),this.p=null)}},t}();_e.Decompress=Vt;var Yt=function(){function t(t,n){Vt.call(this,t,n),this.queuedSize=0,this.G=Et,this.I=St,this.Z=jt}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r,i){t.ondata(n,r,i)},this.s.ondrain=function(n){t.queuedSize-=n,t.ondrain&&t.ondrain(n)}},t.prototype.push=function(t,n){this.queuedSize+=t.length,Vt.prototype.push.call(this,t,n)},t}();function Jt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),31==t[0]&&139==t[1]&&8==t[2]?Zt(t,n,r):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?At(t,n,r):Nt(t,n,r)}function Kt(t,n){return 31==t[0]&&139==t[1]&&8==t[2]?qt(t,n):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?Tt(t,n):Pt(t,n)}_e.AsyncDecompress=Yt;var Qt=function(t,r,i,e){for(var o in t){var s=t[o],a=r+o,u=e;Array.isArray(s)&&(u=K(e,s[1]),s=s[0]),ArrayBuffer.isView(s)?i[a]=[s,u]:(i[a+="/"]=[new n(0),u],Qt(s,a,i,e))}},Rt="undefined"!=typeof TextEncoder&&new TextEncoder,Wt="undefined"!=typeof TextDecoder&&new TextDecoder,Xt=0;try{Wt.decode(j,{stream:!0}),Xt=1}catch(t){}var $t=function(t){for(var n="",r=0;;){var i=t[r++],e=(i>127)+(i>223)+(i>239);if(r+e>t.length)return{s:n,r:D(t,r-1)};e?3==e?(i=((15&i)<<18|(63&t[r++])<<12|(63&t[r++])<<6|63&t[r++])-65536,n+=String.fromCharCode(55296|i>>10,56320|1023&i)):n+=String.fromCharCode(1&e?(31&i)<<6|63&t[r++]:(15&i)<<12|(63&t[r++])<<6|63&t[r++]):n+=String.fromCharCode(i)}},_t=function(){function t(t){this.ondata=t,Xt?this.t=new TextDecoder:this.p=j}return t.prototype.push=function(t,r){if(this.ondata||I(5),r=!!r,this.t)return this.ondata(this.t.decode(t,{stream:!0}),r),void(r&&(this.t.decode().length&&I(8),this.t=null));this.p||I(4);var i=new n(this.p.length+t.length);i.set(this.p),i.set(t,this.p.length);var e=$t(i),o=e.s,s=e.r;r?(s.length&&I(8),this.p=null):this.p=s,this.ondata(o,r)},t}();_e.DecodeUTF8=_t;var tn=function(){function t(t){this.ondata=t}return t.prototype.push=function(t,n){this.ondata||I(5),this.d&&I(4),this.ondata(nn(t),this.d=n||!1)},t}();function nn(t,r){if(r){for(var i=new n(t.length),e=0;e<t.length;++e)i[e]=t.charCodeAt(e);return i}if(Rt)return Rt.encode(t);var o=t.length,s=new n(t.length+(t.length>>1)),a=0,u=function(t){s[a++]=t};for(e=0;e<o;++e){if(a+5>s.length){var h=new n(a+8+(o-e<<1));h.set(s),s=h}var f=t.charCodeAt(e);f<128||r?u(f):f<2048?(u(192|f>>6),u(128|63&f)):f>55295&&f<57344?(u(240|(f=65536+(1047552&f)|1023&t.charCodeAt(++e))>>18),u(128|f>>12&63),u(128|f>>6&63),u(128|63&f)):(u(224|f>>12),u(128|f>>6&63),u(128|63&f))}return D(s,0,a)}function rn(t,n){if(n){for(var r="",i=0;i<t.length;i+=16384)r+=String.fromCharCode.apply(null,t.subarray(i,i+16384));return r}if(Wt)return Wt.decode(t);var e=$t(t),o=e.s;return(r=e.r).length&&I(8),o}_e.EncodeUTF8=tn;var en=function(t){return 1==t?3:t<6?2:9==t?1:0},on=function(t,n){return n+30+ht(t,n+26)+ht(t,n+28)},sn=function(t,n,r){var i=ht(t,n+28),e=ht(t,n+30),o=rn(t.subarray(n+46,n+46+i),!(2048&ht(t,n+8))),s=n+46+i,a=an(t,s,e,r,ft(t,n+20),ft(t,n+24),ft(t,n+42)),u=a[0],h=a[1],f=a[2];return[ht(t,n+10),u,h,o,s+e+ht(t,n+32),f]},an=function(t,n,r,i,e,o,s){var a=4294967295==e,u=4294967295==o,h=4294967295==s,f=n+r;if(i&&a+u+h){for(;n+4<f;n+=4+ht(t,n+2))if(1==ht(t,n))return[a?ct(t,n+4+8*u):e,u?ct(t,n+4):o,h?ct(t,n+4+8*(u+a)):s,1];i<2&&I(13)}return[e,o,s,0]},un=function(t){var n=0;if(t)for(var r in t){var i=t[r].length;i>65535&&I(9),n+=i+4}return n},hn=function(t,n,r,i,e,o,s,a){var u=i.length,h=r.extra,f=a&&a.length,c=un(h);lt(t,n,null!=s?33639248:67324752),n+=4,null!=s&&(t[n++]=20,t[n++]=r.os),t[n]=20,n+=2,t[n++]=r.flag<<1|(o<0&&8),t[n++]=e&&8,t[n++]=255&r.compression,t[n++]=r.compression>>8;var l=new Date(null==r.mtime?Date.now():r.mtime),p=l.getFullYear()-1980;if((p<0||p>119)&&I(10),lt(t,n,p<<25|l.getMonth()+1<<21|l.getDate()<<16|l.getHours()<<11|l.getMinutes()<<5|l.getSeconds()>>1),n+=4,-1!=o&&(lt(t,n,r.crc),lt(t,n+4,o<0?-o-2:o),lt(t,n+8,r.size)),lt(t,n+12,u),lt(t,n+14,c),n+=16,null!=s&&(lt(t,n,f),lt(t,n+6,r.attrs),lt(t,n+10,s),n+=14),t.set(i,n),n+=u,c)for(var v in h){var d=h[v],g=d.length;lt(t,n,+v),lt(t,n+2,g),t.set(d,n+4),n+=4+g}return f&&(t.set(a,n),n+=f),n},fn=function(t,n,r,i,e){lt(t,n,101010256),lt(t,n+8,r),lt(t,n+10,r),lt(t,n+12,i),lt(t,n+16,e)},cn=function(){function t(t){this.filename=t,this.c=V(),this.size=0,this.compression=0}return t.prototype.process=function(t,n){this.ondata(null,t,n)},t.prototype.push=function(t,n){this.ondata||I(5),this.c.p(t),this.size+=t.length,n&&(this.crc=this.c.d()),this.process(t,n||!1)},t}();_e.ZipPassThrough=cn;var ln=function(){function t(t,n){var r=this;n||(n={}),cn.call(this,t),this.d=new wt(n,function(t,n){r.ondata(null,t,n)}),this.compression=8,this.flag=en(n.level)}return t.prototype.process=function(t,n){try{this.d.push(t,n)}catch(t){this.ondata(t,null,n)}},t.prototype.push=function(t,n){cn.prototype.push.call(this,t,n)},t}();_e.ZipDeflate=ln;var pn=function(){function t(t,n){var r=this;n||(n={}),cn.call(this,t),this.d=new xt(n,function(t,n,i){r.ondata(t,n,i)}),this.compression=8,this.flag=en(n.level),this.terminate=this.d.terminate}return t.prototype.process=function(t,n){this.d.push(t,n)},t.prototype.push=function(t,n){cn.prototype.push.call(this,t,n)},t}();_e.AsyncZipDeflate=pn;var vn=function(){function t(t){this.ondata=t,this.u=[],this.d=1}return t.prototype.add=function(t){var r=this;if(this.ondata||I(5),2&this.d)this.ondata(I(4+8*(1&this.d),0,1),null,!1);else{var i=nn(t.filename),e=i.length,o=t.comment,s=o&&nn(o),a=e!=t.filename.length||s&&o.length!=s.length,u=e+un(t.extra)+30;e>65535&&this.ondata(I(11,0,1),null,!1);var h=new n(u);hn(h,0,t,i,a,-1);var f=[h],c=function(){for(var t=0,n=f;t<n.length;t++)r.ondata(null,n[t],!1);f=[]},l=this.d;this.d=0;var p=this.u.length,v=K(t,{f:i,u:a,o:s,t:function(){t.terminate&&t.terminate()},r:function(){if(c(),l){var t=r.u[p+1];t?t.r():r.d=1}l=1}}),d=0;t.ondata=function(i,e,o){if(i)r.ondata(i,e,o),r.terminate();else if(d+=e.length,f.push(e),o){var s=new n(16);lt(s,0,134695760),lt(s,4,t.crc),lt(s,8,d),lt(s,12,t.size),f.push(s),v.c=d,v.b=u+d+16,v.crc=t.crc,v.size=t.size,l&&v.r(),l=1}else l&&c()},this.u.push(v)}},t.prototype.end=function(){var t=this;2&this.d?this.ondata(I(4+8*(1&this.d),0,1),null,!0):(this.d?this.e():this.u.push({r:function(){1&t.d&&(t.u.splice(-1,1),t.e())},t:function(){}}),this.d=3)},t.prototype.e=function(){for(var t=0,r=0,i=0,e=0,o=this.u;e<o.length;e++)i+=46+(h=o[e]).f.length+un(h.extra)+(h.o?h.o.length:0);for(var s=new n(i+22),a=0,u=this.u;a<u.length;a++){var h;hn(s,t,h=u[a],h.f,h.u,-h.c-2,r,h.o),t+=46+h.f.length+un(h.extra)+(h.o?h.o.length:0),r+=h.b}fn(s,t,this.u.length,i,r),this.ondata(null,s,!0),this.d=2},t.prototype.terminate=function(){for(var t=0,n=this.u;t<n.length;t++)n[t].t();this.d=2},t}();function dn(t,r,i){i||(i=r,r={}),"function"!=typeof i&&I(7);var e={};Qt(t,"",e,r);var o=Object.keys(e),s=o.length,a=0,u=0,h=s,f=Array(s),c=[],l=function(){for(var t=0;t<c.length;++t)c[t]()},p=function(t,n){xn(function(){i(t,n)})};xn(function(){p=i});var v=function(){var t=new n(u+22),r=a,i=u-a;u=0;for(var e=0;e<h;++e){var o=f[e];try{var s=o.c.length;hn(t,u,o,o.f,o.u,s);var c=30+o.f.length+un(o.extra),l=u+c;t.set(o.c,l),hn(t,a,o,o.f,o.u,s,u,o.m),a+=16+c+(o.m?o.m.length:0),u=l+s}catch(t){return p(t,null)}}fn(t,a,f.length,i,r),p(null,t)};s||v();for(var d=function(t){var n=o[t],r=e[n],i=r[0],h=r[1],d=V(),g=i.length;d.p(i);var y=nn(n),m=y.length,b=h.comment,w=b&&nn(b),x=w&&w.length,z=un(h.extra),k=0==h.level?0:8,M=function(r,i){if(r)l(),p(r,null);else{var e=i.length;f[t]=K(h,{size:g,crc:d.d(),c:i,f:y,m:w,u:m!=n.length||w&&b.length!=x,compression:k}),a+=30+m+z+e,u+=76+2*(m+z)+(x||0)+e,--s||v()}};if(m>65535&&M(I(11,0,1),null),k)if(g<16e4)try{M(null,kt(i,h))}catch(t){M(t,null)}else c.push(zt(i,h,M));else M(null,i)},g=0;g<h;++g)d(g);return l}function gn(t,r){r||(r={});var i={},e=[];Qt(t,"",i,r);var o=0,s=0;for(var a in i){var u=i[a],h=u[0],f=u[1],c=0==f.level?0:8,l=(M=nn(a)).length,p=f.comment,v=p&&nn(p),d=v&&v.length,g=un(f.extra);l>65535&&I(11);var y=c?kt(h,f):h,m=y.length,b=V();b.p(h),e.push(K(f,{size:h.length,crc:b.d(),c:y,f:M,m:v,u:l!=a.length||v&&p.length!=d,o:o,compression:c})),o+=30+l+g+m,s+=76+2*(l+g)+(d||0)+m}for(var w=new n(s+22),x=o,z=s-o,k=0;k<e.length;++k){var M;hn(w,(M=e[k]).o,M,M.f,M.u,M.c.length);var S=30+M.f.length+un(M.extra);w.set(M.c,M.o+S),hn(w,o,M,M.f,M.u,M.c.length,M.o,M.m),o+=16+S+(M.m?M.m.length:0)}return fn(w,o,e.length,z,x),w}_e.Zip=vn;var yn=function(){function t(){}return t.prototype.push=function(t,n){this.ondata(null,t,n)},t.compression=0,t}();_e.UnzipPassThrough=yn;var mn=function(){function t(){var t=this;this.i=new Mt(function(n,r){t.ondata(null,n,r)})}return t.prototype.push=function(t,n){try{this.i.push(t,n)}catch(t){this.ondata(t,null,n)}},t.compression=8,t}();_e.UnzipInflate=mn;var bn=function(){function t(t,n){var r=this;n<32e4?this.i=new Mt(function(t,n){r.ondata(null,t,n)}):(this.i=new St(function(t,n,i){r.ondata(t,n,i)}),this.terminate=this.i.terminate)}return t.prototype.push=function(t,n){this.i.terminate&&(t=D(t,0)),this.i.push(t,n)},t.compression=8,t}();_e.AsyncUnzipInflate=bn;var wn=function(){function t(t){this.onfile=t,this.k=[],this.o={0:yn},this.p=j}return t.prototype.push=function(t,r){var i=this;if(this.onfile||I(5),this.p||I(4),this.c>0){var e=Math.min(this.c,t.length),o=t.subarray(0,e);if(this.c-=e,this.d?this.d.push(o,!this.c):this.k[0].push(o),(t=t.subarray(e)).length)return this.push(t,r)}else{var s=0,a=0,u=void 0,h=void 0;this.p.length?t.length?((h=new n(this.p.length+t.length)).set(this.p),h.set(t,this.p.length)):h=this.p:h=t;for(var f=h.length,c=this.c,l=c&&this.d,p=function(){var t=ft(h,a);if(67324752==t){s=1,u=a,v.d=null,v.c=0;var n=ht(h,a+6),r=ht(h,a+8),e=2048&n,o=8&n,l=ht(h,a+26),p=ht(h,a+28);if(f>a+30+l+p){var d=[];v.k.unshift(d),s=2;var g,y=ft(h,a+18),m=ft(h,a+22),b=rn(h.subarray(a+30,a+=30+l),!e),w=an(h,a,p,2,y,m,0),x=w[0],z=w[1];o&&(x=-1-w[3]),a+=p,v.c=x;var k={name:b,compression:r,start:function(){if(k.ondata||I(5),x){var t=i.o[r];t||k.ondata(I(14,"unknown compression type "+r,1),null,!1),(g=x<0?new t(b):new t(b,x,z)).ondata=function(t,n,r){k.ondata(t,n,r)};for(var n=0,e=d;n<e.length;n++)g.push(e[n],!1);i.k[0]==d&&i.c?i.d=g:g.push(j,!0)}else k.ondata(null,j,!0)},terminate:function(){g&&g.terminate&&g.terminate()}};x>=0&&(k.size=x,k.originalSize=z),v.onfile(k)}return"break"}if(c){if(134695760==t)return u=a+=12+(-2==c&&8),s=3,v.c=0,"break";if(33639248==t)return u=a-=4,s=3,v.c=0,"break"}},v=this;a<f-4&&"break"!==p();++a);if(this.p=j,c<0){var d=h.subarray(0,s?u-12-(-2==c&&8)-(134695760==ft(h,u-16)&&4):a);l?l.push(d,!!s):this.k[+(2==s)].push(d)}if(2&s)return this.push(h.subarray(a),r);this.p=h.subarray(a)}r&&(this.c&&I(13),this.p=null)},t.prototype.register=function(t){this.o[t.compression]=t},t}();_e.Unzip=wn;var xn="function"==typeof queueMicrotask?queueMicrotask:"function"==typeof setTimeout?setTimeout:function(t){t()};function zn(t,r,i){i||(i=r,r={}),"function"!=typeof i&&I(7);var e=[],o=function(){for(var t=0;t<e.length;++t)e[t]()},s={},a=function(t,n){xn(function(){i(t,n)})};xn(function(){a=i});for(var u=t.length-22;101010256!=ft(t,u);--u)if(!u||t.length-u>65558)return a(I(13,0,1),null),o;var h=ht(t,u+8);if(h){var f=h,c=ft(t,u+16),l=117853008==ft(t,u-20);if(l){var p=ft(t,u-12);(l=101075792==ft(t,p))&&(f=h=ft(t,p+32),c=ft(t,p+48))}for(var v=r&&r.filter,d=function(r){var i=sn(t,c,l),u=i[0],f=i[1],p=i[2],d=i[3],g=i[4],y=on(t,i[5]);c=g;var m=function(t,n){t?(o(),a(t,null)):(n&&(s[d]=n),--h||a(null,s))};if(!v||v({name:d,size:f,originalSize:p,compression:u}))if(u)if(8==u){var b=t.subarray(y,y+f);if(p<524288||f>.8*p)try{m(null,Tt(b,{out:new n(p)}))}catch(t){m(t,null)}else e.push(At(b,{size:p},m))}else m(I(14,"unknown compression type "+u,1),null);else m(null,D(t,y,y+f));else m(null,null)},g=0;g<f;++g)d()}else a(null,{});return o}function kn(t,r){for(var i={},e=t.length-22;101010256!=ft(t,e);--e)(!e||t.length-e>65558)&&I(13);var o=ht(t,e+8);if(!o)return{};var s=ft(t,e+16),a=117853008==ft(t,e-20);if(a){var u=ft(t,e-12);(a=101075792==ft(t,u))&&(o=ft(t,u+32),s=ft(t,u+48))}for(var h=r&&r.filter,f=0;f<o;++f){var c=sn(t,s,a),l=c[0],p=c[1],v=c[2],d=c[3],g=c[4],y=on(t,c[5]);s=g,h&&!h({name:d,size:p,originalSize:v,compression:l})||(l?8==l?i[d]=Tt(t.subarray(y,y+p),{out:new n(v)}):I(14,"unknown compression type "+l):i[d]=D(t,y,y+p))}return i}return _e});

const ROOT_ID = "gemini-web-exporter-root";
const HISTORY_PAGE_SIZE = 50;
const PREFERENCE_KEYS = Object.freeze({
  collapsed: "ui.collapsed",
  includeMetadata: "export.includeMetadata",
  includeOutline: "export.includeOutline",
  downloadStrategy: "export.downloadStrategy",
  logLevel: "debug.logLevel",
});

(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

  const log = Logger.create({
    tag: "[Gemini Exporter]",
    level: "debug",
    storage: PreferenceStorage,
    storageKey: PREFERENCE_KEYS.logLevel,
  });

  // Expose for console access: log.setLevel("none"), log.setLevel("debug"), etc.
  globalThis.GeminiExporter = { log };

  function isConversationPage() {
    return Core.conversationIdFromPath(location.pathname) !== null;
  }

  function getGeminiConfig() {
    const config = pageWindow.WIZ_global_data;
    const required = ["cfb2h", "FdrFJe", "SNlM0e"];

    if (
      !config ||
      required.some(
        (key) => typeof config[key] !== "string" || config[key].length === 0,
      )
    ) {
      throw new Error(
        "Gemini's page configuration is not ready. Reload the conversation and try again.",
      );
    }

    return config;
  }

  function createGeminiAdapter(conversationId) {
    return {
      pageWindow,

      getConfig() {
        return getGeminiConfig();
      },

      buildQuery(config, cursor) {
        const query = new URLSearchParams({
          rpcids: Core.HISTORY_RPC_ID,
          "source-path": location.pathname,
          bl: config.cfb2h,
          "f.sid": config.FdrFJe,
          hl: (document.documentElement.lang || "en").split("-")[0],
          _reqid: Utils.makeRequestId(),
          rt: "c",
        });
        const pageId = new URLSearchParams(location.search).get("pageId");
        if (pageId) {
          query.set("pageId", pageId);
        }
        return query;
      },

      buildBody(config, cursor) {
        const rpcArguments = [
          conversationId,
          HISTORY_PAGE_SIZE,
          cursor,
          1,
          [0],
          [4],
          null,
          1,
        ];
        const rpcCall = [
          Core.HISTORY_RPC_ID,
          JSON.stringify(rpcArguments),
          null,
          "generic",
        ];
        const body = new URLSearchParams({
          "f.req": JSON.stringify([[rpcCall]]),
          at: config.SNlM0e,
        });
        return body.toString();
      },

      buildEndpoint(query) {
        const endpointPath = Core.accountScopedPath(
          location.pathname,
          "/_/BardChatUi/data/batchexecute",
        );
        const endpoint = new URL(endpointPath, location.origin);
        endpoint.search = query.toString();
        return endpoint.toString();
      },

      buildFetchOptions(body) {
        return {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1",
          },
          body,
        };
      },
    };
  }

  async function fetchHistoryPage(conversationId, cursor) {
    const adapter = createGeminiAdapter(conversationId);
    return HistoryFetcher.fetchPage(adapter, cursor);
  }

  // ── UI assembly + export logic ─────────────────────────────────────────

  const preferences = {
    collapsed: PreferenceStorage.readBoolean(PREFERENCE_KEYS.collapsed, false),
    includeMetadata: PreferenceStorage.readBoolean(
      PREFERENCE_KEYS.includeMetadata,
      true,
    ),
    includeOutline: PreferenceStorage.readBoolean(
      PREFERENCE_KEYS.includeOutline,
      true,
    ),
    downloadStrategy: PreferenceStorage.readString(
      PREFERENCE_KEYS.downloadStrategy,
      "link-only",
    ),
  };

  const { host, shadow } = Ui.createShadowRoot(ROOT_ID, ":host {\r\n  all: initial;\r\n  position: fixed;\r\n  right: 22px;\r\n  bottom: 22px;\r\n  z-index: 2147483647;\r\n  font-family: \"Google Sans\", system-ui, -apple-system, sans-serif;\r\n}\r\n\r\n.stack {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: flex-end;\r\n  gap: 10px;\r\n}\r\n\r\nbutton,\r\ninput {\r\n  font: inherit;\r\n}\r\n\r\nbutton {\r\n  appearance: none;\r\n  border: 0;\r\n  cursor: pointer;\r\n}\r\n\r\n.control {\r\n  display: flex;\r\n  overflow: hidden;\r\n  border: 1px solid rgba(255, 255, 255, 0.22);\r\n  border-radius: 999px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.export-button,\r\n.menu-button {\r\n  display: inline-flex;\r\n  min-height: 42px;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: transparent;\r\n  color: inherit;\r\n}\r\n\r\n.export-button {\r\n  gap: 8px;\r\n  min-width: 142px;\r\n  padding: 0 16px;\r\n  font-weight: 650;\r\n  white-space: nowrap;\r\n  transition: min-width 120ms ease, padding 120ms ease;\r\n}\r\n\r\n.export-button--secondary {\r\n  border-left: 1px solid rgba(255, 255, 255, 0.16);\r\n  min-width: 120px;\r\n}\r\n\r\n.download-icon {\r\n  font-size: 18px;\r\n  line-height: 1;\r\n}\r\n\r\n.menu-button {\r\n  width: 38px;\r\n  border-left: 1px solid rgba(255, 255, 255, 0.16);\r\n  font-size: 21px;\r\n  line-height: 1;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-button {\r\n  min-width: 42px;\r\n  padding: 0 12px;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-label {\r\n  display: none;\r\n}\r\n\r\n.export-button:hover,\r\n.export-button--secondary:hover,\r\n.menu-button:hover {\r\n  background: #303030;\r\n}\r\n\r\nbutton:focus-visible {\r\n  outline: 3px solid #a8c7fa;\r\n  outline-offset: -3px;\r\n}\r\n\r\nbutton:disabled {\r\n  cursor: progress;\r\n  opacity: 0.72;\r\n}\r\n\r\n.panel {\r\n  box-sizing: border-box;\r\n  width: min(270px, calc(100vw - 32px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 14px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  padding: 14px;\r\n  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.34);\r\n}\r\n\r\n.panel[hidden] {\r\n  display: none;\r\n}\r\n\r\n.panel-heading {\r\n  margin: 0 0 10px;\r\n  font-size: 13px;\r\n  font-weight: 700;\r\n  letter-spacing: 0.01em;\r\n}\r\n\r\n.option {\r\n  display: grid;\r\n  grid-template-columns: 20px minmax(0, 1fr);\r\n  gap: 9px;\r\n  align-items: start;\r\n  border-radius: 9px;\r\n  cursor: pointer;\r\n  padding: 8px 6px;\r\n}\r\n\r\n.option:hover {\r\n  background: rgba(255, 255, 255, 0.07);\r\n}\r\n\r\n.option input {\r\n  width: 16px;\r\n  height: 16px;\r\n  margin: 1px 0 0;\r\n  accent-color: #a8c7fa;\r\n}\r\n\r\n.option-select {\r\n  grid-column: 1 / -1;\r\n  width: 100%;\r\n  margin-bottom: 4px;\r\n  border: 1px solid rgba(255, 255, 255, 0.22);\r\n  border-radius: 6px;\r\n  background: #2a2a2a;\r\n  color: #fff;\r\n  font: inherit;\r\n  font-size: 12px;\r\n  padding: 5px 6px;\r\n  cursor: pointer;\r\n  accent-color: #a8c7fa;\r\n}\r\n\r\n.option-select:focus-visible {\r\n  outline: 3px solid #a8c7fa;\r\n  outline-offset: -3px;\r\n}\r\n\r\n.option-copy {\r\n  display: flex;\r\n  min-width: 0;\r\n  flex-direction: column;\r\n  gap: 3px;\r\n}\r\n\r\n.option-label {\r\n  font-size: 13px;\r\n  font-weight: 650;\r\n  line-height: 1.2;\r\n}\r\n\r\n.option-description {\r\n  color: #c7c7c7;\r\n  font-size: 11px;\r\n  font-weight: 450;\r\n  line-height: 1.35;\r\n}\r\n\r\n.compact-toggle {\r\n  width: 100%;\r\n  margin-top: 10px;\r\n  border-top: 1px solid rgba(255, 255, 255, 0.14);\r\n  background: transparent;\r\n  color: #a8c7fa;\r\n  padding: 12px 6px 3px;\r\n  text-align: left;\r\n  font-size: 12px;\r\n  font-weight: 650;\r\n}\r\n\r\n.compact-toggle:hover {\r\n  color: #d3e3fd;\r\n}\r\n\r\n.toast {\r\n  box-sizing: border-box;\r\n  display: none;\r\n  max-width: min(420px, calc(100vw - 44px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 12px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  font: 500 13px/1.45 system-ui, -apple-system, sans-serif;\r\n  padding: 11px 13px;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.toast[data-kind=\"error\"] {\r\n  background: #8c1d18;\r\n}\r\n\r\n@media (max-width: 520px) {\r\n  :host {\r\n    right: 12px;\r\n    bottom: 12px;\r\n  }\r\n}");
  const toast = Ui.createToast();
  const optionsPanel = Ui.createOptionsPanel({
    heading: "Export options",
    ariaLabel: "Export options",
    options: [
      {
        label: "Conversation outline",
        description: "Linked turn list with short prompt previews",
        checked: preferences.includeOutline,
        onChange(value) {
          preferences.includeOutline = value;
          PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeOutline, value);
        },
      },
      {
        label: "Export metadata",
        description: "Source, export details, validation and turn IDs",
        checked: preferences.includeMetadata,
        onChange(value) {
          preferences.includeMetadata = value;
          PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeMetadata, value);
        },
      },
    ],
  });
  const strategyOption = Ui.createSelectOption({
    label: "Generated files",
    description: "How to handle generated file downloads",
    value: preferences.downloadStrategy,
    choices: DownloadStrategies.definitions.map((d) => ({
      value: d.id,
      label: d.label,
    })),
    onChange(value) {
      preferences.downloadStrategy = value;
      PreferenceStorage.writeString(PREFERENCE_KEYS.downloadStrategy, value);
    },
  });
  optionsPanel.panel.append(strategyOption.option);
  const exportControl = Ui.createExportControl({
    buttons: [
      { label: "Export Markdown", ariaLabel: "Export Markdown", icon: "↓" },
      { label: "Export JSON", ariaLabel: "Export JSON", icon: "{ }" },
    ],
    menuAriaLabel: "Export options",
  });

  const stack = Ui.createStack("stack", toast.element, optionsPanel.panel, exportControl.control);
  shadow.append(stack);

  function setPanelOpen(open) {
    log.debug("setPanelOpen", open);
    optionsPanel.setOpen(open);
    exportControl.setMenuExpanded(open);
  }

  function setCollapsed(collapsed, persist = true) {
    log.debug("setCollapsed", { collapsed, persist });
    preferences.collapsed = collapsed;
    exportControl.setCollapsed(collapsed, { titles: ["Export Markdown", "Export JSON"] });
    optionsPanel.setCompactToggleLabel(
      collapsed ? "Use expanded control" : "Use compact control",
    );
    if (persist) {
      PreferenceStorage.writeBoolean(PREFERENCE_KEYS.collapsed, collapsed);
    }
  }

  const EXPORT_FORMATS = [
    { id: "markdown", label: "Export Markdown", icon: "↓", extension: "md" },
    { id: "json", label: "Export JSON", icon: "{ }", extension: "json" },
  ];

  async function exportCurrentConversation(formatIndex) {
    const fmt = EXPORT_FORMATS[formatIndex];
    if (!fmt) return;

    const conversationId = Core.conversationIdFromPath(location.pathname);
    if (!conversationId) {
      toast.show("Open a Gemini conversation before exporting.", "error");
      return;
    }

    setPanelOpen(false);
    exportControl.setBusy(true, formatIndex, {
      icon: "…",
      label: "Exporting…",
      ariaLabel: "Exporting",
    });

    try {
      const history = await Core.collectHistoryPages((cursor) =>
        fetchHistoryPage(conversationId, cursor),
      );
      // Dump the first raw turn structure at debug level so we can inspect
      // what fields Gemini returns (e.g. thinking/reasoning data).
      log.debug("raw turn structure (first turn)", history.rawTurnsNewestFirst[0]);
      const turns = Core.historyToChronologicalTurns(
        history.rawTurnsNewestFirst,
      );
      const diagnostics = Core.validateConversation(turns);
      const title = Core.cleanDocumentTitle(document.title);
      const exportedAt = new Date().toISOString();

      let content;
      let filename;
      if (fmt.id === "json") {
        content = Core.renderJson({
          title,
          sourceUrl: location.href,
          conversationId,
          exportedAt,
          turns,
          diagnostics,
          includeMetadata: preferences.includeMetadata,
        });
        filename = Core.safeFilename(title, fmt.extension);
      } else {
        content = Core.renderMarkdown({
          title,
          sourceUrl: location.href,
          conversationId,
          exportedAt,
          turns,
          diagnostics,
          includeMetadata: preferences.includeMetadata,
          includeOutline: preferences.includeOutline,
        });
        filename = Core.safeFilename(title, fmt.extension);
      }

      const strategyResult = await DownloadStrategies.execute(
        preferences.downloadStrategy,
        {
          turns,
          title,
          conversationId,
          sourceUrl: location.href,
          exportedAt,
          diagnostics,
          preferences,
          pageWindow,
          Core,
          Utils,
          fflate: typeof fflate !== "undefined" ? fflate : null,
        },
        fmt.id,
      );

      if (strategyResult.mode === "text") {
        Utils.downloadTextFile(content, filename);
      }

      log.info(`${fmt.label} complete`, {
        filename: strategyResult.filename || filename,
        format: fmt.id,
        strategy: preferences.downloadStrategy,
        pages: history.pages.length,
        ...diagnostics,
      });
      toast.show(
        `Exported ${turns.length} turns from ${history.pages.length} page${
          history.pages.length === 1 ? "" : "s"
        }. Validation: ${diagnostics.fingerprint}.`,
      );
    } catch (error) {
      log.error("Export failed", error);
      toast.show(
        `Export stopped: ${error instanceof Error ? error.message : String(error)}`,
        "error",
        15_000,
      );
    } finally {
      exportControl.setBusy(false, formatIndex, {
        icon: fmt.icon,
        label: fmt.label,
        ariaLabel: fmt.label,
      });
    }
  }

  exportControl.buttons[0].addEventListener("click", () => {
    log.debug("markdown export button clicked");
    exportCurrentConversation(0);
  });
  exportControl.buttons[1].addEventListener("click", () => {
    log.debug("json export button clicked");
    exportCurrentConversation(1);
  });
  exportControl.menuButton.addEventListener("click", () => {
    log.debug("menu button clicked, panel.hidden =", optionsPanel.panel.hidden);
    setPanelOpen(optionsPanel.panel.hidden);
  });
  optionsPanel.compactToggle.addEventListener("click", () => {
    log.debug("compact toggle clicked, collapsed =", preferences.collapsed);
    setCollapsed(!preferences.collapsed);
    setPanelOpen(false);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().includes(host)) {
        if (!optionsPanel.panel.hidden) {
          log.debug("outside pointerdown, closing panel");
        }
        setPanelOpen(false);
      }
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      log.debug("Escape pressed, closing panel");
      setPanelOpen(false);
    }
  });

  setCollapsed(preferences.collapsed, false);
  document.documentElement.append(host);

  function syncRoute() {
    host.style.display = isConversationPage() ? "block" : "none";
  }

  syncRoute();
  setInterval(syncRoute, 1_000);
})();
