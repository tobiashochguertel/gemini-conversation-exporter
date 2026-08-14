/**
 * Generic configurable logger for userscripts.
 *
 * Provides leveled logging (none, error, warn, info, debug) with an
 * optional persistence layer. The logger is not specific to any site —
 * it accepts a tag prefix and a storage adapter so it can be reused
 * across different userscripts.
 *
 * Usage:
 *   const log = Logger.create({
 *     tag: "[My Script]",
 *     level: "debug",
 *     storage: PreferenceStorage,  // optional: must expose readString/writeString
 *     storageKey: "myScript.logLevel",
 *   });
 *   log.info("hello");
 *   log.setLevel("warn");
 */

const Logger = Object.freeze({
  /**
   * Log level name → numeric value mapping.
   */
  LEVELS: Object.freeze({
    none: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
  }),

  /**
   * Create a logger instance.
   *
   * @param {object} opts
   * @param {string} opts.tag - Prefix string prepended to every message.
   * @param {string} [opts.level="debug"] - Initial log level name.
   * @param {object} [opts.storage] - Optional storage adapter with
   *   `readString(key, fallback)` and `writeString(key, value)`.
   * @param {string} [opts.storageKey] - Key for persisting the level
   *   via the storage adapter. Required if `storage` is provided.
   * @returns {{ level: number, error: Function, warn: Function, info: Function, debug: Function, setLevel: Function }}
   */
  create({ tag, level = "debug", storage, storageKey }) {
    const levels = Logger.LEVELS;
    const initialLevel =
      storage && storageKey
        ? levels[storage.readString(storageKey, level)] ?? levels[level]
        : levels[level] ?? levels.debug;

    const instance = {
      level: initialLevel,

      error(...args) {
        if (this.level >= levels.error) console.error(tag, ...args);
      },
      warn(...args) {
        if (this.level >= levels.warn) console.warn(tag, ...args);
      },
      info(...args) {
        if (this.level >= levels.info) console.info(tag, ...args);
      },
      debug(...args) {
        if (this.level >= levels.debug) console.debug(tag, ...args);
      },

      setLevel(name) {
        const value = levels[name];
        if (value === undefined) {
          console.warn(tag, "unknown log level:", name);
          return;
        }
        this.level = value;
        if (storage && storageKey) {
          storage.writeString(storageKey, name);
        }
        console.info(tag, "log level set to", name);
      },
    };

    return instance;
  },
});
