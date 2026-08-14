"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const corePath = path.join(projectRoot, "src", "core.js");
const mainPath = path.join(projectRoot, "src", "userscript-main.js");
const cssPath = path.join(projectRoot, "src", "exporter-ui.css");
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
// @match        https://gemini.google.com/*
// @match        https://gemini.google.com/app
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/u/*/app
// @match        https://gemini.google.com/u/*/app/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      JavaScript
// @noframes
// ==/UserScript==
`;

const cssContent = fs.readFileSync(cssPath, "utf8").trim();
const mainContent = fs.readFileSync(mainPath, "utf8")
  .replace("__EXPORTER_UI_CSS__", JSON.stringify(cssContent));

const output = [
  metadata.trimEnd(),
  "",
  fs.readFileSync(corePath, "utf8").trim(),
  "",
  mainContent.trim(),
  "",
].join("\n");

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, output, "utf8");
console.log(`Built ${path.relative(projectRoot, outputPath)}`);
