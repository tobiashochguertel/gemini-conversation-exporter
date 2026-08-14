"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Load the download-strategies module by evaluating it in a function scope.
const srcPath = path.resolve(__dirname, "../src/download-strategies.js");
const src = fs.readFileSync(srcPath, "utf8");
const fflate = require("fflate");

// The module declares `const DownloadStrategies = Object.freeze({...})`.
// We eval it inside a function that returns the captured variable.
const DownloadStrategies = new Function(src + "\n; return DownloadStrategies;")();

test("DownloadStrategies is frozen and cannot be modified", () => {
  assert.ok(Object.isFrozen(DownloadStrategies));
});

test("definitions lists all available strategies", () => {
  const ids = DownloadStrategies.definitions.map((d) => d.id);
  assert.ok(ids.includes("link-only"));
  assert.ok(ids.includes("zip-bundle"));
  assert.equal(ids.length, 2);
});

test("collectAllGeneratedFiles returns empty for turns without generated files", () => {
  const turns = [
    { extensions: [{ index: 0, raw: {} }] },
    { extensions: [] },
    {},
  ];
  const files = DownloadStrategies.collectAllGeneratedFiles(turns);
  assert.equal(files.length, 0);
});

test("collectAllGeneratedFiles collects files from all turns", () => {
  const turns = [
    {
      extensions: [
        {
          index: 0,
          raw: {},
          generatedFiles: [
            { filename: "a.docx", downloadUrl: "https://a.test" },
            { filename: "b.docx", downloadUrl: "https://b.test" },
          ],
        },
      ],
    },
    {
      extensions: [
        {
          index: 0,
          raw: {},
          generatedFiles: [
            { filename: "c.docx", downloadUrl: "https://c.test" },
          ],
        },
      ],
    },
  ];
  const files = DownloadStrategies.collectAllGeneratedFiles(turns);
  assert.equal(files.length, 3);
  assert.equal(files[0].file.filename, "a.docx");
  assert.equal(files[1].file.filename, "b.docx");
  assert.equal(files[2].file.filename, "c.docx");
});

test("sanitizeZipFilename removes invalid characters", () => {
  assert.equal(DownloadStrategies.sanitizeZipFilename("test.docx"), "test.docx");
  assert.equal(DownloadStrategies.sanitizeZipFilename("a/b\\c:*?x"), "a_b_c___x");
  assert.equal(DownloadStrategies.sanitizeZipFilename(""), "file");
  assert.equal(DownloadStrategies.sanitizeZipFilename("   "), "file");
});

test("execute with link-only strategy returns text mode", async () => {
  const result = await DownloadStrategies.execute("link-only", {}, "markdown");
  assert.equal(result.mode, "text");
});

test("execute with unknown strategy throws", async () => {
  await assert.rejects(
    () => DownloadStrategies.execute("unknown", {}, "markdown"),
    /Unknown download strategy: unknown/,
  );
});

test("buildZipBundle creates a ZIP with markdown, JSON, and generated files", async () => {
  // Mock Core
  const Core = {
    safeFilename: (name, ext) => name.replace(/[^a-zA-Z0-9-_]/g, "_") + (ext ? "." + ext : ""),
    renderMarkdown: () => "# Test Markdown\n\nContent here.",
    renderJson: () => JSON.stringify({ title: "Test", turns: [] }),
  };

  // Mock pageWindow with fetch
  const mockFileContent = new Uint8Array([80, 75, 3, 4]); // PK zip header
  const pageWindow = {
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      blob: async () => new Blob([mockFileContent]),
      arrayBuffer: async () => mockFileContent.buffer,
    }),
  };

  const turns = [
    {
      extensions: [
        {
          index: 0,
          raw: {},
          generatedFiles: [
            { filename: "test.docx", downloadUrl: "https://download.test/test.docx" },
          ],
        },
      ],
    },
  ];

  const { blob, filename } = await DownloadStrategies.buildZipBundle({
    turns,
    title: "Test Conversation",
    conversationId: "c_test",
    sourceUrl: "https://gemini.google.com/app/test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    diagnostics: { fingerprint: "abcd1234" },
    preferences: { includeMetadata: true, includeOutline: true },
    pageWindow,
    Core,
    fflate,
  });

  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "application/zip");
  assert.equal(filename, "Test_Conversation.zip");

  // Verify ZIP contents
  const zipBuf = new Uint8Array(await blob.arrayBuffer());
  const files = fflate.unzipSync(zipBuf);
  const names = Object.keys(files);
  assert.ok(names.includes("Test_Conversation.md"));
  assert.ok(names.includes("Test_Conversation.json"));
  assert.ok(names.includes("generated-files/test.docx"));
});

test("buildZipBundle handles download failures gracefully", async () => {
  const Core = {
    safeFilename: (name) => name.replace(/[^a-zA-Z0-9-_]/g, "_"),
    renderMarkdown: () => "# Test",
    renderJson: () => "{}",
  };

  const pageWindow = {
    fetch: async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      blob: async () => new Blob([]),
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  };

  const turns = [
    {
      extensions: [
        {
          index: 0,
          raw: {},
          generatedFiles: [
            { filename: "fail.docx", downloadUrl: "https://fail.test" },
          ],
        },
      ],
    },
  ];

  const { blob, filename } = await DownloadStrategies.buildZipBundle({
    turns,
    title: "Test",
    conversationId: "c_test",
    sourceUrl: "https://gemini.google.com/app/test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    diagnostics: { fingerprint: "abcd" },
    preferences: { includeMetadata: true, includeOutline: true },
    pageWindow,
    Core,
    fflate,
  });

  const zipBuf = new Uint8Array(await blob.arrayBuffer());
  const files = fflate.unzipSync(zipBuf);
  const names = Object.keys(files);
  // The failed file should have an error note
  assert.ok(names.some((n) => n.includes("ERROR.txt")));
});

test("buildZipBundle avoids filename collisions", async () => {
  const Core = {
    safeFilename: (name) => name.replace(/[^a-zA-Z0-9-_]/g, "_"),
    renderMarkdown: () => "# Test",
    renderJson: () => "{}",
  };

  const mockContent = new Uint8Array([1, 2, 3]);
  const pageWindow = {
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      blob: async () => new Blob([mockContent]),
      arrayBuffer: async () => mockContent.buffer,
    }),
  };

  const turns = [
    {
      extensions: [
        {
          index: 0,
          raw: {},
          generatedFiles: [
            { filename: "same.docx", downloadUrl: "https://a.test" },
            { filename: "same.docx", downloadUrl: "https://b.test" },
            { filename: "same.docx", downloadUrl: "https://c.test" },
          ],
        },
      ],
    },
  ];

  const { blob } = await DownloadStrategies.buildZipBundle({
    turns,
    title: "Test",
    conversationId: "c_test",
    sourceUrl: "https://test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    diagnostics: { fingerprint: "abcd" },
    preferences: { includeMetadata: true, includeOutline: true },
    pageWindow,
    Core,
    fflate,
  });

  const zipBuf = new Uint8Array(await blob.arrayBuffer());
  const files = fflate.unzipSync(zipBuf);
  const names = Object.keys(files);
  assert.ok(names.includes("generated-files/same.docx"));
  assert.ok(names.includes("generated-files/same-1.docx"));
  assert.ok(names.includes("generated-files/same-2.docx"));
});
