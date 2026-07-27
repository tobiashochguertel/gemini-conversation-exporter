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

  assert.match(markdown, /## User/);
  assert.match(markdown, /## Gemini/);
  assert.match(markdown, /\$\$\nx\^2 \\ge 0\n\$\$/);
  assert.match(markdown, /\| A \| B \|/);
  assert.match(markdown, /Validation fingerprint/);
});

test("creates filesystem-safe Markdown filenames", () => {
  assert.equal(
    Core.safeFilename('Branch: "A/B" <test>'),
    "Branch- -A-B- -test.md",
  );
});

test("userscript UI remains compatible with Gemini Trusted Types", () => {
  const userscriptMain = fs.readFileSync(
    path.resolve(__dirname, "../src/userscript-main.js"),
    "utf8",
  );

  assert.doesNotMatch(userscriptMain, /\.innerHTML\s*=/);
});
