// ==UserScript==
// @name         Gemini Conversation Exporter
// @namespace    local.gemini-web-exporter
// @version      0.2.1
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

const ROOT_ID = "gemini-web-exporter-root";
const HISTORY_PAGE_SIZE = 50;
const PREFERENCE_KEYS = Object.freeze({
  collapsed: "ui.collapsed",
  includeMetadata: "export.includeMetadata",
  includeOutline: "export.includeOutline",
  logLevel: "debug.logLevel",
});

const LOG_LEVELS = Object.freeze({
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

  const log = {
    level: LOG_LEVELS[
      PreferenceStorage.readString(PREFERENCE_KEYS.logLevel, "debug")
    ] ?? LOG_LEVELS.debug,

    error(...args) {
      if (this.level >= LOG_LEVELS.error) console.error("[Gemini Exporter]", ...args);
    },
    warn(...args) {
      if (this.level >= LOG_LEVELS.warn) console.warn("[Gemini Exporter]", ...args);
    },
    info(...args) {
      if (this.level >= LOG_LEVELS.info) console.info("[Gemini Exporter]", ...args);
    },
    debug(...args) {
      if (this.level >= LOG_LEVELS.debug) console.debug("[Gemini Exporter]", ...args);
    },
    setLevel(name) {
      const level = LOG_LEVELS[name];
      if (level === undefined) {
        console.warn("[Gemini Exporter] unknown log level:", name);
        return;
      }
      this.level = level;
      PreferenceStorage.writeString(PREFERENCE_KEYS.logLevel, name);
      console.info("[Gemini Exporter] log level set to", name);
    },
  };

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
  };

  const { host, shadow } = Ui.createShadowRoot(ROOT_ID, ":host {\r\n  all: initial;\r\n  position: fixed;\r\n  right: 22px;\r\n  bottom: 22px;\r\n  z-index: 2147483647;\r\n  font-family: \"Google Sans\", system-ui, -apple-system, sans-serif;\r\n}\r\n\r\n.stack {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: flex-end;\r\n  gap: 10px;\r\n}\r\n\r\nbutton,\r\ninput {\r\n  font: inherit;\r\n}\r\n\r\nbutton {\r\n  appearance: none;\r\n  border: 0;\r\n  cursor: pointer;\r\n}\r\n\r\n.control {\r\n  display: flex;\r\n  overflow: hidden;\r\n  border: 1px solid rgba(255, 255, 255, 0.22);\r\n  border-radius: 999px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.export-button,\r\n.menu-button {\r\n  display: inline-flex;\r\n  min-height: 42px;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: transparent;\r\n  color: inherit;\r\n}\r\n\r\n.export-button {\r\n  gap: 8px;\r\n  min-width: 142px;\r\n  padding: 0 16px;\r\n  font-weight: 650;\r\n  white-space: nowrap;\r\n  transition: min-width 120ms ease, padding 120ms ease;\r\n}\r\n\r\n.export-button--secondary {\r\n  border-left: 1px solid rgba(255, 255, 255, 0.16);\r\n  min-width: 120px;\r\n}\r\n\r\n.download-icon {\r\n  font-size: 18px;\r\n  line-height: 1;\r\n}\r\n\r\n.menu-button {\r\n  width: 38px;\r\n  border-left: 1px solid rgba(255, 255, 255, 0.16);\r\n  font-size: 21px;\r\n  line-height: 1;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-button {\r\n  min-width: 42px;\r\n  padding: 0 12px;\r\n}\r\n\r\n.control[data-collapsed=\"true\"] .export-label {\r\n  display: none;\r\n}\r\n\r\n.export-button:hover,\r\n.export-button--secondary:hover,\r\n.menu-button:hover {\r\n  background: #303030;\r\n}\r\n\r\nbutton:focus-visible {\r\n  outline: 3px solid #a8c7fa;\r\n  outline-offset: -3px;\r\n}\r\n\r\nbutton:disabled {\r\n  cursor: progress;\r\n  opacity: 0.72;\r\n}\r\n\r\n.panel {\r\n  box-sizing: border-box;\r\n  width: min(270px, calc(100vw - 32px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 14px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  padding: 14px;\r\n  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.34);\r\n}\r\n\r\n.panel[hidden] {\r\n  display: none;\r\n}\r\n\r\n.panel-heading {\r\n  margin: 0 0 10px;\r\n  font-size: 13px;\r\n  font-weight: 700;\r\n  letter-spacing: 0.01em;\r\n}\r\n\r\n.option {\r\n  display: grid;\r\n  grid-template-columns: 20px minmax(0, 1fr);\r\n  gap: 9px;\r\n  align-items: start;\r\n  border-radius: 9px;\r\n  cursor: pointer;\r\n  padding: 8px 6px;\r\n}\r\n\r\n.option:hover {\r\n  background: rgba(255, 255, 255, 0.07);\r\n}\r\n\r\n.option input {\r\n  width: 16px;\r\n  height: 16px;\r\n  margin: 1px 0 0;\r\n  accent-color: #a8c7fa;\r\n}\r\n\r\n.option-copy {\r\n  display: flex;\r\n  min-width: 0;\r\n  flex-direction: column;\r\n  gap: 3px;\r\n}\r\n\r\n.option-label {\r\n  font-size: 13px;\r\n  font-weight: 650;\r\n  line-height: 1.2;\r\n}\r\n\r\n.option-description {\r\n  color: #c7c7c7;\r\n  font-size: 11px;\r\n  font-weight: 450;\r\n  line-height: 1.35;\r\n}\r\n\r\n.compact-toggle {\r\n  width: 100%;\r\n  margin-top: 10px;\r\n  border-top: 1px solid rgba(255, 255, 255, 0.14);\r\n  background: transparent;\r\n  color: #a8c7fa;\r\n  padding: 12px 6px 3px;\r\n  text-align: left;\r\n  font-size: 12px;\r\n  font-weight: 650;\r\n}\r\n\r\n.compact-toggle:hover {\r\n  color: #d3e3fd;\r\n}\r\n\r\n.toast {\r\n  box-sizing: border-box;\r\n  display: none;\r\n  max-width: min(420px, calc(100vw - 44px));\r\n  border: 1px solid rgba(255, 255, 255, 0.18);\r\n  border-radius: 12px;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  font: 500 13px/1.45 system-ui, -apple-system, sans-serif;\r\n  padding: 11px 13px;\r\n  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);\r\n}\r\n\r\n.toast[data-kind=\"error\"] {\r\n  background: #8c1d18;\r\n}\r\n\r\n@media (max-width: 520px) {\r\n  :host {\r\n    right: 12px;\r\n    bottom: 12px;\r\n  }\r\n}");
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

      Utils.downloadTextFile(content, filename);
      log.info(`${fmt.label} complete`, {
        filename,
        format: fmt.id,
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
