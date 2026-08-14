"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadLogger() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/logger.js"),
    "utf8",
  );
  const fn = new Function(src + "\n; return Logger;");
  return fn();
}

test("Logger.create returns a logger with all methods", () => {
  const Logger = loadLogger();
  const log = Logger.create({ tag: "[Test]" });
  assert.equal(typeof log.error, "function");
  assert.equal(typeof log.warn, "function");
  assert.equal(typeof log.info, "function");
  assert.equal(typeof log.debug, "function");
  assert.equal(typeof log.setLevel, "function");
});

test("Logger.create defaults to debug level", () => {
  const Logger = loadLogger();
  const log = Logger.create({ tag: "[Test]" });
  assert.equal(log.level, Logger.LEVELS.debug);
});

test("Logger.create accepts a custom initial level", () => {
  const Logger = loadLogger();
  const log = Logger.create({ tag: "[Test]", level: "warn" });
  assert.equal(log.level, Logger.LEVELS.warn);
});

test("setLevel changes the level", () => {
  const Logger = loadLogger();
  const log = Logger.create({ tag: "[Test]", level: "debug" });
  log.setLevel("error");
  assert.equal(log.level, Logger.LEVELS.error);
});

test("setLevel persists via storage adapter", () => {
  const Logger = loadLogger();
  const written = {};
  const storage = {
    readString(key, fallback) { return written[key] ?? fallback; },
    writeString(key, value) { written[key] = value; },
  };
  const log = Logger.create({
    tag: "[Test]",
    level: "debug",
    storage,
    storageKey: "test.logLevel",
  });
  log.setLevel("warn");
  assert.equal(written["test.logLevel"], "warn");
  assert.equal(log.level, Logger.LEVELS.warn);
});

test("Logger.create reads initial level from storage", () => {
  const Logger = loadLogger();
  const storage = {
    readString() { return "error"; },
    writeString() {},
  };
  const log = Logger.create({
    tag: "[Test]",
    level: "debug",
    storage,
    storageKey: "test.logLevel",
  });
  assert.equal(log.level, Logger.LEVELS.error);
});

test("setLevel ignores unknown level names", () => {
  const Logger = loadLogger();
  const log = Logger.create({ tag: "[Test]", level: "debug" });
  log.setLevel("bogus");
  assert.equal(log.level, Logger.LEVELS.debug);
});

test("Logger is frozen and cannot be modified", () => {
  const Logger = loadLogger();
  assert.ok(Object.isFrozen(Logger));
});

test("logger.js does not reference Gemini-specific logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/logger.js"),
    "utf8",
  );
  assert.doesNotMatch(src, /gemini|Gemini|Bard|batchexecute/i);
});
