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

    function extractTurn(rawTurn, sourceIndex) {
      invariant(
        Array.isArray(rawTurn),
        `Gemini turn ${sourceIndex + 1} was not an array.`,
      );

      const userMarkdown = rawTurn?.[2]?.[0]?.[0];
      const candidate = extractSelectedCandidate(rawTurn);
      const assistantMarkdown = candidate?.[1]?.[0];

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
        sourceIndex,
      };
    }

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

    function renderMarkdown({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
    }) {
      invariant(Array.isArray(turns) && turns.length > 0, "No turns to render.");

      const safeTitle = normalizeBlock(title || "Gemini conversation").replace(
        /\n+/g,
        " ",
      );
      const lines = [
        `# ${safeTitle}`,
        "",
        `> Source: [Google Gemini](${escapeMarkdownLinkDestination(sourceUrl)})`,
        `> Exported: ${exportedAt}`,
        `> Conversation: ${conversationId}`,
        `> Turns: ${turns.length}`,
        `> Validation fingerprint: \`${diagnostics.fingerprint}\``,
        "",
      ];

      turns.forEach((turn, index) => {
        if (index > 0) {
          lines.push("---", "");
        }

        const commentParts = [
          `turn=${index + 1}`,
          turn.responseId ? `response=${turn.responseId}` : null,
          turn.candidateId ? `candidate=${turn.candidateId}` : null,
          turn.timestamp ? `timestamp=${turn.timestamp}` : null,
        ].filter(Boolean);

        lines.push(
          `<!-- gemini-export: ${commentParts.join(" ")} -->`,
          "",
          "## User",
          "",
          normalizeBlock(turn.userMarkdown),
          "",
          "## Gemini",
          "",
          normalizeBlock(turn.assistantMarkdown),
          "",
        );
      });

      return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
    }

    function conversationIdFromPath(pathname) {
      const parts = String(pathname).split("/").filter(Boolean);
      if (parts[0] !== "app" || !parts[1]) {
        return null;
      }

      return parts[1].startsWith("c_") ? parts[1] : `c_${parts[1]}`;
    }

    function cleanDocumentTitle(documentTitle) {
      const withoutProduct = String(documentTitle || "")
        .replace(/\s*[-–—]\s*Google Gemini\s*$/i, "")
        .trim();

      return withoutProduct || "Gemini conversation";
    }

    function safeFilename(title) {
      const cleaned = String(title || "Gemini conversation")
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[.\s-]+$/g, "")
        .trim()
        .slice(0, 120);

      return `${cleaned || "Gemini conversation"}.md`;
    }

    return Object.freeze({
      HISTORY_RPC_ID,
      cleanDocumentTitle,
      collectHistoryPages,
      conversationIdFromPath,
      extractTurn,
      fnv1a,
      historyToChronologicalTurns,
      parseBatchexecuteResponse,
      parseHistoryPage,
      renderMarkdown,
      safeFilename,
      validateConversation,
    });
  },
);
