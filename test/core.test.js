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
  model = null,
  language = null,
  thinking = null,
  webCitations = null,
  extensions = null,
  feedback = null,
}) {
  // Build a 38-field candidate with optional thinking (37), citations (2), extensions (12)
  const candidate = new Array(38).fill(null);
  candidate[0] = candidateId;
  candidate[1] = [assistant];
  candidate[9] = "en";
  if (webCitations) {
    candidate[2] = [null, webCitations];
  }
  if (extensions) {
    candidate[12] = extensions;
  }
  if (thinking) {
    candidate[37] = thinking;
  }

  // Build a 26-field turnMeta with optional model (21), language (8), feedback (1)
  const turnMeta = new Array(26).fill(null);
  turnMeta[0] = [candidate];
  turnMeta[3] = candidateId;
  if (language) turnMeta[8] = language;
  if (feedback) turnMeta[1] = feedback;
  if (model) turnMeta[21] = model;

  return [
    [conversationId, responseId],
    [conversationId, parentResponseId, parentCandidateId],
    [[user], 2, null, 0, "model"],
    turnMeta,
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

test("creates filesystem-safe filenames with custom extension", () => {
  assert.equal(
    Core.safeFilename('Branch: "A/B" <test>', "json"),
    "Branch- -A-B- -test.json",
  );
  assert.equal(
    Core.safeFilename("My Conversation", "json"),
    "My Conversation.json",
  );
});

test("renderJson produces valid JSON with metadata and turns", () => {
  const turns = Core.historyToChronologicalTurns([newerTurn, olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "Demo",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
  });

  const data = JSON.parse(json);
  assert.equal(data.title, "Demo");
  assert.equal(data.sourceUrl, "https://gemini.google.com/app/demo");
  assert.equal(data.conversationId, "c_demo");
  assert.equal(data.exportedAt, "2026-07-27T00:00:00.000Z");
  assert.equal(data.turnCount, 2);
  assert.equal(data.turns.length, 2);
  assert.equal(data.turns[0].index, 1);
  assert.equal(data.turns[1].index, 2);
  assert.ok(data.turns[0].userMarkdown.length > 0);
  assert.ok(data.turns[0].assistantMarkdown.length > 0);
  assert.ok(data.validation.fingerprint);
});

test("renderJson omits metadata when disabled", () => {
  const turns = Core.historyToChronologicalTurns([olderTurn]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "No metadata",
    sourceUrl: "https://gemini.google.com/app/demo",
    conversationId: "c_demo",
    exportedAt: "2026-07-27T00:00:00.000Z",
    turns,
    diagnostics,
    includeMetadata: false,
  });

  const data = JSON.parse(json);
  assert.equal(data.title, "No metadata");
  assert.equal(data.turns.length, 1);
  assert.equal("sourceUrl" in data, false);
  assert.equal("conversationId" in data, false);
  assert.equal("exportedAt" in data, false);
  assert.equal("turnCount" in data, false);
  assert.equal("validation" in data, false);
});

test("extractTurn captures model name and language", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    model: "3.6 Flash Extended",
    language: "DE",
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.equal(turns[0].model, "3.6 Flash Extended");
  assert.equal(turns[0].language, "DE");
});

test("extractTurn captures thinking text and steps", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    thinking: [
      ["**Step 1**\n\nReasoning about the question."],
      [
        [["**Step 1**\n\nReasoning about the question."], "", "", "", [], "", ""],
        [["**Step 2**\n\nFormulating the answer."], "", "", "", [], "", ""],
      ],
    ],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].thinking);
  assert.equal(turns[0].thinking.text, "**Step 1**\n\nReasoning about the question.");
  assert.equal(turns[0].thinking.steps.length, 2);
  assert.equal(turns[0].thinking.steps[0], "**Step 1**\n\nReasoning about the question.");
  assert.equal(turns[0].thinking.steps[1], "**Step 2**\n\nFormulating the answer.");
});

test("extractTurn omits thinking when candidate has no thinking field", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.equal("thinking" in turns[0], false);
});

test("extractTurn captures web citations", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    webCitations: [
      [["**[Example](https://example.com)**"], null, null, "spp_abc123"],
    ],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].webCitations);
  assert.equal(turns[0].webCitations.length, 1);
  assert.equal(turns[0].webCitations[0].text, "**[Example](https://example.com)**");
  assert.equal(turns[0].webCitations[0].sourceId, "spp_abc123");
});

test("extractTurn captures extension/tool results", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    extensions: [null, [{ type: "search", query: "test" }], null, null, null, null, null, []],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].extensions);
  // Null entries are filtered out; non-null entries preserve their original index.
  assert.equal(turns[0].extensions.length, 2);
  assert.equal(turns[0].extensions[0].index, 1);
  assert.equal(turns[0].extensions[1].index, 7);
});

test("extractTurn captures feedback/ratings", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    feedback: [["thumbs_up"], ["good_response"]],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].feedback);
  assert.equal(turns[0].feedback.length, 2);
});

test("renderJson includes thinking, model, and citations in output", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    model: "3.6 Flash Extended",
    language: "DE",
    thinking: [["Thinking text"], [[["Thinking text"], "", "", "", [], "", ""]]],
    webCitations: [[["[Link](https://example.com)"], null, null, "spp_1"]],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });
  const data = JSON.parse(json);
  assert.equal(data.turns[0].model, "3.6 Flash Extended");
  assert.equal(data.turns[0].language, "DE");
  assert.equal(data.turns[0].thinking.text, "Thinking text");
  assert.equal(data.turns[0].thinking.steps.length, 1);
  assert.equal(data.turns[0].webCitations[0].sourceId, "spp_1");
});

test("renderJson includes sourceIndex for debuggability", () => {
  const raw1 = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "First",
    assistant: "Response 1",
    seconds: 1_700_000_000,
  });
  const raw2 = makeRawTurn({
    responseId: "r_2",
    parentResponseId: "r_1",
    candidateId: "rc_2",
    parentCandidateId: "rc_1",
    user: "Second",
    assistant: "Response 2",
    seconds: 1_700_000_001,
  });
  // Raw order is newest-first: [raw2, raw1]
  // sourceIndex is the position in the raw array: raw2=0, raw1=1
  // After chronological reversal: turn 1 = raw1 (sourceIndex=1), turn 2 = raw2 (sourceIndex=0)
  const turns = Core.historyToChronologicalTurns([raw2, raw1]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });
  const data = JSON.parse(json);
  assert.equal(data.turns[0].index, 1);
  assert.equal(data.turns[0].sourceIndex, 1);
  assert.equal(data.turns[1].index, 2);
  assert.equal(data.turns[1].sourceIndex, 0);
});

test("renderJson omits thinking/model/citations when absent", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });
  const data = JSON.parse(json);
  assert.equal("thinking" in data.turns[0], false);
  assert.equal("model" in data.turns[0], false);
  assert.equal("language" in data.turns[0], false);
  assert.equal("webCitations" in data.turns[0], false);
  assert.equal("extensions" in data.turns[0], false);
  assert.equal("feedback" in data.turns[0], false);
});

test("renderMarkdown includes thinking in a collapsible details block", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    model: "3.6 Flash Extended",
    thinking: [
      ["**Step 1**\n\nReasoning."],
      [[["**Step 1**\n\nReasoning."], "", "", "", [], "", ""]],
    ],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(md.includes("### Thinking"));
  assert.ok(md.includes("<details>"));
  assert.ok(md.includes("<summary>Thinking process (1 steps)</summary>"));
  assert.ok(md.includes("**Step 1**"));
  assert.ok(md.includes("</details>"));
  assert.ok(md.includes("model=3.6 Flash Extended"));
});

test("renderMarkdown includes web citations section", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    webCitations: [
      [["[Example](https://example.com)"], null, null, "spp_1"],
      [["[Another](https://another.com)"], null, null, "spp_2"],
    ],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(md.includes("#### Citations"));
  assert.ok(md.includes("[Example](https://example.com)"));
  assert.ok(md.includes("`spp_1`"));
  assert.ok(md.includes("[Another](https://another.com)"));
});

test("renderMarkdown omits thinking and citations sections when absent", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(!md.includes("### Thinking"));
  assert.ok(!md.includes("<details>"));
  assert.ok(!md.includes("Citations"));
});

test("renderMarkdown includes parentResponseId and parentCandidateId in metadata comment", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    parentResponseId: "r_seed",
    candidateId: "rc_1",
    parentCandidateId: "rc_seed",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.match(md, /parentResponse=r_seed/);
  assert.match(md, /parentCandidate=rc_seed/);
  assert.match(md, /sourceIndex=\d+/);
});

test("renderMarkdown includes extensions in a collapsible details block", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    extensions: [null, [{ type: "search", query: "test" }], null, null, null, null, null, []],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(md.includes("#### Extensions"));
  assert.ok(md.includes("<details>"));
  assert.ok(md.includes("<summary>Extension/tool results (2)</summary>"));
  assert.ok(md.includes("```json"));
  assert.ok(md.includes('"type": "search"'));
  assert.ok(md.includes("</details>"));
});

test("renderMarkdown includes feedback in a collapsible details block", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
    feedback: [["thumbs_up"], ["good_response"]],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(md.includes("#### Feedback"));
  assert.ok(md.includes("<details>"));
  assert.ok(md.includes("<summary>Feedback/rating groups (2)</summary>"));
  assert.ok(md.includes("```json"));
  assert.ok(md.includes('"thumbs_up"'));
  assert.ok(md.includes("</details>"));
});

test("renderMarkdown omits extensions and feedback sections when absent", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi there",
    seconds: 1_700_000_000,
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(!md.includes("Extensions"));
  assert.ok(!md.includes("Feedback"));
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
  const built = fs.readFileSync(
    path.resolve(__dirname, "../dist/gemini-conversation-exporter.user.js"),
    "utf8",
  );

  assert.match(userscriptMain, /PreferenceStorage\.readBoolean/);
  assert.match(userscriptMain, /PreferenceStorage\.writeBoolean/);
  assert.match(userscriptMain, /Conversation outline/);
  assert.match(userscriptMain, /Export metadata/);
  assert.match(userscriptMain, /Use compact control/);
  assert.doesNotMatch(userscriptMain, /GM_registerMenuCommand/);
  assert.doesNotMatch(built, /GM_registerMenuCommand/);
  assert.match(built, /@grant\s+GM_getValue/);
  assert.match(built, /@grant\s+GM_setValue/);
  assert.match(built, /PreferenceStorage/);
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
  const built = fs.readFileSync(
    path.resolve(__dirname, "../dist/gemini-conversation-exporter.user.js"),
    "utf8",
  );

  assert.deepEqual(
    Array.from(built.matchAll(/^\/\/ @match\s+(.+)$/gm), (match) => match[1]),
    [
      "https://gemini.google.com/*",
      "https://gemini.google.com/app",
      "https://gemini.google.com/app/*",
      "https://gemini.google.com/u/*/app",
      "https://gemini.google.com/u/*/app/*",
    ],
  );
  assert.match(built, /@sandbox\s+raw/);
  assert.match(built, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com/);
  assert.match(built, /@updateURL\s+https:\/\/raw\.githubusercontent\.com/);
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
  assert.match(buildScript, /JSON\.stringify/);
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

// Helper: build a raw extension object with generated files (key '59')
function makeGeneratedFileExtension(files) {
  const ext = { "8": [], "33": [null, []] };
  ext["59"] = [
    files.map((f) => [
      f.fileTag,
      null,
      [
        null,
        f.typeCode ?? 10,
        f.filename,
        null,
        null,
        f.dataToken ?? "$AXzLiTestToken",
        null,
        [f.thumbnailUrl ?? "https://thumb.test", f.downloadUrl ?? "https://download.test", f.uploadUrl ?? "https://upload.test"],
        null,
        null,
        null,
        f.mimeType ?? "application/octet-stream",
      ],
    ]),
  ];
  return ext;
}

test("extractTurn parses generated files from extension key 59", () => {
  const ext = makeGeneratedFileExtension([
    {
      fileTag: "[file-tag: code-generated-file-aaa]",
      filename: "test.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      downloadUrl: "https://contribution.usercontent.google.com/download?c=abc&filename=test.docx",
    },
    {
      fileTag: "[file-tag: code-generated-file-bbb]",
      filename: "guide.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      downloadUrl: "https://contribution.usercontent.google.com/download?c=def&filename=guide.docx",
    },
  ]);
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Create a doc",
    assistant: "Here it is",
    seconds: 1_700_000_000,
    extensions: [ext, null, null, null, null, null, null, []],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].extensions);
  assert.equal(turns[0].extensions.length, 2);
  const ext0 = turns[0].extensions[0];
  assert.equal(ext0.index, 0);
  assert.ok(ext0.generatedFiles);
  assert.equal(ext0.generatedFiles.length, 2);
  assert.equal(ext0.generatedFiles[0].filename, "test.docx");
  assert.equal(ext0.generatedFiles[0].mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(ext0.generatedFiles[0].downloadUrl, "https://contribution.usercontent.google.com/download?c=abc&filename=test.docx");
  assert.equal(ext0.generatedFiles[0].fileTag, "[file-tag: code-generated-file-aaa]");
  assert.equal(ext0.generatedFiles[0].typeCode, 10);
  assert.equal(ext0.generatedFiles[1].filename, "guide.docx");
});

test("extractTurn captures uploaded files from turn[2][0][4]", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Analyze this",
    assistant: "Done",
    seconds: 1_700_000_000,
  });
  // Override the attachments field
  raw[2][0][4] = [[{ filename: "upload.png", mime: "image/png" }]];

  const turns = Core.historyToChronologicalTurns([raw]);
  assert.ok(turns[0].uploadedFiles);
  assert.equal(turns[0].uploadedFiles.length, 1);
  assert.ok(turns[0].uploadedFiles[0].raw);
});

test("extractTurn returns null uploadedFiles when attachments is empty", () => {
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Hello",
    assistant: "Hi",
    seconds: 1_700_000_000,
  });
  // Default makeRawTurn sets turn[2][0][4] = "model" string, not array.
  // Let's set it to [[]] (empty attachments, as observed in real data)
  raw[2][0][4] = [[]];

  const turns = Core.historyToChronologicalTurns([raw]);
  assert.equal(turns[0].uploadedFiles, undefined);
});

test("renderMarkdown replaces file-tag placeholders with download links", () => {
  const ext = makeGeneratedFileExtension([
    {
      fileTag: "[file-tag: code-generated-file-abc123]",
      filename: "report.docx",
      downloadUrl: "https://contribution.usercontent.google.com/download?c=xyz&filename=report.docx",
    },
  ]);
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Make a report",
    assistant: "Done!\n\n[file-tag: code-generated-file-abc123]\n\nHope it helps!",
    seconds: 1_700_000_000,
    extensions: [ext, null, null, null, null, null, null, []],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  // The file-tag should be replaced with a download link in the Gemini section.
  // (It may still appear in the extensions JSON dump.)
  const geminiSection = md.split("### Gemini")[1]?.split("####")[0];
  assert.ok(geminiSection);
  assert.ok(!geminiSection.includes("[file-tag: code-generated-file-abc123]"));
  assert.ok(md.includes("[report.docx](https://contribution.usercontent.google.com/download"));
});

test("renderMarkdown includes generated files section", () => {
  const ext = makeGeneratedFileExtension([
    {
      fileTag: "[file-tag: code-generated-file-aaa]",
      filename: "test.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      downloadUrl: "https://download.test/test.docx",
    },
  ]);
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Create a doc",
    assistant: "Here it is",
    seconds: 1_700_000_000,
    extensions: [ext, null, null, null, null, null, null, []],
  });
  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const md = Core.renderMarkdown({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });

  assert.ok(md.includes("#### Generated files"));
  assert.ok(md.includes("[test.docx](https://download.test/test.docx)"));
  assert.ok(md.includes("`application/vnd.openxmlformats-officedocument.wordprocessingml.document`"));
});

test("renderJson includes generatedFiles in extensions and uploadedFiles", () => {
  const ext = makeGeneratedFileExtension([
    {
      fileTag: "[file-tag: code-generated-file-aaa]",
      filename: "test.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      downloadUrl: "https://download.test/test.docx",
    },
  ]);
  const raw = makeRawTurn({
    responseId: "r_1",
    candidateId: "rc_1",
    user: "Create a doc",
    assistant: "Here it is",
    seconds: 1_700_000_000,
    extensions: [ext, null, null, null, null, null, null, []],
  });
  raw[2][0][4] = [[{ filename: "upload.png" }]];

  const turns = Core.historyToChronologicalTurns([raw]);
  const diagnostics = Core.validateConversation(turns);
  const json = Core.renderJson({
    title: "Test",
    sourceUrl: "https://gemini.google.com/app/test",
    conversationId: "c_test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    turns,
    diagnostics,
  });
  const data = JSON.parse(json);

  assert.ok(data.turns[0].extensions);
  assert.ok(data.turns[0].extensions[0].generatedFiles);
  assert.equal(data.turns[0].extensions[0].generatedFiles[0].filename, "test.docx");
  assert.equal(data.turns[0].extensions[0].generatedFiles[0].downloadUrl, "https://download.test/test.docx");
  assert.ok(data.turns[0].uploadedFiles);
  assert.equal(data.turns[0].uploadedFiles.length, 1);
});

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
