(function runGeminiExporterUserscript() {
  "use strict";

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const ROOT_ID = "gemini-web-exporter-root";
  const HISTORY_PAGE_SIZE = 50;
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
    const endpoint = new URL(
      "/_/BardChatUi/data/batchexecute",
      location.origin,
    );
    endpoint.search = query.toString();

    const response = await pageWindow.fetch(endpoint.toString(), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: body.toString(),
    });
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
    const host = document.createElement("div");
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
        :host {
          all: initial;
          position: fixed;
          right: 22px;
          bottom: 22px;
          z-index: 2147483647;
          font-family: "Google Sans", system-ui, -apple-system, sans-serif;
        }

        .stack {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 10px;
        }

        button {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 999px;
          background: #1f1f1f;
          color: #fff;
          cursor: pointer;
          font: 600 14px/1 system-ui, -apple-system, sans-serif;
          min-width: 132px;
          padding: 13px 18px;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
        }

        button:hover {
          background: #303030;
        }

        button:focus-visible {
          outline: 3px solid #a8c7fa;
          outline-offset: 2px;
        }

        button:disabled {
          cursor: progress;
          opacity: 0.72;
        }

        .toast {
          box-sizing: border-box;
          display: none;
          max-width: min(420px, calc(100vw - 44px));
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 12px;
          background: #1f1f1f;
          color: #fff;
          font: 500 13px/1.45 system-ui, -apple-system, sans-serif;
          padding: 11px 13px;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
        }

        .toast[data-kind="error"] {
          background: #8c1d18;
        }
    `;

    const stack = document.createElement("div");
    stack.className = "stack";

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Export Markdown";

    stack.append(toast, button);
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

    async function exportCurrentConversation() {
      const conversationId = Core.conversationIdFromPath(location.pathname);
      if (!conversationId) {
        showToast("Open a Gemini conversation before exporting.", "error");
        return;
      }

      button.disabled = true;
      button.textContent = "Exporting…";

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
        button.disabled = false;
        button.textContent = "Export Markdown";
      }
    }

    button.addEventListener("click", exportCurrentConversation);
    return { host, button };
  }

  const ui = createUi();
  document.documentElement.append(ui.host);

  function syncRoute() {
    ui.host.style.display = isConversationPage() ? "block" : "none";
  }

  syncRoute();
  setInterval(syncRoute, 1_000);
})();
