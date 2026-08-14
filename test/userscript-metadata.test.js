"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const UserscriptMetadata = require("../src/userscript-metadata");

const samplePackageJson = {
  name: "test-userscript",
  version: "1.2.3",
  author: "alice",
  contributors: ["bob <bob@example.com>", "carol (designer)"],
  license: "MIT",
  homepage: "https://github.com/alice/test-userscript",
  repository: {
    type: "git",
    url: "https://github.com/alice/test-userscript.git",
  },
  bugs: {
    url: "https://github.com/alice/test-userscript/issues",
  },
  userscript: {
    name: "Test Userscript",
    namespace: "local.test",
    description: "A test userscript for testing.",
    match: [
      "https://example.com/*",
      "https://example.com/app",
    ],
    grant: ["unsafeWindow", "GM_getValue", "GM_setValue"],
    "run-at": "document-start",
    sandbox: "raw",
    noframes: true,
  },
};

function parseMetadata(metadata) {
  const lines = metadata.trim().split("\n");
  const map = {};
  const multi = {};
  for (const line of lines) {
    const match = line.match(/^\/\/ @(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (map[key] !== undefined) {
      (multi[key] ||= [map[key]]).push(value);
      map[key] = multi[key];
    } else {
      map[key] = value;
    }
  }
  return map;
}

test("build produces a valid UserScript metadata block", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);

  assert.match(meta, /^\/\/ ==UserScript==/);
  assert.match(meta, /\/\/ ==\/UserScript==/);
});

test("build maps standard package.json fields to metadata", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const parsed = parseMetadata(meta);

  assert.equal(parsed.name, "Test Userscript");
  assert.equal(parsed.namespace, "local.test");
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.description, "A test userscript for testing.");
  assert.equal(parsed.author, "alice");
  assert.equal(parsed.license, "MIT");
  assert.equal(parsed.homepageURL, "https://github.com/alice/test-userscript");
  assert.equal(parsed.supportURL, "https://github.com/alice/test-userscript/issues");
});

test("build includes contributors as @contributor directives", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const lines = meta.split("\n");

  assert.ok(lines.some((l) => l.includes("@contributor  bob <bob@example.com>")));
  assert.ok(lines.some((l) => l.includes("@contributor  carol (designer)")));
});

test("build generates @downloadURL and @updateURL from repository URL", () => {
  const meta = UserscriptMetadata.build(samplePackageJson, {
    distPath: "dist/test-userscript.user.js",
  });
  const parsed = parseMetadata(meta);

  const expected = "https://raw.githubusercontent.com/alice/test-userscript/main/dist/test-userscript.user.js";
  assert.equal(parsed.downloadURL, expected);
  assert.equal(parsed.updateURL, expected);
});

test("build supports custom branch for raw URLs", () => {
  const meta = UserscriptMetadata.build(samplePackageJson, {
    distPath: "dist/test.user.js",
    branch: "stable",
  });
  const parsed = parseMetadata(meta);

  assert.match(parsed.downloadURL, /\/stable\/dist\/test\.user\.js$/);
  assert.match(parsed.updateURL, /\/stable\/dist\/test\.user\.js$/);
});

test("build defaults distPath to dist/<name>.user.js", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const parsed = parseMetadata(meta);

  assert.match(parsed.downloadURL, /\/dist\/test-userscript\.user\.js$/);
});

test("build includes all @match patterns", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const matchLines = meta.split("\n").filter((l) => l.startsWith("// @match"));

  assert.equal(matchLines.length, 2);
  assert.match(matchLines[0], /example\.com\/\*/);
  assert.match(matchLines[1], /example\.com\/app/);
});

test("build includes all @grant directives", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const grantLines = meta.split("\n").filter((l) => l.startsWith("// @grant"));

  assert.equal(grantLines.length, 3);
  assert.ok(grantLines.some((l) => l.includes("unsafeWindow")));
  assert.ok(grantLines.some((l) => l.includes("GM_getValue")));
  assert.ok(grantLines.some((l) => l.includes("GM_setValue")));
});

test("build includes @run-at, @sandbox, and @noframes when configured", () => {
  const meta = UserscriptMetadata.build(samplePackageJson);
  const parsed = parseMetadata(meta);

  assert.equal(parsed["run-at"], "document-start");
  assert.equal(parsed.sandbox, "raw");
  assert.ok(meta.includes("// @noframes"));
});

test("build omits @noframes when not configured", () => {
  const pkg = JSON.parse(JSON.stringify(samplePackageJson));
  delete pkg.userscript.noframes;
  const meta = UserscriptMetadata.build(pkg);

  assert.doesNotMatch(meta, /@noframes/);
});

test("build omits @run-at when not configured", () => {
  const pkg = JSON.parse(JSON.stringify(samplePackageJson));
  delete pkg.userscript["run-at"];
  const meta = UserscriptMetadata.build(pkg);

  assert.doesNotMatch(meta, /@run-at/);
});

test("build throws when userscript section is missing", () => {
  assert.throws(
    () => UserscriptMetadata.build({ name: "test", version: "1.0.0" }),
    /missing a 'userscript' section/,
  );
});

test("build handles package.json without contributors", () => {
  const pkg = JSON.parse(JSON.stringify(samplePackageJson));
  delete pkg.contributors;
  const meta = UserscriptMetadata.build(pkg);

  assert.doesNotMatch(meta, /@contributor/);
});

test("build handles package.json without sandbox", () => {
  const pkg = JSON.parse(JSON.stringify(samplePackageJson));
  delete pkg.userscript.sandbox;
  const meta = UserscriptMetadata.build(pkg);

  assert.doesNotMatch(meta, /@sandbox/);
});

test("UserscriptMetadata is frozen and cannot be modified", () => {
  assert.ok(Object.isFrozen(UserscriptMetadata));
  assert.throws(() => { UserscriptMetadata.newMethod = () => {}; }, TypeError);
});

test("userscript-metadata.js does not reference Gemini-specific logic", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    require("node:path").resolve(__dirname, "../src/userscript-metadata.js"),
    "utf8",
  );

  assert.doesNotMatch(src, /gemini|Gemini|WIZ_global_data|BardChatUi/i);
  assert.match(src, /UserscriptMetadata/);
  assert.match(src, /==UserScript==/);
});
