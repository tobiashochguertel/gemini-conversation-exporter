"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the module source and evaluate it in a sandbox where we can
// control the availability of GM_getValue / GM_setValue.
function loadPreferenceStorage({ gmGetValue, gmSetValue } = {}) {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/preference-storage.js"),
    "utf8",
  );

  const sandbox = {
    console: { warn: () => {} },
  };
  if (gmGetValue !== undefined) sandbox.GM_getValue = gmGetValue;
  if (gmSetValue !== undefined) sandbox.GM_setValue = gmSetValue;

  const fn = new Function("globalThis", "GM_getValue", "GM_setValue", "console", src + "\n; return PreferenceStorage;");
  return fn({}, sandbox.GM_getValue, sandbox.GM_setValue, sandbox.console);
}

test("readBoolean returns the stored boolean value", () => {
  const ps = loadPreferenceStorage({
    gmGetValue: (key, fallback) => true,
  });

  assert.equal(ps.readBoolean("ui.collapsed", false), true);
});

test("readBoolean returns fallback when stored value is not a boolean", () => {
  const ps = loadPreferenceStorage({
    gmGetValue: (key, fallback) => "not-a-boolean",
  });

  assert.equal(ps.readBoolean("ui.collapsed", false), false);
});

test("readBoolean returns fallback when GM_getValue is unavailable", () => {
  const ps = loadPreferenceStorage({ gmGetValue: undefined });

  assert.equal(ps.readBoolean("ui.collapsed", true), true);
});

test("readBoolean returns fallback when GM_getValue throws", () => {
  const ps = loadPreferenceStorage({
    gmGetValue: () => { throw new Error("storage error"); },
  });

  assert.equal(ps.readBoolean("ui.collapsed", false), false);
});

test("writeBoolean calls GM_setValue with a coerced boolean", () => {
  let captured = null;
  const ps = loadPreferenceStorage({
    gmSetValue: (key, value) => { captured = { key, value }; },
  });

  ps.writeBoolean("ui.collapsed", "yes");

  assert.deepEqual(captured, { key: "ui.collapsed", value: true });
});

test("writeBoolean is a no-op when GM_setValue is unavailable", () => {
  const ps = loadPreferenceStorage({ gmSetValue: undefined });

  // Should not throw
  ps.writeBoolean("ui.collapsed", true);
});

test("writeBoolean does not throw when GM_setValue throws", () => {
  const ps = loadPreferenceStorage({
    gmSetValue: () => { throw new Error("storage error"); },
  });

  // Should not throw
  ps.writeBoolean("ui.collapsed", true);
});

test("PreferenceStorage is frozen and cannot be modified", () => {
  const ps = loadPreferenceStorage({
    gmGetValue: () => false,
    gmSetValue: () => {},
  });

  assert.ok(Object.isFrozen(ps));
  assert.throws(() => { ps.newMethod = () => {}; }, TypeError);
});

test("readString returns stored string when GM_getValue is available", () => {
  const store = { "test.key": "debug" };
  const ps = loadPreferenceStorage({
    gmGetValue: (key, fallback) => store[key] ?? fallback,
  });

  assert.equal(ps.readString("test.key", "info"), "debug");
  assert.equal(ps.readString("missing.key", "info"), "info");
});

test("readString returns fallback when GM_getValue is unavailable", () => {
  const ps = loadPreferenceStorage();
  assert.equal(ps.readString("any.key", "warn"), "warn");
});

test("readString returns fallback when stored value is not a string", () => {
  const ps = loadPreferenceStorage({
    gmGetValue: () => 42,
  });
  assert.equal(ps.readString("test.key", "debug"), "debug");
});

test("writeString stores string via GM_setValue", () => {
  const store = {};
  const ps = loadPreferenceStorage({
    gmGetValue: (key, fallback) => store[key] ?? fallback,
    gmSetValue: (key, value) => { store[key] = value; },
  });

  ps.writeString("log.level", "none");
  assert.equal(store["log.level"], "none");
  assert.equal(typeof store["log.level"], "string");
});

test("writeString is a no-op when GM_setValue is unavailable", () => {
  const ps = loadPreferenceStorage();
  assert.doesNotThrow(() => ps.writeString("any.key", "debug"));
});

test("preference-storage.js does not reference Gemini-specific logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/preference-storage.js"),
    "utf8",
  );

  assert.doesNotMatch(src, /gemini|Gemini|WIZ_global_data|batchexecute/i);
  assert.match(src, /GM_getValue/);
  assert.match(src, /GM_setValue/);
});
