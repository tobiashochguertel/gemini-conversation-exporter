(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const ROOT_ID = "gemini-web-exporter-root";
  const HISTORY_PAGE_SIZE = 50;
  const PREFERENCE_KEYS = Object.freeze({
    collapsed: "ui.collapsed",
    includeMetadata: "export.includeMetadata",
    includeOutline: "export.includeOutline",
  });
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

  function makeRequestId() {
    return String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  }

  function cloneForPageRealm(value) {
    return typeof cloneInto === "function"
      ? cloneInto(value, pageWindow)
      : value;
  }

  function readBooleanPreference(key, fallback) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return typeof value === "boolean" ? value : fallback;
    } catch (error) {
      console.warn("[Gemini Exporter] Could not read preference", key, error);
      return fallback;
    }
  }

  function writeBooleanPreference(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, Boolean(value));
    } catch (error) {
      console.warn("[Gemini Exporter] Could not save preference", key, error);
    }
  }

  async function fetchHistoryPage(conversationId, cursor) {
    const config = getGeminiConfig();
    const query = new URLSearchParams({
      rpcids: Core.HISTORY_RPC_ID,
      "source-path": location.pathname,
      bl: config.cfb2h,
      "f.sid": config.FdrFJe,
      hl: (document.documentElement.lang || "en").split("-")[0],
      _reqid: makeRequestId(),
      rt: "c",
    });
    const pageId = new URLSearchParams(location.search).get("pageId");
    if (pageId) {
      query.set("pageId", pageId);
    }
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
    const endpointPath = Core.accountScopedPath(
      location.pathname,
      "/_/BardChatUi/data/batchexecute",
    );
    const endpoint = new URL(endpointPath, location.origin);
    endpoint.search = query.toString();

    const requestOptions = cloneForPageRealm({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: body.toString(),
    });
    const response = await pageWindow.fetch(
      endpoint.toString(),
      requestOptions,
    );
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Gemini history request failed with HTTP ${response.status}.`,
      );
    }

    return text;
  }

  function downloadMarkdown(markdown, filename) {
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  function createUi() {
    const preferences = {
      collapsed: readBooleanPreference(PREFERENCE_KEYS.collapsed, false),
      includeMetadata: readBooleanPreference(
        PREFERENCE_KEYS.includeMetadata,
        true,
      ),
      includeOutline: readBooleanPreference(
        PREFERENCE_KEYS.includeOutline,
        true,
      ),
    };
    const host = document.createElement("div");
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = __EXPORTER_UI_CSS__;

    const stack = document.createElement("div");
    stack.className = "stack";

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Export options");

    const panelHeading = document.createElement("p");
    panelHeading.className = "panel-heading";
    panelHeading.textContent = "Export options";

    function createOption({
      label,
      description,
      checked,
      onChange,
    }) {
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

    const outlineOption = createOption({
      label: "Conversation outline",
      description: "Linked turn list with short prompt previews",
      checked: preferences.includeOutline,
      onChange(value) {
        preferences.includeOutline = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeOutline, value);
      },
    });
    const metadataOption = createOption({
      label: "Export metadata",
      description: "Source, export details, validation and turn IDs",
      checked: preferences.includeMetadata,
      onChange(value) {
        preferences.includeMetadata = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeMetadata, value);
      },
    });

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "compact-toggle";

    panel.append(
      panelHeading,
      outlineOption.option,
      metadataOption.option,
      compactToggle,
    );

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
    stack.append(toast, panel, control);
    shadow.append(style, stack);
    let toastTimer = null;

    function showToast(message, kind = "success", duration = 8_000) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.dataset.kind = kind;
      toast.style.display = "block";
      toastTimer = setTimeout(() => {
        toast.style.display = "none";
      }, duration);
    }

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
        writeBooleanPreference(PREFERENCE_KEYS.collapsed, collapsed);
      }
    }

    async function exportCurrentConversation() {
      const conversationId = Core.conversationIdFromPath(location.pathname);
      if (!conversationId) {
        showToast("Open a Gemini conversation before exporting.", "error");
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

        downloadMarkdown(markdown, filename);
        console.info("[Gemini Exporter] Export complete", {
          filename,
          pages: history.pages.length,
          ...diagnostics,
        });
        showToast(
          `Exported ${turns.length} turns from ${history.pages.length} page${
            history.pages.length === 1 ? "" : "s"
          }. Validation: ${diagnostics.fingerprint}.`,
        );
      } catch (error) {
        console.error("[Gemini Exporter] Export failed", error);
        showToast(
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
    return { host, exportButton };
  }

  const ui = createUi();
  document.documentElement.append(ui.host);

  function syncRoute() {
    ui.host.style.display = isConversationPage() ? "block" : "none";
  }

  syncRoute();
  setInterval(syncRoute, 1_000);
})();
