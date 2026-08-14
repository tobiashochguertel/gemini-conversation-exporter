"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const changelogPath = path.join(projectRoot, "CHANGELOG.md");

// ── helpers ──────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  const result = execSync(cmd, { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
  return result ? result.trim() : "";
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

// ── conventional commit bump detection ───────────────────────────────

/**
 * Determine the semver bump level from conventional commits since the
 * last tag. Returns "major", "minor", "patch", or null if no commits.
 *
 * Conventional Commits spec:
 *   BREAKING CHANGE footer or !:  → major
 *   feat:                          → minor
 *   fix:, chore:, etc.             → patch
 */
function detectBumpFromCommits() {
  let range;
  try {
    const lastTag = run("git describe --tags --abbrev=0");
    range = `${lastTag}..HEAD`;
  } catch {
    // No tags yet — treat all commits as the range.
    range = "HEAD";
  }

  const log = run(`git log ${range} --pretty=format:"%s%n%b%n---END---"`);

  const commits = log.split("\n---END---").map((c) => c.trim()).filter(Boolean);
  if (commits.length === 0) return null;

  let level = "patch";
  for (const commit of commits) {
    const [subject, ...bodyLines] = commit.split("\n");
    const body = bodyLines.join("\n");

    // Breaking change: "feat!:" / "fix!:" or "BREAKING CHANGE:" footer
    // The footer is the last paragraph of the body, separated by a blank line.
    const footer = body.split(/\n\s*\n/).pop() || "";
    if (/^[a-z]+!:/.test(subject) || /^BREAKING[ -]CHANGE:/im.test(footer)) {
      return "major";
    }
    // New feature
    if (/^feat(?:\(.+\))?:/.test(subject)) {
      level = "minor";
    }
  }

  return level;
}

// ── args ─────────────────────────────────────────────────────────────

let bumpType = process.argv[2];

if (bumpType === "auto" || !bumpType) {
  const detected = detectBumpFromCommits();
  if (!detected) {
    fail("no commits found since last tag — specify bump type explicitly");
  }
  console.log(`release: detected bump level "${detected}" from conventional commits`);
  bumpType = detected;
}

if (!["patch", "minor", "major"].includes(bumpType)) {
  fail("usage: npm run release -- [patch|minor|major|auto]");
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
// Always override when OPENROUTER_API_KEY is set, since communique.toml
// points base_url at OpenRouter — an existing OPENAI_API_KEY (for the real
// OpenAI API) would cause a 401 against OpenRouter.
const env = { ...process.env };
if (env.OPENROUTER_API_KEY) {
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
run(`git commit -m "chore: release v${newVersion}"`, { env: { ...process.env, HK: "0" } });

console.log(`release: tagging ${tag}...`);
run(`git tag ${tag}`);

console.log("release: pushing...");
run("git push");
run(`git push origin ${tag}`);

console.log(`\nrelease: done — v${newVersion} published`);
console.log(`release: create a GitHub release from tag ${tag}, or run:`);
console.log(`  communique generate ${tag} --github-release`);
