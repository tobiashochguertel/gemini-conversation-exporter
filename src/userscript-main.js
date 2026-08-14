const ROOT_ID = "gemini-web-exporter-root";
const HISTORY_PAGE_SIZE = 50;
const PREFERENCE_KEYS = Object.freeze({
  collapsed: "ui.collapsed",
  includeMetadata: "export.includeMetadata",
  includeOutline: "export.includeOutline",
});

(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

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

  // ── UI builder functions ──────────────────────────────────────────────

  function createShadowRoot(rootId, cssText) {
    const host = document.createElement("div");
    host.id = rootId;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.append(style);
    return { host, shadow };
  }

  function createToast() {
    const element = document.createElement("div");
    element.className = "toast";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    let timer = null;

    function show(message, kind = "success", duration = 8_000) {
      clearTimeout(timer);
      element.textContent = message;
      element.dataset.kind = kind;
      element.style.display = "block";
      timer = setTimeout(() => {
        element.style.display = "none";
      }, duration);
    }

    return { element, show };
  }

  function createCheckboxOption({ label, description, checked, onChange }) {
    const option = document.createElement("label");
    option.className = "option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));

    const copy = document.createElement("span");
    copy.className = "option-copy";

    const optionLabel = document.createElement("span");
    optionLabel.className = "option-label";
    optionLabel.textContent = label;

    const optionDescription = document.createElement("span");
    optionDescription.className = "option-description";
    optionDescription.textContent = description;

    copy.append(optionLabel, optionDescription);
    option.append(input, copy);
    return { option, input };
  }

  function createExportControl() {
    const control = document.createElement("div");
    control.className = "control";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "export-button";
    exportButton.setAttribute("aria-label", "Export Markdown");

    const downloadIcon = document.createElement("span");
    downloadIcon.className = "download-icon";
    downloadIcon.setAttribute("aria-hidden", "true");
    downloadIcon.textContent = "↓";

    const exportLabel = document.createElement("span");
    exportLabel.className = "export-label";
    exportLabel.textContent = "Export Markdown";

    exportButton.append(downloadIcon, exportLabel);

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "menu-button";
    menuButton.textContent = "⋮";
    menuButton.setAttribute("aria-label", "Export options");
    menuButton.setAttribute("aria-haspopup", "dialog");
    menuButton.setAttribute("aria-expanded", "false");

    control.append(exportButton, menuButton);
    return { control, exportButton, menuButton, downloadIcon, exportLabel };
  }

  function createOptionsPanel(preferences) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Export options");

    const panelHeading = document.createElement("p");
    panelHeading.className = "panel-heading";
    panelHeading.textContent = "Export options";

    const outlineOption = createCheckboxOption({
      label: "Conversation outline",
      description: "Linked turn list with short prompt previews",
      checked: preferences.includeOutline,
      onChange(value) {
        preferences.includeOutline = value;
        PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeOutline, value);
      },
    });
    const metadataOption = createCheckboxOption({
      label: "Export metadata",
      description: "Source, export details, validation and turn IDs",
      checked: preferences.includeMetadata,
      onChange(value) {
        preferences.includeMetadata = value;
        PreferenceStorage.writeBoolean(PREFERENCE_KEYS.includeMetadata, value);
      },
    });

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "compact-toggle";

    panel.append(panelHeading, outlineOption.option, metadataOption.option, compactToggle);
    return { panel, compactToggle };
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

  const { host, shadow } = createShadowRoot(ROOT_ID, __EXPORTER_UI_CSS__);
  const toast = createToast();
  const { panel, compactToggle } = createOptionsPanel(preferences);
  const { control, exportButton, menuButton, downloadIcon, exportLabel } = createExportControl();

  const stack = document.createElement("div");
  stack.className = "stack";
  stack.append(toast.element, panel, control);
  shadow.append(stack);

  function setPanelOpen(open) {
    panel.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  }

  function setCollapsed(collapsed, persist = true) {
    preferences.collapsed = collapsed;
    control.dataset.collapsed = String(collapsed);
    exportButton.title = collapsed ? "Export Markdown" : "";
    compactToggle.textContent = collapsed
      ? "Use expanded control"
      : "Use compact control";

    if (persist) {
      PreferenceStorage.writeBoolean(PREFERENCE_KEYS.collapsed, collapsed);
    }
  }

  async function exportCurrentConversation() {
    const conversationId = Core.conversationIdFromPath(location.pathname);
    if (!conversationId) {
      toast.show("Open a Gemini conversation before exporting.", "error");
      return;
    }

    setPanelOpen(false);
    exportButton.disabled = true;
    exportButton.setAttribute("aria-label", "Exporting");
    downloadIcon.textContent = "…";
    exportLabel.textContent = "Exporting…";

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
      const markdown = Core.renderMarkdown({
        title,
        sourceUrl: location.href,
        conversationId,
        exportedAt,
        turns,
        diagnostics,
        includeMetadata: preferences.includeMetadata,
        includeOutline: preferences.includeOutline,
      });
      const filename = Core.safeFilename(title);

      Utils.downloadTextFile(markdown, filename);
      console.info("[Gemini Exporter] Export complete", {
        filename,
        pages: history.pages.length,
        ...diagnostics,
      });
      toast.show(
        `Exported ${turns.length} turns from ${history.pages.length} page${
          history.pages.length === 1 ? "" : "s"
        }. Validation: ${diagnostics.fingerprint}.`,
      );
    } catch (error) {
      console.error("[Gemini Exporter] Export failed", error);
      toast.show(
        `Export stopped: ${error instanceof Error ? error.message : String(error)}`,
        "error",
        15_000,
      );
    } finally {
      exportButton.disabled = false;
      exportButton.setAttribute("aria-label", "Export Markdown");
      downloadIcon.textContent = "↓";
      exportLabel.textContent = "Export Markdown";
    }
  }

  exportButton.addEventListener("click", exportCurrentConversation);
  menuButton.addEventListener("click", () => {
    setPanelOpen(panel.hidden);
  });
  compactToggle.addEventListener("click", () => {
    setCollapsed(!preferences.collapsed);
    setPanelOpen(false);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().includes(host)) {
        setPanelOpen(false);
      }
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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
