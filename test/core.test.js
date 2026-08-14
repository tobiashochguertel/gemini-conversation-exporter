"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Core = require("../src/core.js");

function makeRawTurn({
  conversationId = "c_demo",
  responseId,
  parentResponseId,
  candidateId,
  parentCandidateId,
  user,
  assistant,
  seconds,
}) {
  return [
    [conversationId, responseId],
    [conversationId, parentResponseId, parentCandidateId],
    [[user], 2, null, 0, "model"],
    [
      [
        [
          candidateId,
          [assistant],
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "en",
        ],
      ],
      null,
      null,
      candidateId,
    ],
    [seconds, 0],
  ];
}

function wrapHistoryPayload(payload) {
  const envelope = [
    [
      [
        "wrb.fr",
        Core.HISTORY_RPC_ID,
        JSON.stringify(payload),
        null,
        null,
        null,
        "generic",
      ],
    ],
  ];
  const json = JSON.stringify(envelope);
  return `)]}'\n\n${Buffer.byteLength(json)}\n${json}\n`;
}

const olderTurn = makeRawTurn({
  responseId: "r_old",
  parentResponseId: "r_seed",
  candidateId: "rc_old",
  parentCandidateId: "rc_seed",
  user: "Why does $x^2$ matter?",
  assistant: "Because\n\n$$\nx^2 \\ge 0\n$$",
  seconds: 1_700_000_000,
});

const newerTurn = makeRawTurn({
  responseId: "r_new",
  parentResponseId: "r_old",
  candidateId: "rc_new",
  parentCandidateId: "rc_old",
  user: "Show a table.",
  assistant: "| A | B |\n|---|---|\n| 1 | 2 |",
  seconds: 1_700_000_100,
});

test("parses a Gemini batchexecute history page", () => {
  const response = wrapHistoryPayload([[newerTurn], "next-token", null, []]);
  const page = Core.parseHistoryPage(response);

  assert.equal(page.rawTurns.length, 1);
  assert.equal(page.cursor, "next-token");
});

test("collects pagination and preserves authoritative chronological order", async () => {
  const responses = [
    wrapHistoryPayload([[newerTurn], "cursor-1", null, []]),
    wrapHistoryPayload([[olderTurn], null, null, []]),
  ];
  let call = 0;

  const history = await Core.collectHistoryPages(async () => responses[call++]);
  const turns = Core.historyToChronologicalTurns(
    history.rawTurnsNewestFirst,
  );
  const diagnostics = Core.validateConversation(turns);

  assert.equal(history.pages.length, 2);
  assert.deepEqual(
    turns.map((turn) => turn.responseId),
    ["r_old", "r_new"],
  );
  assert.equal(diagnostics.turnCount, 2);
  assert.equal(diagnostics.markdownWarnings.length, 0);
});

test("stops when Gemini repeats a pagination cursor", async () => {
  const response = wrapHistoryPayload([[newerTurn], "same-cursor", null, []]);

  await assert.rejects(
    Core.collectHistoryPages(async () => response),
    /repeated a history cursor/,
  );
});

test("fails closed when a turn is incomplete", () => {
  const incomplete = makeRawTurn({
    responseId: "r_incomplete",
    parentResponseId: "r_seed",
    candidateId: "rc_incomplete",
    parentCandidateId: "rc_seed",
    user: "Question",
    assistant: "",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([incomplete]);

  assert.throws(
    () => Core.validateConversation(turns),
    /content was missing/,
  );
});

test("renders original Markdown and LaTeX without conversion", () => {
  const turns = Core.historyToChronologicalTurns([newerTurn, olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const markdown = Core.renderMarkdown({
    title: "Demo",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.match(markdown, /^## Conversation outline$/m);
  assert.match(
    markdown,
    /^1\. \[Turn 1 — Why does x\^2 matter\?\]\(#turn-1\)$/m,
  );
  assert.match(markdown, /^2\. \[Turn 2 — Show a table\.\]\(#turn-2\)$/m);
  assert.match(markdown, /^## turn-1$/m);
  assert.match(markdown, /^## turn-2$/m);
  assert.match(markdown, /^### User$/m);
  assert.match(markdown, /^### Gemini$/m);
  assert.match(markdown, /\$\$\nx\^2 \\ge 0\n\$\$/);
  assert.match(markdown, /\| A \| B \|/);
  assert.match(markdown, /Validation fingerprint/);
  assert.match(markdown, /<!-- gemini-export: turn=1/);
});

test("always renders an enabled outline for a one-turn conversation", () => {
  const turns = Core.historyToChronologicalTurns([olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const markdown = Core.renderMarkdown({
    title: "One turn",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.match(markdown, /^## Conversation outline$/m);
  assert.match(markdown, /^1\. \[Turn 1 — /m);
  assert.match(markdown, /^## turn-1$/m);
});

test("omits export and turn metadata when disabled", () => {
  const turns = Core.historyToChronologicalTurns([olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const markdown = Core.renderMarkdown({
    title: "No metadata",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
    includeMetadata: false,
  });

  assert.doesNotMatch(markdown, /^> Source:/m);
  assert.doesNotMatch(markdown, /^> Exported:/m);
  assert.doesNotMatch(markdown, /^> Conversation:/m);
  assert.doesNotMatch(markdown, /Validation fingerprint/);
  assert.doesNotMatch(markdown, /<!-- gemini-export:/);
  assert.match(markdown, /^## Conversation outline$/m);
});

test("restores the original role-only structure when outline is disabled", () => {
  const turns = Core.historyToChronologicalTurns([olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const markdown = Core.renderMarkdown({
    title: "No outline",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
    includeOutline: false,
  });

  assert.doesNotMatch(markdown, /^## Conversation outline$/m);
  assert.doesNotMatch(markdown, /^## turn-1$/m);
  assert.match(markdown, /^## User$/m);
  assert.match(markdown, /^## Gemini$/m);
});

test("creates short deterministic outline previews without Markdown markup", () => {
  assert.equal(
    Core.turnPreview(
      "# **Compare** [these results](https://example.com) with `$x^2$`.",
    ),
    "Compare these results with x^2.",
  );
  assert.equal(
    Core.turnPreview("A deliberately long prompt with several words", 24),
    "A deliberately long…",
  );
});

test("creates filesystem-safe Markdown filenames", () => {
  assert.equal(
    Core.safeFilename('Branch: "A/B" <test>'),
    "Branch- -A-B- -test.md",
  );
});

test("extracts conversation IDs from default and account-scoped Gemini URLs", () => {
  assert.equal(Core.conversationIdFromPath("/app/abc123"), "c_abc123");
  assert.equal(Core.conversationIdFromPath("/app/c_abc123"), "c_abc123");
  assert.equal(Core.conversationIdFromPath("/u/0/app/abc123"), "c_abc123");
  assert.equal(Core.conversationIdFromPath("/u/12/app/abc123"), "c_abc123");
});

test("preserves every numeric account slot in Gemini RPC paths", () => {
  const rpcPath = "/_/BardChatUi/data/batchexecute";

  assert.equal(Core.accountScopedPath("/app/abc123", rpcPath), rpcPath);
  assert.equal(
    Core.accountScopedPath("/u/0/app/abc123", rpcPath),
    "/u/0/_/BardChatUi/data/batchexecute",
  );
  assert.equal(
    Core.accountScopedPath("/u/1/app/abc123", rpcPath),
    "/u/1/_/BardChatUi/data/batchexecute",
  );
  assert.equal(
    Core.accountScopedPath("/u/27/app/abc123", rpcPath),
    "/u/27/_/BardChatUi/data/batchexecute",
  );
  assert.equal(
    Core.accountScopedPath("/u/account/app/abc123", rpcPath),
    rpcPath,
  );
});

test("rejects paths that are not Gemini conversation routes", () => {
  assert.equal(Core.conversationIdFromPath("/app"), null);
  assert.equal(Core.conversationIdFromPath("/u/0/app"), null);
  assert.equal(Core.conversationIdFromPath("/u/account/app/abc123"), null);
  assert.equal(Core.conversationIdFromPath("/search"), null);
});

test("userscript UI remains compatible with Gemini Trusted Types", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );

  assert.doesNotMatch(userscriptMain, /\.innerHTML\s*=/);
});

test("userscript provides persistent on-page export preferences", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );
  const buildScript = fs.readFileSync(
    path.resolve(__dirname, "../scripts/build.js"),
    "utf8",
  );

  assert.match(userscriptMain, /PreferenceStorage\.readBoolean/);
  assert.match(userscriptMain, /PreferenceStorage\.writeBoolean/);
  assert.match(userscriptMain, /Conversation outline/);
  assert.match(userscriptMain, /Export metadata/);
  assert.match(userscriptMain, /Use compact control/);
  assert.doesNotMatch(userscriptMain, /GM_registerMenuCommand/);
  assert.doesNotMatch(buildScript, /GM_registerMenuCommand/);
  assert.match(buildScript, /@grant\s+GM_getValue/);
  assert.match(buildScript, /@grant\s+GM_setValue/);
  assert.match(buildScript, /preference-storage\.js/);
});

test("userscript clones request options into Firefox's page realm", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );
  const historyFetcher = fs.readFileSync(
    path.resolve(__dirname, "../src/history-fetcher.js"),
    "utf8",
  );

  assert.match(historyFetcher, /Utils\.cloneForPageRealm/);
  assert.match(historyFetcher, /adapter\.pageWindow\.fetch/);
  assert.match(userscriptMain, /pageWindow/);
});

test("userscript preserves the active account slot for history requests", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );

  assert.match(userscriptMain, /HistoryFetcher\.fetchPage/);
  assert.match(userscriptMain, /createGeminiAdapter/);
  assert.match(
    userscriptMain,
    /Core\.accountScopedPath\(\s*location\.pathname,\s*"\/_\/BardChatUi\/data\/batchexecute"/,
  );
  assert.match(
    userscriptMain,
    /new URLSearchParams\(location\.search\)\.get\("pageId"\)/,
  );
});

test("userscript metadata covers the Gemini origin and app routes", () => {
  const buildScript = fs.readFileSync(
    path.resolve(__dirname, "../scripts/build.js"),
    "utf8",
  );

  assert.deepEqual(
    Array.from(buildScript.matchAll(/^\/\/ @match\s+(.+)$/gm), (match) => match[1]),
    [
      "https://gemini.google.com/*",
      "https://gemini.google.com/app",
      "https://gemini.google.com/app/*",
      "https://gemini.google.com/u/*/app",
      "https://gemini.google.com/u/*/app/*",
    ],
  );
  assert.match(buildScript, /@sandbox\s+JavaScript/);
});

test("CSS is externalized and referenced via a build-time token", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );
  const cssPath = path.resolve(__dirname, "../src/exporter-ui.css");
  const cssExists = fs.existsSync(cssPath);

  assert.ok(cssExists, "src/exporter-ui.css should exist");
  assert.match(
    userscriptMain,
    /__EXPORTER_UI_CSS__/,
    "userscript-main.js should reference the __EXPORTER_UI_CSS__ token",
  );
  assert.doesNotMatch(
    userscriptMain,
    /style\.textContent\s*=\s*`/,
    "userscript-main.js should not contain inline CSS template literals",
  );
});

test("externalized CSS contains the expected Shadow DOM rules", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/exporter-ui.css"),
    "utf8",
  );

  for (const selector of [":host", ".stack", ".control", ".export-button", ".menu-button", ".panel", ".toast", ".compact-toggle"]) {
    assert.match(css, new RegExp(escapeRegExp(selector)));
  }
  assert.match(css, /@media\s*\(\s*max-width:\s*520px\s*\)/);
});

test("build script reads and inlines the external CSS file", () => {
  const buildScript = fs.readFileSync(
    path.resolve(__dirname, "../scripts/build.js"),
    "utf8",
  );

  assert.match(buildScript, /exporter-ui\.css/);
  assert.match(buildScript, /__EXPORTER_UI_CSS__/);
  assert.match(buildScript, /JSON\.stringify\(cssContent\)/);
});

test("built userscript contains inlined CSS without the raw token", () => {
  const distPath = path.resolve(__dirname, "../dist/gemini-conversation-exporter.user.js");

  if (!fs.existsSync(distPath)) {
    // Build hasn't run yet — skip gracefully
    return;
  }

  const built = fs.readFileSync(distPath, "utf8");

  assert.doesNotMatch(built, /__EXPORTER_UI_CSS__/);
  assert.match(built, /Ui\.createShadowRoot\([^,]+,\s*"/);
  assert.match(built, /:host/);
});

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
