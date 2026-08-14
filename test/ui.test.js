"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Minimal DOM shim — just enough to test the builder functions.
function createDomShim() {
  const elements = [];

  function makeElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      id: "",
      type: "",
      textContent: "",
      hidden: false,
      disabled: false,
      title: "",
      dataset: {},
      style: {},
      _children: [],
      _listeners: {},
      _classList: new Set(),
      setAttribute(name, value) { this[`_${name}`] = value; },
      getAttribute(name) { return this[`_${name}`]; },
      append(...children) { this._children.push(...children); },
      appendChild(child) { this._children.push(child); return child; },
      remove() {},
      addEventListener(event, handler) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
      },
      dispatchEvent(event) {
        const type = typeof event === "string" ? event : event.type;
        (this._listeners[type] || []).forEach((h) => h(event));
      },
      click() { this.dispatchEvent({ type: "click" }); },
      attachShadow() { return makeElement("shadow-root"); },
      get classList() {
        return {
          add: (c) => this._classList.add(c),
          remove: (c) => this._classList.delete(c),
          contains: (c) => this._classList.has(c),
          toggle: (c, force) => {
            if (force === undefined) return this._classList.has(c)
              ? (this._classList.delete(c), false)
              : (this._classList.add(c), true);
            if (force) this._classList.add(c);
            else this._classList.delete(c);
            return force;
          },
        };
      },
      querySelector(selector) {
        // Simple class-based selector: ".className"
        const match = selector.match(/^\.([\w-]+)$/);
        if (!match) return null;
        const cls = match[1];
        return this._children.find((c) =>
          (c._classList && c._classList.has(cls)) ||
          (c.className && c.className.split(/\s+/).includes(cls))
        ) || null;
      },
      querySelectorAll(selector) {
        const match = selector.match(/^\.([\w-]+)$/);
        if (!match) return [];
        const cls = match[1];
        return this._children.filter((c) =>
          (c._classList && c._classList.has(cls)) ||
          (c.className && c.className.split(/\s+/).includes(cls))
        );
      },
    };
    elements.push(el);
    return el;
  }

  const document = {
    createElement: makeElement,
    createElementNS: makeElement,
    body: makeElement("body"),
    documentElement: { lang: "en" },
  };

  return { document, elements };
}

function loadUi() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/ui.js"),
    "utf8",
  );
  // Ui.js uses `document` as a global — inject our shim.
  const fn = new Function("document", src + "\n; return Ui;");
  const { document } = createDomShim();
  return fn(document);
}

test("createShadowRoot creates a host with the given ID and injects CSS", () => {
  const Ui = loadUi();
  const { host, shadow } = Ui.createShadowRoot("my-root", ":host { color: red; }");

  assert.equal(host.id, "my-root");
  assert.ok(shadow._children.length >= 1);
  const style = shadow._children[0];
  assert.equal(style.textContent, ":host { color: red; }");
});

test("createToast returns an element and a show function", () => {
  const Ui = loadUi();
  const toast = Ui.createToast();

  assert.equal(toast.element.className, "toast");
  assert.equal(typeof toast.show, "function");
  assert.equal(toast.element.getAttribute("role"), "status");
  assert.equal(toast.element.getAttribute("aria-live"), "polite");
});

test("createCheckboxOption builds a label with checkbox and description", () => {
  const Ui = loadUi();
  let changedValue = null;
  const { option, input } = Ui.createCheckboxOption({
    label: "My option",
    description: "A test option",
    checked: true,
    onChange: (v) => { changedValue = v; },
  });

  assert.equal(option.className, "option");
  assert.equal(input.type, "checkbox");
  assert.equal(input.checked, true);
  // Trigger change event
  input.checked = false;
  input.dispatchEvent({ type: "change" });
  assert.equal(changedValue, false);
});

test("createExportControl uses provided labels and icons", () => {
  const Ui = loadUi();
  const result = Ui.createExportControl({
    buttons: [
      { label: "Download", ariaLabel: "Download file", icon: "⬇" },
    ],
    menuAriaLabel: "Settings",
    menuIcon: "≡",
  });

  assert.equal(result.buttons.length, 1);
  assert.equal(result.buttons[0].getAttribute("aria-label"), "Download file");
  assert.equal(result.buttons[0].querySelector(".export-label").textContent, "Download");
  assert.equal(result.buttons[0].querySelector(".download-icon").textContent, "⬇");
  assert.equal(result.menuButton.textContent, "≡");
  assert.equal(result.menuButton.getAttribute("aria-label"), "Settings");
  assert.equal(result.menuButton.getAttribute("aria-haspopup"), "dialog");
});

test("createExportControl supports multiple buttons", () => {
  const Ui = loadUi();
  const result = Ui.createExportControl({
    buttons: [
      { label: "Export Markdown", ariaLabel: "Export Markdown", icon: "↓" },
      { label: "Export JSON", ariaLabel: "Export JSON", icon: "{ }" },
    ],
    menuAriaLabel: "Options",
  });

  assert.equal(result.buttons.length, 2);
  assert.equal(result.buttons[0].getAttribute("aria-label"), "Export Markdown");
  assert.equal(result.buttons[1].getAttribute("aria-label"), "Export JSON");
  assert.ok(result.buttons[1].classList.contains("export-button--secondary"));
  assert.ok(!result.buttons[0].classList.contains("export-button--secondary"));
});

test("createExportControl uses default icons when not specified", () => {
  const Ui = loadUi();
  const result = Ui.createExportControl({
    buttons: [{ label: "Export", ariaLabel: "Export" }],
    menuAriaLabel: "Menu",
  });

  assert.equal(result.buttons[0].querySelector(".download-icon").textContent, "↓");
  assert.equal(result.menuButton.textContent, "⋮");
});

test("createOptionsPanel builds heading, options, and compact toggle", () => {
  const Ui = loadUi();
  const { panel, compactToggle } = Ui.createOptionsPanel({
    heading: "Settings",
    ariaLabel: "Settings dialog",
    options: [
      { label: "A", description: "desc A", checked: true, onChange() {} },
      { label: "B", description: "desc B", checked: false, onChange() {} },
    ],
  });

  assert.equal(panel.className, "panel");
  assert.equal(panel.hidden, true);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-label"), "Settings dialog");
  assert.equal(compactToggle.className, "compact-toggle");

  // panel should contain: heading, option A, option B, compact toggle
  assert.ok(panel._children.length >= 4);
  assert.equal(panel._children[0].textContent, "Settings");
});

test("createStack creates a container with class and appended children", () => {
  const Ui = loadUi();
  const child1 = { tag: "div" };
  const child2 = { tag: "span" };
  const stack = Ui.createStack("my-stack", child1, child2);

  assert.equal(stack.className, "my-stack");
  assert.equal(stack._children.length, 2);
  assert.equal(stack._children[0], child1);
  assert.equal(stack._children[1], child2);
});

test("createExportControl setMenuExpanded toggles aria-expanded", () => {
  const Ui = loadUi();
  const { menuButton, setMenuExpanded } = Ui.createExportControl({
    buttons: [{ label: "X", ariaLabel: "X" }],
    menuAriaLabel: "M",
  });

  assert.equal(menuButton.getAttribute("aria-expanded"), "false");
  setMenuExpanded(true);
  assert.equal(menuButton.getAttribute("aria-expanded"), "true");
  setMenuExpanded(false);
  assert.equal(menuButton.getAttribute("aria-expanded"), "false");
});

test("createExportControl setBusy disables all buttons and swaps icon/label on target", () => {
  const Ui = loadUi();
  const { buttons, setBusy } = Ui.createExportControl({
    buttons: [
      { label: "Export Markdown", ariaLabel: "Export Markdown", icon: "↓" },
      { label: "Export JSON", ariaLabel: "Export JSON", icon: "{ }" },
    ],
    menuAriaLabel: "Menu",
  });

  setBusy(true, 0, { icon: "…", label: "Working…", ariaLabel: "Working" });
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);
  assert.equal(buttons[0].querySelector(".download-icon").textContent, "…");
  assert.equal(buttons[0].querySelector(".export-label").textContent, "Working…");
  assert.equal(buttons[0].getAttribute("aria-label"), "Working");
  // Second button label should be unchanged
  assert.equal(buttons[1].querySelector(".export-label").textContent, "Export JSON");

  setBusy(false, 0, { icon: "↓", label: "Export Markdown", ariaLabel: "Export Markdown" });
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, false);
  assert.equal(buttons[0].querySelector(".download-icon").textContent, "↓");
  assert.equal(buttons[0].querySelector(".export-label").textContent, "Export Markdown");
  assert.equal(buttons[0].getAttribute("aria-label"), "Export Markdown");
});

test("createExportControl setCollapsed toggles dataset and titles", () => {
  const Ui = loadUi();
  const { control, buttons, setCollapsed } = Ui.createExportControl({
    buttons: [
      { label: "Export Markdown", ariaLabel: "Export Markdown" },
      { label: "Export JSON", ariaLabel: "Export JSON" },
    ],
    menuAriaLabel: "Menu",
  });

  setCollapsed(true, { titles: ["Export Markdown", "Export JSON"] });
  assert.equal(control.dataset.collapsed, "true");
  assert.equal(buttons[0].title, "Export Markdown");
  assert.equal(buttons[1].title, "Export JSON");

  setCollapsed(false, { titles: ["Export Markdown", "Export JSON"] });
  assert.equal(control.dataset.collapsed, "false");
  assert.equal(buttons[0].title, "");
  assert.equal(buttons[1].title, "");
});

test("createOptionsPanel setOpen toggles panel.hidden", () => {
  const Ui = loadUi();
  const { panel, setOpen } = Ui.createOptionsPanel({
    heading: "H",
    ariaLabel: "A",
    options: [],
  });

  assert.equal(panel.hidden, true);
  setOpen(true);
  assert.equal(panel.hidden, false);
  setOpen(false);
  assert.equal(panel.hidden, true);
});

test("createOptionsPanel setCompactToggleLabel sets toggle text", () => {
  const Ui = loadUi();
  const { compactToggle, setCompactToggleLabel } = Ui.createOptionsPanel({
    heading: "H",
    ariaLabel: "A",
    options: [],
  });

  setCompactToggleLabel("Use expanded control");
  assert.equal(compactToggle.textContent, "Use expanded control");
  setCompactToggleLabel("Use compact control");
  assert.equal(compactToggle.textContent, "Use compact control");
});

test("createOptionsPanel handles zero options", () => {
  const Ui = loadUi();
  const { panel } = Ui.createOptionsPanel({
    heading: "Empty",
    ariaLabel: "Empty",
    options: [],
  });

  // heading + compact toggle only
  assert.equal(panel._children.length, 2);
});

test("Ui is frozen and cannot be modified", () => {
  const Ui = loadUi();

  assert.ok(Object.isFrozen(Ui));
  assert.throws(() => { Ui.newMethod = () => {}; }, TypeError);
});

test("ui.js does not reference site-specific logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/ui.js"),
    "utf8",
  );

  assert.doesNotMatch(src, /gemini|Gemini|WIZ_global_data|BardChatUi|hNvQHb|PreferenceStorage|PREFERENCE_KEYS/i);
  assert.match(src, /createShadowRoot/);
  assert.match(src, /createToast/);
  assert.match(src, /createCheckboxOption/);
  assert.match(src, /createExportControl/);
  assert.match(src, /createOptionsPanel/);
});
