// ==UserScript==
// @name         Gemini Conversation Exporter
// @namespace    local.gemini-web-exporter
// @version      0.1.8
// @description  Export the current Gemini conversation as validated Markdown using Gemini's own paginated history data.
// @author       dikelps
// @license      MIT
// @homepageURL  https://github.com/dikelps/gemini-conversation-exporter
// @supportURL   https://github.com/dikelps/gemini-conversation-exporter/issues
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
            turn.responseId ? `response=${turn.responseId}` : null,
            turn.candidateId ? `candidate=${turn.candidateId}` : null,
            turn.timestamp ? `timestamp=${turn.timestamp}` : null,
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

        if (includeOutline) {
          lines.push("### Gemini", "");
        } else {
          lines.push("## Gemini", "");
        }

        lines.push(normalizeBlock(turn.assistantMarkdown), "");
      });

      return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
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
      safeFilename,
      turnPreview,
      validateConversation,
    });
  },
);

(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const ROOT_ID = "gemini-web-exporter-root";
  const HISTORY_PAGE_SIZE = 50;
  const PREFERENCE_KEYS = Object.freeze({
    collapsed: "ui.collapsed",
    includeMetadata: "export.includeMetadata",
    includeOutline: "export.includeOutline",
  });
  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

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

  function makeRequestId() {
    return String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  }

  function cloneForPageRealm(value) {
    return typeof cloneInto === "function"
      ? cloneInto(value, pageWindow)
      : value;
  }

  function readBooleanPreference(key, fallback) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return typeof value === "boolean" ? value : fallback;
    } catch (error) {
      console.warn("[Gemini Exporter] Could not read preference", key, error);
      return fallback;
    }
  }

  function writeBooleanPreference(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, Boolean(value));
    } catch (error) {
      console.warn("[Gemini Exporter] Could not save preference", key, error);
    }
  }

  async function fetchHistoryPage(conversationId, cursor) {
    const config = getGeminiConfig();
    const query = new URLSearchParams({
      rpcids: Core.HISTORY_RPC_ID,
      "source-path": location.pathname,
      bl: config.cfb2h,
      "f.sid": config.FdrFJe,
      hl: (document.documentElement.lang || "en").split("-")[0],
      _reqid: makeRequestId(),
      rt: "c",
    });
    const pageId = new URLSearchParams(location.search).get("pageId");
    if (pageId) {
      query.set("pageId", pageId);
    }
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
    const endpointPath = Core.accountScopedPath(
      location.pathname,
      "/_/BardChatUi/data/batchexecute",
    );
    const endpoint = new URL(endpointPath, location.origin);
    endpoint.search = query.toString();

    const requestOptions = cloneForPageRealm({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: body.toString(),
    });
    const response = await pageWindow.fetch(
      endpoint.toString(),
      requestOptions,
    );
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Gemini history request failed with HTTP ${response.status}.`,
      );
    }

    return text;
  }

  function downloadMarkdown(markdown, filename) {
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  function createUi() {
    const preferences = {
      collapsed: readBooleanPreference(PREFERENCE_KEYS.collapsed, false),
      includeMetadata: readBooleanPreference(
        PREFERENCE_KEYS.includeMetadata,
        true,
      ),
      includeOutline: readBooleanPreference(
        PREFERENCE_KEYS.includeOutline,
        true,
      ),
    };
    const host = document.createElement("div");
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host {\r\n  all: initial;\r\n  position: fixed;\r\n  right: 22px;\r\n  bottom: 22px;\r\n  z-index: 2147483647;\r\n  font-family: \"Google Sans\", system-ui, -apple-system, sans-serif;\r\n}\r\n\r\n.stack {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: flex-end;\r\n  gap: 10px;\r\n}\r\n\r\nbutton,\r\ninput {\r\n  font: inherit;\r\n}\r\n\r\nbutton {\r\n  appearance: none;\r\n  border: 0;\r\n  cursor: pointer;\r\n}\r\n\r\n.control {\r\n  display: flex;\r\n  overflow: hidden;\r\n  border: 1px solid rgba(255, 255, 255, 0.22);\r\n  border-radius: 999px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.export-button,\r\n.menu-button {\r\n  display: inline-flex;\r\n  min-height: 42px;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: transparent;\r\n  color: inherit;\r\n}\r\n\r\n.export-button {\r\n  gap: 8px;\r\n  min-width: 142px;\r\n  padding: 0 16px;\r\n  font-weight: 650;\r\n  white-space: nowrap;\r\n  transition: min-width 120ms ease, padding 120ms ease;\r\n}\r\n\r\n.download-icon {\r\n  font-size: 18px;\r\n  line-height: 1;\r\n}\r\n\r\n.menu-button {\r\n  width: 38px;\r\n  border-left: 1px solid rgba(255, 255, 255, 0.16);\r\n  font-size: 21px;\r\n  line-height: 1;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-button {\r\n  min-width: 42px;\r\n  padding: 0 12px;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-label {\r\n  display: none;\r\n}\r\n\r\n.export-button:hover,\r\n.menu-button:hover {\r\n  background: #303030;\r\n}\r\n\r\nbutton:focus-visible {\r\n  outline: 3px solid #a8c7fa;\r\n  outline-offset: -3px;\r\n}\r\n\r\nbutton:disabled {\r\n  cursor: progress;\r\n  opacity: 0.72;\r\n}\r\n\r\n.panel {\r\n  box-sizing: border-box;\r\n  width: min(270px, calc(100vw - 32px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 14px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  padding: 14px;\r\n  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.34);\r\n}\r\n\r\n.panel[hidden] {\r\n  display: none;\r\n}\r\n\r\n.panel-heading {\r\n  margin: 0 0 10px;\r\n  font-size: 13px;\r\n  font-weight: 700;\r\n  letter-spacing: 0.01em;\r\n}\r\n\r\n.option {\r\n  display: grid;\r\n  grid-template-columns: 20px minmax(0, 1fr);\r\n  gap: 9px;\r\n  align-items: start;\r\n  border-radius: 9px;\r\n  cursor: pointer;\r\n  padding: 8px 6px;\r\n}\r\n\r\n.option:hover {\r\n  background: rgba(255, 255, 255, 0.07);\r\n}\r\n\r\n.option input {\r\n  width: 16px;\r\n  height: 16px;\r\n  margin: 1px 0 0;\r\n  accent-color: #a8c7fa;\r\n}\r\n\r\n.option-copy {\r\n  display: flex;\r\n  min-width: 0;\r\n  flex-direction: column;\r\n  gap: 3px;\r\n}\r\n\r\n.option-label {\r\n  font-size: 13px;\r\n  font-weight: 650;\r\n  line-height: 1.2;\r\n}\r\n\r\n.option-description {\r\n  color: #c7c7c7;\r\n  font-size: 11px;\r\n  font-weight: 450;\r\n  line-height: 1.35;\r\n}\r\n\r\n.compact-toggle {\r\n  width: 100%;\r\n  margin-top: 10px;\r\n  border-top: 1px solid rgba(255, 255, 255, 0.14);\r\n  background: transparent;\r\n  color: #a8c7fa;\r\n  padding: 12px 6px 3px;\r\n  text-align: left;\r\n  font-size: 12px;\r\n  font-weight: 650;\r\n}\r\n\r\n.compact-toggle:hover {\r\n  color: #d3e3fd;\r\n}\r\n\r\n.toast {\r\n  box-sizing: border-box;\r\n  display: none;\r\n  max-width: min(420px, calc(100vw - 44px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 12px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  font: 500 13px/1.45 system-ui, -apple-system, sans-serif;\r\n  padding: 11px 13px;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.toast[data-kind=\"error\"] {\r\n  background: #8c1d18;\r\n}\r\n\r\n@media (max-width: 520px) {\r\n  :host {\r\n    right: 12px;\r\n    bottom: 12px;\r\n  }\r\n}";

    const stack = document.createElement("div");
    stack.className = "stack";

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Export options");

    const panelHeading = document.createElement("p");
    panelHeading.className = "panel-heading";
    panelHeading.textContent = "Export options";

    function createOption({
      label,
      description,
      checked,
      onChange,
    }) {
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
    }

    const outlineOption = createOption({
      label: "Conversation outline",
      description: "Linked turn list with short prompt previews",
      checked: preferences.includeOutline,
      onChange(value) {
        preferences.includeOutline = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeOutline, value);
      },
    });
    const metadataOption = createOption({
      label: "Export metadata",
      description: "Source, export details, validation and turn IDs",
      checked: preferences.includeMetadata,
      onChange(value) {
        preferences.includeMetadata = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeMetadata, value);
      },
    });

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "compact-toggle";

    panel.append(
      panelHeading,
      outlineOption.option,
      metadataOption.option,
      compactToggle,
    );

    const control = document.createElement("div");
    control.className = "control";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "export-button";
    exportButton.setAttribute("aria-label", "Export Markdown");

    const downloadIcon = document.createElement("span");
    downloadIcon.className = "download-icon";
    downloadIcon.setAttribute("aria-hidden", "true");
    downloadIcon.textContent = "↓";

    const exportLabel = document.createElement("span");
    exportLabel.className = "export-label";
    exportLabel.textContent = "Export Markdown";

    exportButton.append(downloadIcon, exportLabel);

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "menu-button";
    menuButton.textContent = "⋮";
    menuButton.setAttribute("aria-label", "Export options");
    menuButton.setAttribute("aria-haspopup", "dialog");
    menuButton.setAttribute("aria-expanded", "false");

    control.append(exportButton, menuButton);
    stack.append(toast, panel, control);
    shadow.append(style, stack);
    let toastTimer = null;

    function showToast(message, kind = "success", duration = 8_000) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.dataset.kind = kind;
      toast.style.display = "block";
      toastTimer = setTimeout(() => {
        toast.style.display = "none";
      }, duration);
    }

    function setPanelOpen(open) {
      panel.hidden = !open;
      menuButton.setAttribute("aria-expanded", String(open));
    }

    function setCollapsed(collapsed, persist = true) {
      preferences.collapsed = collapsed;
      control.dataset.collapsed = String(collapsed);
      exportButton.title = collapsed ? "Export Markdown" : "";
      compactToggle.textContent = collapsed
        ? "Use expanded control"
        : "Use compact control";

      if (persist) {
        writeBooleanPreference(PREFERENCE_KEYS.collapsed, collapsed);
      }
    }

    async function exportCurrentConversation() {
      const conversationId = Core.conversationIdFromPath(location.pathname);
      if (!conversationId) {
        showToast("Open a Gemini conversation before exporting.", "error");
        return;
      }

      setPanelOpen(false);
      exportButton.disabled = true;
      exportButton.setAttribute("aria-label", "Exporting");
      downloadIcon.textContent = "…";
      exportLabel.textContent = "Exporting…";

      try {
        const history = await Core.collectHistoryPages((cursor) =>
          fetchHistoryPage(conversationId, cursor),
        );
        const turns = Core.historyToChronologicalTurns(
          history.rawTurnsNewestFirst,
        );
        const diagnostics = Core.validateConversation(turns);
        const title = Core.cleanDocumentTitle(document.title);
        const exportedAt = new Date().toISOString();
        const markdown = Core.renderMarkdown({
          title,
          sourceUrl: location.href,
          conversationId,
          exportedAt,
          turns,
          diagnostics,
          includeMetadata: preferences.includeMetadata,
          includeOutline: preferences.includeOutline,
        });
        const filename = Core.safeFilename(title);

        downloadMarkdown(markdown, filename);
        console.info("[Gemini Exporter] Export complete", {
          filename,
          pages: history.pages.length,
          ...diagnostics,
        });
        showToast(
          `Exported ${turns.length} turns from ${history.pages.length} page${
            history.pages.length === 1 ? "" : "s"
          }. Validation: ${diagnostics.fingerprint}.`,
        );
      } catch (error) {
        console.error("[Gemini Exporter] Export failed", error);
        showToast(
          `Export stopped: ${error instanceof Error ? error.message : String(error)}`,
          "error",
          15_000,
        );
      } finally {
        exportButton.disabled = false;
        exportButton.setAttribute("aria-label", "Export Markdown");
        downloadIcon.textContent = "↓";
        exportLabel.textContent = "Export Markdown";
      }
    }

    exportButton.addEventListener("click", exportCurrentConversation);
    menuButton.addEventListener("click", () => {
      setPanelOpen(panel.hidden);
    });
    compactToggle.addEventListener("click", () => {
      setCollapsed(!preferences.collapsed);
      setPanelOpen(false);
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(host)) {
          setPanelOpen(false);
        }
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setPanelOpen(false);
      }
    });

    setCollapsed(preferences.collapsed, false);
    return { host, exportButton };
  }

  const ui = createUi();
  document.documentElement.append(ui.host);

  function syncRoute() {
    ui.host.style.display = isConversationPage() ? "block" : "none";
  }

  syncRoute();
  setInterval(syncRoute, 1_000);
})();
