/**
 * Generic browser and Tampermonkey utility functions.
 *
 * These helpers are not specific to any particular site — they provide
 * cross-realm cloning, random ID generation, and file download support.
 */

const Utils = Object.freeze({
  /**
   * Generate a random 7-digit request ID string.
   *
   * Used for Google RPC request correlation. Not cryptographically unique.
   *
   * @returns {string}
   */
  makeRequestId() {
    return String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  },

  /**
   * Clone a value into the page realm for Firefox cross-realm safety.
   *
   * Firefox's security boundary requires objects passed to page APIs
   * (e.g. fetch options) to originate from the page realm. `cloneInto`
   * is a Firefox/Tampermonkey global; on other browsers it is undefined
   * and the value is returned as-is.
   *
   * @param {*} value - The value to clone.
   * @param {object} pageWindow - The page's window object (unsafeWindow).
   * @returns {*}
   */
  cloneForPageRealm(value, pageWindow) {
    return typeof cloneInto === "function"
      ? cloneInto(value, pageWindow)
      : value;
  },

  /**
   * Trigger a browser download of a text file.
   *
   * Creates a Blob, generates an object URL, programmatically clicks
   * a temporary anchor element, and revokes the URL after 30 seconds.
   *
   * @param {string} content - The file content.
   * @param {string} filename - The download filename.
   * @param {string} [mimeType="text/markdown;charset=utf-8"] - The MIME type.
   */
  downloadTextFile(content, filename, mimeType = "text/markdown;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  },
});
