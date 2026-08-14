/**
 * Generic Tampermonkey preference utilities.
 *
 * Provides safe wrappers around GM_getValue / GM_setValue for boolean
 * preferences with graceful fallback when the GM APIs are unavailable
 * (e.g. running outside Tampermonkey).
 */

const PreferenceStorage = Object.freeze({
  /**
   * Read a boolean preference from Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {boolean} fallback - Value returned if GM_getValue is unavailable
   *   or the stored value is not a boolean.
   * @returns {boolean}
   */
  readBoolean(key, fallback) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return typeof value === "boolean" ? value : fallback;
    } catch (error) {
      console.warn("[PreferenceStorage] Could not read preference", key, error);
      return fallback;
    }
  },

  /**
   * Write a boolean preference to Tampermonkey storage.
   *
   * @param {string} key - The preference key.
   * @param {boolean} value - The value to store.
   */
  writeBoolean(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, Boolean(value));
    } catch (error) {
      console.warn("[PreferenceStorage] Could not save preference", key, error);
    }
  },
});
