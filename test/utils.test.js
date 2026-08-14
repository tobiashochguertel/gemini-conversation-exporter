"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the module source in a sandbox with controllable globals.
function loadUtils({ cloneInto } = {}) {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/utils.js"),
    "utf8",
  );

  const fn = new Function("cloneInto", src + "\n; return Utils;");
  return fn(cloneInto);
}

test("makeRequestId returns a 7-digit string", () => {
  const utils = loadUtils();

  for (let i = 0; i < 100; i += 1) {
    const id = utils.makeRequestId();
    assert.match(id, /^\d{7}$/);
  }
});

test("makeRequestId returns different values on subsequent calls", () => {
  const utils = loadUtils();

  const ids = new Set();
  for (let i = 0; i < 100; i += 1) {
    ids.add(utils.makeRequestId());
  }
  // With 100 draws from 1M–9.99M, collisions are extremely unlikely
  assert.ok(ids.size > 90, `Expected mostly unique IDs, got ${ids.size} unique out of 100`);
});

test("cloneForPageRealm returns the value unchanged when cloneInto is unavailable", () => {
  const utils = loadUtils({ cloneInto: undefined });
  const obj = { method: "POST" };

  assert.equal(utils.cloneForPageRealm(obj, {}), obj);
});

test("cloneForPageRealm delegates to cloneInto when available", () => {
  let captured = null;
  const fakePageWindow = { __isPage: true };
  const fakeCloneInto = (value, target) => {
    captured = { value, target };
    return { ...value, __cloned: true };
  };

  const utils = loadUtils({ cloneInto: fakeCloneInto });
  const result = utils.cloneForPageRealm({ method: "POST" }, fakePageWindow);

  assert.equal(captured.target, fakePageWindow);
  assert.deepEqual(result, { method: "POST", __cloned: true });
});

test("Utils is frozen and cannot be modified", () => {
  const utils = loadUtils();

  assert.ok(Object.isFrozen(utils));
  assert.throws(() => { utils.newMethod = () => {}; }, TypeError);
});

test("utils.js does not reference Gemini-specific logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/utils.js"),
    "utf8",
  );

  assert.doesNotMatch(src, /gemini|Gemini|WIZ_global_data|batchexecute/i);
  assert.match(src, /makeRequestId/);
  assert.match(src, /cloneForPageRealm/);
  assert.match(src, /downloadTextFile/);
});
