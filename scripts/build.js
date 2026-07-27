"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const corePath = path.join(projectRoot, "src", "core.js");
const mainPath = path.join(projectRoot, "src", "userscript-main.js");
const outputDirectory = path.join(projectRoot, "dist");
const outputPath = path.join(
  outputDirectory,
  "gemini-conversation-exporter.user.js",
);
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

const metadata = `// ==UserScript==
// @name         Gemini Conversation Exporter
// @namespace    local.gemini-web-exporter
// @version      ${packageJson.version}
// @description  Export the current Gemini conversation as validated Markdown using Gemini's own paginated history data.
// @author       dikelps
// @license      MIT
// @homepageURL  https://github.com/dikelps/gemini-conversation-exporter
// @supportURL   https://github.com/dikelps/gemini-conversation-exporter/issues
// @match        https://gemini.google.com/app/*
// @run-at       document-idle
// @grant        unsafeWindow
// @noframes
// ==/UserScript==
`;

const output = [
  metadata.trimEnd(),
  "",
  fs.readFileSync(corePath, "utf8").trim(),
  "",
  fs.readFileSync(mainPath, "utf8").trim(),
  "",
].join("\n");

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, output, "utf8");
console.log(`Built ${path.relative(projectRoot, outputPath)}`);
