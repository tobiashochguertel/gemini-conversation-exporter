"use strict";

/**
 * Userscript metadata generator.
 *
 * Derives a UserScript metadata block (the `// ==UserScript==` header)
 * from a package.json object. All site-specific fields live in a
 * `userscript` section of package.json; standard npm fields
 * (author, license, homepage, repository, bugs) are mapped to their
 * UserScript equivalents.
 *
 * @example
 *   const meta = UserscriptMetadata.build(packageJson);
 *   // → "// ==UserScript==\n// @name ...\n// ==/UserScript==\n"
 */

const UserscriptMetadata = Object.freeze({
  /**
   * Build a UserScript metadata block from a package.json object.
   *
   * @param {object} packageJson - Parsed package.json.
   * @param {object} packageJson.userscript - Userscript-specific config.
   * @param {string} packageJson.userscript.name - Script name.
   * @param {string} packageJson.userscript.namespace - Script namespace.
   * @param {string} packageJson.userscript.description - Script description.
   * @param {string[]} packageJson.userscript.match - @match URL patterns.
   * @param {string[]} packageJson.userscript.grant - @grant directives.
   * @param {string} packageJson.userscript["run-at"] - Run timing.
   * @param {string} packageJson.userscript.sandbox - Sandbox mode.
   * @param {boolean} [packageJson.userscript.noframes] - Add @noframes.
   * @param {string} packageJson.version - Semver version.
   * @param {string} packageJson.author - Author name.
   * @param {string[]} [packageJson.contributors] - Contributor strings.
   * @param {string} packageJson.license - License identifier.
   * @param {string} packageJson.homepage - Homepage URL.
   * @param {object} packageJson.repository - Repository info.
   * @param {string} packageJson.repository.url - Git URL.
   * @param {object} packageJson.bugs - Bug tracker info.
   * @param {string} packageJson.bugs.url - Bug tracker URL.
   * @param {object} [options] - Build options.
   * @param {string} [options.distPath] - Path to the built .user.js file
   *   relative to the repo root, used for @downloadURL/@updateURL.
   *   Defaults to `dist/<name>.user.js`.
   * @param {string} [options.branch] - Branch name for raw URLs.
   *   Defaults to `main`.
   * @returns {string} The full metadata block including trailing newline.
   */
  build(packageJson, options = {}) {
    const us = packageJson.userscript;
    if (!us) {
      throw new Error("package.json is missing a 'userscript' section");
    }

    const repoUrl = packageJson.repository.url.replace(/\.git$/, "");
    const rawBase = repoUrl.replace("github.com", "raw.githubusercontent.com");
    const branch = options.branch || "main";
    const distPath = options.distPath || `dist/${packageJson.name}.user.js`;
    const rawUrl = `${rawBase}/${branch}/${distPath}`;

    const lines = [
      "// ==UserScript==",
      `// @name         ${us.name}`,
      `// @namespace    ${us.namespace}`,
      `// @version      ${packageJson.version}`,
      `// @description  ${us.description}`,
      `// @author       ${packageJson.author}`,
    ];

    for (const contributor of packageJson.contributors || []) {
      lines.push(`// @contributor  ${contributor}`);
    }

    lines.push(
      `// @license      ${packageJson.license}`,
      `// @homepageURL  ${packageJson.homepage}`,
      `// @supportURL   ${packageJson.bugs.url}`,
      `// @downloadURL  ${rawUrl}`,
      `// @updateURL    ${rawUrl}`,
    );

    for (const match of us.match) {
      lines.push(`// @match        ${match}`);
    }

    if (us["run-at"]) {
      lines.push(`// @run-at       ${us["run-at"]}`);
    }

    for (const grant of us.grant) {
      lines.push(`// @grant        ${grant}`);
    }

    if (us.sandbox) {
      lines.push(`// @sandbox      ${us.sandbox}`);
    }

    if (us.noframes) {
      lines.push("// @noframes");
    }

    lines.push("// ==/UserScript==");

    return lines.join("\n") + "\n";
  },
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = UserscriptMetadata;
}
