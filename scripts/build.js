"use strict";

const fs = require("node:fs");
const path = require("node:path");
const UserscriptMetadata = require("../src/userscript-metadata");

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

const metadata = UserscriptMetadata.build(packageJson, {
  distPath: "dist/gemini-conversation-exporter.user.js",
});

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
