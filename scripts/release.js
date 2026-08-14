"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const changelogPath = path.join(projectRoot, "CHANGELOG.md");

// ── helpers ──────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  if (type === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`unknown bump type: ${type}`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── args ─────────────────────────────────────────────────────────────

const bumpType = process.argv[2];
if (!["patch", "minor", "major"].includes(bumpType)) {
  fail("usage: npm run release -- <patch|minor|major>");
}

// ── pre-flight checks ────────────────────────────────────────────────

const status = run("git status --porcelain");
if (status) {
  fail("working tree is not clean — commit or stash first");
}

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  fail(`must be on main (currently on ${branch})`);
}

// ── bump version ─────────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bumpType);

console.log(`release: ${oldVersion} → ${newVersion} (${bumpType})`);

pkg.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// ── build + test ─────────────────────────────────────────────────────

console.log("release: building...");
run("npm run build", { stdio: "inherit" });

console.log("release: testing...");
run("npm test", { stdio: "inherit" });

// ── generate changelog via communique ────────────────────────────────

const tag = `v${newVersion}`;
const date = today();

// Bridge OPENROUTER_API_KEY → OPENAI_API_KEY for communique's OpenAI provider.
const env = { ...process.env };
if (env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY) {
  env.OPENAI_API_KEY = env.OPENROUTER_API_KEY;
}

let changelogEntry = "";
try {
  console.log("release: generating changelog via communique...");
  changelogEntry = execSync(
    `communique generate ${tag} --concise`,
    { cwd: projectRoot, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
} catch (err) {
  console.warn("release: communique failed, using fallback changelog");
  changelogEntry = `Version ${newVersion} (${bumpType} release).`;
}

// ── update CHANGELOG.md ──────────────────────────────────────────────

const existingChangelog = fs.readFileSync(changelogPath, "utf8");
const header = "# Changelog";
const rest = existingChangelog.slice(header.length).replace(/^\n+/, "");
const newSection = `## ${newVersion} - ${date}\n\n${changelogEntry}\n`;
const updatedChangelog = `${header}\n\n${newSection}\n${rest}`;

fs.writeFileSync(changelogPath, updatedChangelog, "utf8");

// ── commit, tag, push ────────────────────────────────────────────────

console.log("release: committing...");
run(`git add package.json CHANGELOG.md dist/gemini-conversation-exporter.user.js`);
run(`git commit -m "Release v${newVersion}"`);

console.log(`release: tagging ${tag}...`);
run(`git tag ${tag}`);

console.log("release: pushing...");
run("git push");
run(`git push origin ${tag}`);

console.log(`\nrelease: done — v${newVersion} published`);
console.log(`release: create a GitHub release from tag ${tag}, or run:`);
console.log(`  communique generate ${tag} --github-release`);
