/**
 * Download strategy pattern for generated files.
 *
 * Each strategy implements:
 *   id          — unique identifier (stored in preferences)
 *   label       — human-readable label for UI
 *   description — short description for UI
 *   async execute(context) — performs the download/export
 *
 * The context object contains:
 *   turns          — chronological Turn objects (with generatedFiles in extensions)
 *   title          — conversation title
 *   conversationId — conversation ID
 *   sourceUrl      — source URL
 *   exportedAt     — ISO timestamp
 *   diagnostics    — validation diagnostics
 *   preferences    — { includeMetadata, includeOutline }
 *   pageWindow     — page window object (for fetch with cookies)
 *   Core           — core module reference
 *   Utils          — utils module reference
 *   fflate         — fflate library reference (for ZIP strategies)
 */

const DownloadStrategies = Object.freeze({
  /**
   * List all available strategy definitions.
   * Each has: id, label, description
   */
  definitions: Object.freeze([
    {
      id: "link-only",
      label: "Link only",
      description: "Render authenticated download URLs as links (no file download)",
    },
    {
      id: "zip-bundle",
      label: "ZIP bundle",
      description: "Download generated files and bundle with markdown/JSON into a ZIP",
    },
  ]),

  /**
   * Encode a string as UTF-8 bytes without using TextEncoder.
   * On Firefox (JavaScript sandbox), TextEncoder is a page-realm object,
   * so its returned Uint8Array is in the page realm and cannot be accessed
   * by fflate (userscript realm) due to Xray restrictions.
   * @param {string} str - String to encode.
   * @returns {Uint8Array} UTF-8 bytes in the userscript realm.
   */
  strToUtf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6));
        bytes.push(0x80 | (c & 0x3f));
      } else if (c < 0xd800 || c >= 0xe000) {
        bytes.push(0xe0 | (c >> 12));
        bytes.push(0x80 | ((c >> 6) & 0x3f));
        bytes.push(0x80 | (c & 0x3f));
      } else {
        // Surrogate pair (U+10000–U+10FFFF)
        i++;
        const c2 = str.charCodeAt(i);
        const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        bytes.push(0xf0 | (cp >> 18));
        bytes.push(0x80 | ((cp >> 12) & 0x3f));
        bytes.push(0x80 | ((cp >> 6) & 0x3f));
        bytes.push(0x80 | (cp & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  },

  /**
   * Collect all generated files from all turns.
   * @param {Array} turns - Chronological Turn objects.
   * @returns {Array} Array of { turn, file } objects.
   */
  collectAllGeneratedFiles(turns) {
    const files = [];
    for (const turn of turns) {
      if (!turn.extensions) continue;
      for (const ext of turn.extensions) {
        if (!ext.generatedFiles) continue;
        for (const file of ext.generatedFiles) {
          files.push({ turn, file });
        }
      }
    }
    return files;
  },

  /**
   * Fetch a file's binary content using the page's fetch (with Google cookies).
   * @param {string} url - Download URL.
   * @param {object} pageWindow - Page window object.
   * @returns {Promise<Uint8Array>} File content as byte array.
   */
  async fetchFileContent(url, pageWindow) {
    const fetchFn = pageWindow.fetch.bind(pageWindow);
    const res = await fetchFn(url, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    // The fetch response is from the page realm. On Firefox (JavaScript sandbox),
    // TypedArrays/ArrayBuffers from the page realm cannot be accessed via Xrays.
    // FileReader.readAsArrayBuffer() also creates the ArrayBuffer in the page
    // realm, and new Response(blob).arrayBuffer() has the same issue.
    //
    // The only safe way to transfer binary data across realms is via a string
    // (primitives are not Xrayed). We read the blob as a data URL (base64 string),
    // then decode it in the userscript realm using atob() + Uint8Array.
    // This is cross-browser compatible (Chrome, Firefox, Edge).
    // Fall back to arrayBuffer() when FileReader is unavailable (e.g. Node.js).
    const blob = await res.blob();
    if (typeof FileReader !== "undefined") {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read downloaded file"));
        reader.readAsDataURL(blob);
      });
      // dataUrl is "data:<mime>;base64,<base64data>"
      const base64 = dataUrl.split(",")[1];
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    }
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  },

  /**
   * Sanitize a filename for use inside a ZIP.
   * @param {string} name - Original filename.
   * @returns {string} Sanitized filename.
   */
  sanitizeZipFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
  },

  /**
   * Build a ZIP file containing the exported content and all generated files.
   * @param {object} context - Export context (see module docs).
   * @returns {Promise<{ blob: Blob, filename: string }>} ZIP blob and filename.
   */
  async buildZipBundle(context) {
    const { turns, title, sourceUrl, conversationId, exportedAt, diagnostics,
            preferences, pageWindow, Core, fflate } = context;

    const safeTitle = Core.safeFilename(title);
    const zipData = {};

    // Generate markdown content for the ZIP
    const markdown = Core.renderMarkdown({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata: preferences.includeMetadata,
      includeOutline: preferences.includeOutline,
    });
    zipData[`${safeTitle}.md`] = DownloadStrategies.strToUtf8Bytes(markdown);

    // Generate JSON content for the ZIP
    const json = Core.renderJson({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata: preferences.includeMetadata,
    });
    zipData[`${safeTitle}.json`] = DownloadStrategies.strToUtf8Bytes(json);

    // Download generated files
    const generatedFiles = DownloadStrategies.collectAllGeneratedFiles(turns);
    const filesDir = "generated-files";
    const usedNames = new Set();

    for (const { turn, file } of generatedFiles) {
      if (!file.downloadUrl || !file.filename) continue;
      try {
        const content = await DownloadStrategies.fetchFileContent(
          file.downloadUrl,
          pageWindow,
        );
        // Avoid name collisions in the ZIP
        let name = DownloadStrategies.sanitizeZipFilename(file.filename);
        let candidate = `${filesDir}/${name}`;
        let counter = 1;
        while (usedNames.has(candidate)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          candidate = `${filesDir}/${base}-${counter}${ext}`;
          counter++;
        }
        usedNames.add(candidate);
        zipData[candidate] = content;
      } catch (err) {
        // If a file fails, include an error note but continue
        const errorName = `${filesDir}/${DownloadStrategies.sanitizeZipFilename(file.filename)}.ERROR.txt`;
        zipData[errorName] = DownloadStrategies.strToUtf8Bytes(
          `Failed to download ${file.filename}: ${err.message}\nURL: ${file.downloadUrl}\n`,
        );
      }
    }

    const zipBytes = fflate.zipSync(zipData);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const filename = `${safeTitle}.zip`;
    return { blob, filename };
  },

  /**
   * Execute a download strategy.
   * @param {string} strategyId - Strategy ID (e.g. "link-only", "zip-bundle").
   * @param {object} context - Export context (see module docs).
   * @param {string} formatId - Export format ("markdown" or "json").
   * @returns {Promise<void>}
   */
  async execute(strategyId, context, formatId) {
    switch (strategyId) {
      case "link-only":
        // Link-only: just download the text file as before.
        // The markdown/JSON already contains download links.
        return { mode: "text" };

      case "zip-bundle": {
        const { blob, filename } = await DownloadStrategies.buildZipBundle(context);
        // Trigger browser download of the ZIP
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.style.display = "none";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
        return { mode: "zip", filename };
      }

      default:
        throw new Error(`Unknown download strategy: ${strategyId}`);
    }
  },
});
