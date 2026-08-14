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

// Derive userscript metadata from package.json fields.
const us = packageJson.userscript;
const repoUrl = packageJson.repository.url.replace(/\.git$/, "");
const rawUrl = `${repoUrl.replace("github.com", "raw.githubusercontent.com")}/main/dist/gemini-conversation-exporter.user.js`;

const metadataLines = [
  "// ==UserScript==",
  `// @name         ${us.name}`,
  `// @namespace    ${us.namespace}`,
  `// @version      ${packageJson.version}`,
  `// @description  ${us.description}`,
  `// @author       ${packageJson.author}`,
];
for (const contributor of packageJson.contributors || []) {
  metadataLines.push(`// @contributor  ${contributor}`);
}
metadataLines.push(
  `// @license      ${packageJson.license}`,
  `// @homepageURL  ${packageJson.homepage}`,
  `// @supportURL   ${packageJson.bugs.url}`,
  `// @downloadURL  ${rawUrl}`,
  `// @updateURL    ${rawUrl}`,
);
for (const match of us.match) {
  metadataLines.push(`// @match        ${match}`);
}
metadataLines.push(`// @run-at       ${us["run-at"]}`);
for (const grant of us.grant) {
  metadataLines.push(`// @grant        ${grant}`);
}
metadataLines.push(`// @sandbox      ${us.sandbox}`);
if (us.noframes) {
  metadataLines.push("// @noframes");
}
metadataLines.push("// ==/UserScript==");

const metadata = metadataLines.join("\n") + "\n";

const preferenceStoragePath = path.join(projectRoot, "src", "preference-storage.js");
const utilsPath = path.join(projectRoot, "src", "utils.js");
const historyFetcherPath = path.join(projectRoot, "src", "history-fetcher.js");
const uiPath = path.join(projectRoot, "src", "ui.js");

const cssContent = fs.readFileSync(cssPath, "utf8").trim();
const mainContent = fs.readFileSync(mainPath, "utf8")
  .replace("__EXPORTER_UI_CSS__", JSON.stringify(cssContent));

const output = [
  metadata.trimEnd(),
  "",
  fs.readFileSync(corePath, "utf8").trim(),
  "",
  fs.readFileSync(preferenceStoragePath, "utf8").trim(),
  "",
  fs.readFileSync(utilsPath, "utf8").trim(),
  "",
  fs.readFileSync(historyFetcherPath, "utf8").trim(),
  "",
  fs.readFileSync(uiPath, "utf8").trim(),
  "",
  mainContent.trim(),
  "",
].join("\n");

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, output, "utf8");
console.log(`Built ${path.relative(projectRoot, outputPath)}`);
