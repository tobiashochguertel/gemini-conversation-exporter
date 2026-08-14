"use strict";

const fs = require("node:fs");
const path = require("node:path");
const UserscriptMetadata = require("../src/userscript-metadata");

const projectRoot = path.resolve(__dirname, "..");
const src = (...parts) => path.join(projectRoot, "src", ...parts);
const dist = (...parts) => path.join(projectRoot, "dist", ...parts);
const readSrc = (file) => fs.readFileSync(src(file), "utf8").trim();

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const outputName = `${packageJson.name}.user.js`;
const distPath = `dist/${outputName}`;

const metadata = UserscriptMetadata.build(packageJson, { distPath });

// Module concatenation order: metadata → core → preference-storage →
// utils → history-fetcher → ui → userscript-main.
const modules = [
  metadata,
  readSrc("core.js"),
  readSrc("preference-storage.js"),
  readSrc("utils.js"),
  readSrc("history-fetcher.js"),
  readSrc("ui.js"),
  readSrc("userscript-main.js"),
];

// Inline external CSS into the userscript via a build-time token.
const cssToken = "__EXPORTER_UI_CSS__";
const cssContent = JSON.stringify(readSrc("exporter-ui.css"));

const output = `${modules
  .map((m) => m.trim())
  .join("\n\n")
  .replace(cssToken, cssContent)}\n`;

fs.mkdirSync(dist(), { recursive: true });
fs.writeFileSync(dist(outputName), output, "utf8");
console.log(`Built ${distPath}`);
