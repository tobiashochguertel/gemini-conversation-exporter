/**
 * Generic Shadow DOM UI builders for userscripts.
 *
 * All functions are pure DOM construction — no site-specific labels,
 * preference keys, or business logic. Callers pass in all text and
 * behavior via parameters so the same builders can be reused across
 * different userscripts.
 */

const Ui = Object.freeze({
  /**
   * Create a Shadow DOM host with an injected stylesheet.
   *
   * @param {string} rootId - ID for the host element.
   * @param {string} cssText - CSS content for the shadow root.
   * @returns {{ host: HTMLElement, shadow: ShadowRoot }}
   */
  createShadowRoot(rootId, cssText) {
    const host = document.createElement("div");
    host.id = rootId;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.append(style);
    return { host, shadow };
  },

  /**
   * Create a toast notification element with auto-hide.
   *
   * @returns {{ element: HTMLElement, show: (message: string, kind?: string, duration?: number) => void }}
   */
  createToast() {
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
  },

  /**
   * Create a labeled checkbox option row.
   *
   * @param {object} opts
   * @param {string} opts.label - Option label text.
   * @param {string} opts.description - Option description text.
   * @param {boolean} opts.checked - Initial checked state.
   * @param {(value: boolean) => void} opts.onChange - Change callback.
   * @returns {{ option: HTMLElement, input: HTMLInputElement }}
   */
  createCheckboxOption({ label, description, checked, onChange }) {
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
  },

  /**
   * Create an export control bar with a primary button and menu button.
   *
   * Returns state setters that encapsulate DOM manipulation:
   *   - setMenuExpanded(expanded): toggle aria-expanded on the menu button
   *   - setBusy(busy, { icon, label, ariaLabel }): disable button + swap icon/label
   *   - setCollapsed(collapsed, { title }): toggle dataset.collapsed + button title
   *
   * @param {object} opts
   * @param {string} opts.buttonLabel - Primary button text.
   * @param {string} opts.buttonAriaLabel - Primary button aria-label.
   * @param {string} opts.menuAriaLabel - Menu button aria-label.
   * @param {string} [opts.buttonIcon="↓"] - Icon character for the button.
   * @param {string} [opts.menuIcon="⋮"] - Icon character for the menu button.
   * @returns {{ control, exportButton, menuButton, downloadIcon, exportLabel, setMenuExpanded, setBusy, setCollapsed }}
   */
  createExportControl({
    buttonLabel,
    buttonAriaLabel,
    menuAriaLabel,
    buttonIcon = "↓",
    menuIcon = "⋮",
  }) {
    const control = document.createElement("div");
    control.className = "control";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "export-button";
    exportButton.setAttribute("aria-label", buttonAriaLabel);

    const downloadIcon = document.createElement("span");
    downloadIcon.className = "download-icon";
    downloadIcon.setAttribute("aria-hidden", "true");
    downloadIcon.textContent = buttonIcon;

    const exportLabel = document.createElement("span");
    exportLabel.className = "export-label";
    exportLabel.textContent = buttonLabel;

    exportButton.append(downloadIcon, exportLabel);

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "menu-button";
    menuButton.textContent = menuIcon;
    menuButton.setAttribute("aria-label", menuAriaLabel);
    menuButton.setAttribute("aria-haspopup", "dialog");
    menuButton.setAttribute("aria-expanded", "false");

    control.append(exportButton, menuButton);

    function setMenuExpanded(expanded) {
      menuButton.setAttribute("aria-expanded", String(expanded));
    }

    function setBusy(busy, { icon, label, ariaLabel } = {}) {
      exportButton.disabled = busy;
      if (icon !== undefined) downloadIcon.textContent = icon;
      if (label !== undefined) exportLabel.textContent = label;
      if (ariaLabel !== undefined) exportButton.setAttribute("aria-label", ariaLabel);
    }

    function setCollapsed(collapsed, { title } = {}) {
      control.dataset.collapsed = String(collapsed);
      exportButton.title = collapsed ? (title ?? "") : "";
    }

    return { control, exportButton, menuButton, downloadIcon, exportLabel, setMenuExpanded, setBusy, setCollapsed };
  },

  /**
   * Create a vertical stack container and append children to it.
   *
   * @param {string} className - CSS class for the stack element.
   * @param {...HTMLElement} children - Elements to append.
   * @returns {HTMLElement}
   */
  createStack(className, ...children) {
    const stack = document.createElement("div");
    stack.className = className;
    stack.append(...children);
    return stack;
  },

  /**
   * Create an options panel with heading, checkbox options, and a compact toggle.
   *
   * Returns state setters:
   *   - setOpen(open): toggle panel.hidden
   *   - setCompactToggleLabel(text): set compactToggle.textContent
   *
   * @param {object} opts
   * @param {string} opts.heading - Panel heading text.
   * @param {string} opts.ariaLabel - Panel aria-label.
   * @param {Array<{ label: string, description: string, checked: boolean, onChange: (value: boolean) => void }>} opts.options - Checkbox option configs.
   * @returns {{ panel, compactToggle, setOpen, setCompactToggleLabel }}
   */
  createOptionsPanel({ heading, ariaLabel, options }) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", ariaLabel);

    const panelHeading = document.createElement("p");
    panelHeading.className = "panel-heading";
    panelHeading.textContent = heading;

    panel.append(panelHeading);

    for (const optionConfig of options) {
      const { option } = Ui.createCheckboxOption(optionConfig);
      panel.append(option);
    }

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "compact-toggle";

    panel.append(compactToggle);

    function setOpen(open) {
      panel.hidden = !open;
    }

    function setCompactToggleLabel(text) {
      compactToggle.textContent = text;
    }

    return { panel, compactToggle, setOpen, setCompactToggleLabel };
  },
});
