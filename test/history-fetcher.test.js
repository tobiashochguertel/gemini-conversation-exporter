"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the module source in a sandbox. HistoryFetcher depends on Utils
// (for cloneForPageRealm), so we load both.
function loadHistoryFetcher({ cloneInto } = {}) {
  const utilsSrc = fs.readFileSync(
    path.resolve(__dirname, "../src/utils.js"),
    "utf8",
  );
  const fetcherSrc = fs.readFileSync(
    path.resolve(__dirname, "../src/history-fetcher.js"),
    "utf8",
  );

  const fn = new Function("cloneInto", utilsSrc + "\n" + fetcherSrc + "\n; return HistoryFetcher;");
  return fn(cloneInto);
}

// A fake adapter that records calls and returns controlled responses.
function createFakeAdapter({ config, fetchResponse, fetchOk = true } = {}) {
  const calls = [];
  const fakeWindow = {
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, options });
      return {
        ok: fetchOk,
        status: fetchOk ? 200 : 500,
        text: async () => fetchResponse ?? "",
      };
    },
  };

  return {
    calls,
    pageWindow: fakeWindow,
    getConfig() {
      calls.push({ method: "getConfig" });
      return config ?? { token: "test" };
    },
    buildQuery(cfg, cursor) {
      calls.push({ method: "buildQuery", config: cfg, cursor });
      return new URLSearchParams({ q: "test", cursor: cursor ?? "" });
    },
    buildBody(cfg, cursor) {
      calls.push({ method: "buildBody", config: cfg, cursor });
      return `body-for-cursor=${cursor ?? "null"}`;
    },
    buildEndpoint(query) {
      calls.push({ method: "buildEndpoint", query: query.toString() });
      return `https://example.com/api?${query.toString()}`;
    },
    buildFetchOptions(body) {
      calls.push({ method: "buildFetchOptions", body });
      return {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      };
    },
  };
}

test("fetchPage calls adapter methods in the correct order", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({ fetchResponse: "payload" });

  await HistoryFetcher.fetchPage(adapter, "cursor-1");

  const methods = adapter.calls.map((c) => c.method).filter(Boolean);
  assert.deepEqual(methods, [
    "getConfig",
    "buildQuery",
    "buildBody",
    "buildEndpoint",
    "buildFetchOptions",
  ]);
});

test("fetchPage passes the cursor through to buildQuery and buildBody", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({ fetchResponse: "payload" });

  await HistoryFetcher.fetchPage(adapter, "next-page-token");

  const queryCall = adapter.calls.find((c) => c.method === "buildQuery");
  const bodyCall = adapter.calls.find((c) => c.method === "buildBody");
  assert.equal(queryCall.cursor, "next-page-token");
  assert.equal(bodyCall.cursor, "next-page-token");
});

test("fetchPage passes null cursor on the first page", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({ fetchResponse: "payload" });

  await HistoryFetcher.fetchPage(adapter, null);

  const queryCall = adapter.calls.find((c) => c.method === "buildQuery");
  assert.equal(queryCall.cursor, null);
});

test("fetchPage returns the raw response text", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({ fetchResponse: "raw-json-lines" });

  const result = await HistoryFetcher.fetchPage(adapter, null);
  assert.equal(result, "raw-json-lines");
});

test("fetchPage throws on non-OK response", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({
    fetchResponse: "error body",
    fetchOk: false,
  });

  await assert.rejects(
    HistoryFetcher.fetchPage(adapter, null),
    /HTTP 500/,
  );
});

test("fetchPage calls pageWindow.fetch with the endpoint and cloned options", async () => {
  const HistoryFetcher = loadHistoryFetcher();
  const adapter = createFakeAdapter({ fetchResponse: "payload" });

  await HistoryFetcher.fetchPage(adapter, null);

  const fetchCall = adapter.calls.find((c) => c.endpoint);
  assert.match(fetchCall.endpoint, /https:\/\/example\.com\/api/);
  assert.equal(fetchCall.options.method, "POST");
  assert.equal(fetchCall.options.credentials, "same-origin");
});

test("HistoryFetcher is frozen and cannot be modified", () => {
  const HistoryFetcher = loadHistoryFetcher();

  assert.ok(Object.isFrozen(HistoryFetcher));
  assert.throws(() => { HistoryFetcher.newMethod = () => {}; }, TypeError);
});

test("history-fetcher.js does not reference site-specific logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/history-fetcher.js"),
    "utf8",
  );

  assert.doesNotMatch(src, /gemini|Gemini|WIZ_global_data|BardChatUi|hNvQHb/i);
  assert.match(src, /fetchPage/);
  assert.match(src, /adapter/);
});
