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
     * @typedef {Object} ExtensionResult
     * @property {number} index         - Original position in candidate[12].
     * @property {*} raw                - Raw, opaque extension/tool payload.
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
     * @property {ExtensionResult[]} [extensions]- Extension/tool results.
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
     * Extract extension/tool results from a candidate.
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
          // Extension entries are opaque; preserve their raw JSON form.
          return { index: i, raw: ext };
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

        lines.push(normalizeBlock(turn.assistantMarkdown), "");

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
