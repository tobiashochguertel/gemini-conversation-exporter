const ROOT_ID = "gemini-web-exporter-root";
const HISTORY_PAGE_SIZE = 50;
const PREFERENCE_KEYS = Object.freeze({
  collapsed: "ui.collapsed",
  includeMetadata: "export.includeMetadata",
  includeOutline: "export.includeOutline",
  logLevel: "debug.logLevel",
});

const LOG_LEVELS = Object.freeze({
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

  const log = {
    level: LOG_LEVELS[
      PreferenceStorage.readString(PREFERENCE_KEYS.logLevel, "debug")
    ] ?? LOG_LEVELS.debug,

    error(...args) {
      if (this.level >= LOG_LEVELS.error) console.error("[Gemini Exporter]", ...args);
    },
    warn(...args) {
      if (this.level >= LOG_LEVELS.warn) console.warn("[Gemini Exporter]", ...args);
    },
    info(...args) {
      if (this.level >= LOG_LEVELS.info) console.info("[Gemini Exporter]", ...args);
    },
    debug(...args) {
      if (this.level >= LOG_LEVELS.debug) console.debug("[Gemini Exporter]", ...args);
    },
    setLevel(name) {
      const level = LOG_LEVELS[name];
      if (level === undefined) {
        console.warn("[Gemini Exporter] unknown log level:", name);
        return;
      }
      this.level = level;
      PreferenceStorage.writeString(PREFERENCE_KEYS.logLevel, name);
      console.info("[Gemini Exporter] log level set to", name);
    },
  };

  // Expose for console access: log.setLevel("none"), log.setLevel("debug"), etc.
  globalThis.GeminiExporter = { log };

  function isConversationPage() {
    return Core.conversationIdFromPath(location.pathname) !== null;
  }

  function getGeminiConfig() {
    const config = pageWindow.WIZ_global_data;
    const required = ["cfb2h", "FdrFJe", "SNlM0e"];

    if (
      !config ||
      required.some(
        (key) => typeof config[key] !== "string" || config[key].length === 0,
      )
    ) {
      throw new Error(
        "Gemini's page configuration is not ready. Reload the conversation and try again.",
      );
    }

    return config;
  }

  function createGeminiAdapter(conversationId) {
    return {
      pageWindow,

      getConfig() {
        return getGeminiConfig();
      },

      buildQuery(config, cursor) {
        const query = new URLSearchParams({
          rpcids: Core.HISTORY_RPC_ID,
          "source-path": location.pathname,
          bl: config.cfb2h,
          "f.sid": config.FdrFJe,
          hl: (document.documentElement.lang || "en").split("-")[0],
          _reqid: Utils.makeRequestId(),
          rt: "c",
        });
        const pageId = new URLSearchParams(location.search).get("pageId");
        if (pageId) {
          query.set("pageId", pageId);
        }
        return query;
      },

      buildBody(config, cursor) {
        const rpcArguments = [
          conversationId,
          HISTORY_PAGE_SIZE,
          cursor,
          1,
          [0],
          [4],
          null,
          1,
        ];
        const rpcCall = [
          Core.HISTORY_RPC_ID,
          JSON.stringify(rpcArguments),
          null,
          "generic",
        ];
        const body = new URLSearchParams({
          "f.req": JSON.stringify([[rpcCall]]),
          at: config.SNlM0e,
        });
        return body.toString();
      },

      buildEndpoint(query) {
        const endpointPath = Core.accountScopedPath(
          location.pathname,
          "/_/BardChatUi/data/batchexecute",
        );
        const endpoint = new URL(endpointPath, location.origin);
        endpoint.search = query.toString();
        return endpoint.toString();
      },

      buildFetchOptions(body) {
        return {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1",
          },
          body,
        };
      },
    };
  }

  async function fetchHistoryPage(conversationId, cursor) {
    const adapter = createGeminiAdapter(conversationId);
    return HistoryFetcher.fetchPage(adapter, cursor);
  }

  // ── UI assembly + export logic ─────────────────────────────────────────

  const preferences = {
    collapsed: PreferenceStorage.readBoolean(PREFERENCE_KEYS.collapsed, false),
    includeMetadata: PreferenceStorage.readBoolean(
      PREFERENCE_KEYS.includeMetadata,
      true,
    ),
    includeOutline: PreferenceStorage.readBoolean(
      PREFERENCE_KEYS.includeOutline,
      true,
    ),
  };

  const { host, shadow } = Ui.createShadowRoot(ROOT_ID, __EXPORTER_UI_CSS__);
  const toast = Ui.createToast();
  const optionsPanel = Ui.createOptionsPanel({
    heading: "Export options",
    ariaLabel: "Export options",
    options: [
      {
        label: "Conversation outline",
        description: "Linked turn list with short prompt previews",
        checked: preferences.includeOutline,
        onChange(value) {
          preferences.includeOutline = value;
          PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeOutline, value);
        },
      },
      {
        label: "Export metadata",
        description: "Source, export details, validation and turn IDs",
        checked: preferences.includeMetadata,
        onChange(value) {
          preferences.includeMetadata = value;
          PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeMetadata, value);
        },
      },
    ],
  });
  const exportControl = Ui.createExportControl({
    buttons: [
      { label: "Export Markdown", ariaLabel: "Export Markdown", icon: "↓" },
      { label: "Export JSON", ariaLabel: "Export JSON", icon: "{ }" },
    ],
    menuAriaLabel: "Export options",
  });

  const stack = Ui.createStack("stack", toast.element, optionsPanel.panel, exportControl.control);
  shadow.append(stack);

  function setPanelOpen(open) {
    log.debug("setPanelOpen", open);
    optionsPanel.setOpen(open);
    exportControl.setMenuExpanded(open);
  }

  function setCollapsed(collapsed, persist = true) {
    log.debug("setCollapsed", { collapsed, persist });
    preferences.collapsed = collapsed;
    exportControl.setCollapsed(collapsed, { titles: ["Export Markdown", "Export JSON"] });
    optionsPanel.setCompactToggleLabel(
      collapsed ? "Use expanded control" : "Use compact control",
    );
    if (persist) {
      PreferenceStorage.writeBoolean(PREFERENCE_KEYS.collapsed, collapsed);
    }
  }

  const EXPORT_FORMATS = [
    { id: "markdown", label: "Export Markdown", icon: "↓", extension: "md" },
    { id: "json", label: "Export JSON", icon: "{ }", extension: "json" },
  ];

  async function exportCurrentConversation(formatIndex) {
    const fmt = EXPORT_FORMATS[formatIndex];
    if (!fmt) return;

    const conversationId = Core.conversationIdFromPath(location.pathname);
    if (!conversationId) {
      toast.show("Open a Gemini conversation before exporting.", "error");
      return;
    }

    setPanelOpen(false);
    exportControl.setBusy(true, formatIndex, {
      icon: "…",
      label: "Exporting…",
      ariaLabel: "Exporting",
    });

    try {
      const history = await Core.collectHistoryPages((cursor) =>
        fetchHistoryPage(conversationId, cursor),
      );
      const turns = Core.historyToChronologicalTurns(
        history.rawTurnsNewestFirst,
      );
      const diagnostics = Core.validateConversation(turns);
      const title = Core.cleanDocumentTitle(document.title);
      const exportedAt = new Date().toISOString();

      let content;
      let filename;
      if (fmt.id === "json") {
        content = Core.renderJson({
          title,
          sourceUrl: location.href,
          conversationId,
          exportedAt,
          turns,
          diagnostics,
          includeMetadata: preferences.includeMetadata,
        });
        filename = Core.safeFilename(title, fmt.extension);
      } else {
        content = Core.renderMarkdown({
          title,
          sourceUrl: location.href,
          conversationId,
          exportedAt,
          turns,
          diagnostics,
          includeMetadata: preferences.includeMetadata,
          includeOutline: preferences.includeOutline,
        });
        filename = Core.safeFilename(title, fmt.extension);
      }

      Utils.downloadTextFile(content, filename);
      log.info(`${fmt.label} complete`, {
        filename,
        format: fmt.id,
        pages: history.pages.length,
        ...diagnostics,
      });
      toast.show(
        `Exported ${turns.length} turns from ${history.pages.length} page${
          history.pages.length === 1 ? "" : "s"
        }. Validation: ${diagnostics.fingerprint}.`,
      );
    } catch (error) {
      log.error("Export failed", error);
      toast.show(
        `Export stopped: ${error instanceof Error ? error.message : String(error)}`,
        "error",
        15_000,
      );
    } finally {
      exportControl.setBusy(false, formatIndex, {
        icon: fmt.icon,
        label: fmt.label,
        ariaLabel: fmt.label,
      });
    }
  }

  exportControl.buttons[0].addEventListener("click", () => {
    log.debug("markdown export button clicked");
    exportCurrentConversation(0);
  });
  exportControl.buttons[1].addEventListener("click", () => {
    log.debug("json export button clicked");
    exportCurrentConversation(1);
  });
  exportControl.menuButton.addEventListener("click", () => {
    log.debug("menu button clicked, panel.hidden =", optionsPanel.panel.hidden);
    setPanelOpen(optionsPanel.panel.hidden);
  });
  optionsPanel.compactToggle.addEventListener("click", () => {
    log.debug("compact toggle clicked, collapsed =", preferences.collapsed);
    setCollapsed(!preferences.collapsed);
    setPanelOpen(false);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().includes(host)) {
        if (!optionsPanel.panel.hidden) {
          log.debug("outside pointerdown, closing panel");
        }
        setPanelOpen(false);
      }
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      log.debug("Escape pressed, closing panel");
      setPanelOpen(false);
    }
  });

  setCollapsed(preferences.collapsed, false);
  document.documentElement.append(host);

  function syncRoute() {
    host.style.display = isConversationPage() ? "block" : "none";
  }

  syncRoute();
  setInterval(syncRoute, 1_000);
})();
