// Shared form primitives for the admin WebUI: field rendering with label/hint/aria wiring,
// field-level validation, an error summary that jumps to the offending field, a dirty-state
// guard and a confirm dialog. Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/form.js)

import { el } from "./core.js";

let fieldSeq = 0;

function nextId(prefix) {
  fieldSeq += 1;
  return `${prefix}-${fieldSeq}`;
}

/** Built-in field validators; each returns an error string or null. */
export const validators = {
  required(message = "This field is required") {
    return (value) => (String(value ?? "").trim() ? null : message);
  },
  url(message = "Enter an absolute http(s) URL") {
    return (value) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      try {
        const parsed = new URL(text);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : message;
      } catch {
        return message;
      }
    };
  },
  minLength(length, message) {
    return (value) => (String(value ?? "").trim().length >= length ? null : message || `Use at least ${length} characters`);
  },
  pattern(regexp, message = "Value has an unexpected format") {
    return (value) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      return regexp.test(text) ? null : message;
    };
  },
};

/**
 * Render one editable field.
 * spec: { name, label, hint, type='text', value='', placeholder, autocomplete, rows,
 *         options: [{value,label}], required, validate: (value) => string|null, mono }
 */
export function createField(spec) {
  const name = spec.name;
  if (!name) throw new Error("createField requires a name");
  const id = spec.id || nextId(`ff-${name}`);
  const wrapper = el("div", "ff");
  const label = el("label", "ff-label", spec.label || name);
  label.htmlFor = id;
  if (spec.required) {
    const marker = el("span", "req", " *");
    marker.setAttribute("aria-hidden", "true");
    label.appendChild(marker);
  }
  wrapper.appendChild(label);

  let input;
  if (spec.options) {
    input = el("select", spec.mono ? "mono" : null);
    for (const option of spec.options) {
      const node = el("option", null, option.label ?? option.value);
      node.value = option.value;
      input.appendChild(node);
    }
  } else if (spec.type === "textarea") {
    input = el("textarea", spec.mono ? "mono" : null);
    if (spec.rows) input.rows = spec.rows;
  } else {
    input = el("input", spec.mono ? "mono" : null);
    input.type = spec.type || "text";
    if (spec.placeholder) input.placeholder = spec.placeholder;
    if (spec.autocomplete) input.autocomplete = spec.autocomplete;
  }
  input.id = id;
  input.name = name;
  if (spec.required) input.required = true;
  if (spec.value !== undefined && spec.value !== null) input.value = spec.value;
  wrapper.appendChild(input);

  const describedBy = [];
  let hint = null;
  if (spec.hint) {
    hint = el("p", "ff-hint", spec.hint);
    hint.id = `${id}-hint`;
    wrapper.appendChild(hint);
    describedBy.push(hint.id);
  }
  const error = el("p", "ff-error");
  error.id = `${id}-error`;
  error.hidden = true;
  wrapper.appendChild(error);
  describedBy.push(error.id);
  input.setAttribute("aria-describedby", describedBy.join(" "));
  input.setAttribute("aria-invalid", "false");

  const checks = [];
  if (spec.required) checks.push(validators.required(`${spec.label || name} is required`));
  if (spec.validate) checks.push(spec.validate);

  const handle = {
    name,
    id,
    element: wrapper,
    input,
    hint,
    errorElement: error,
    value() {
      return input.value;
    },
    setValue(value) {
      input.value = value ?? "";
      handle.clearError();
    },
    setError(message) {
      error.textContent = message || "";
      error.hidden = !message;
      input.setAttribute("aria-invalid", message ? "true" : "false");
    },
    clearError() {
      handle.setError(null);
    },
    validate() {
      for (const check of checks) {
        const message = check(input.value);
        if (message) {
          handle.setError(message);
          return message;
        }
      }
      handle.clearError();
      return null;
    },
    focus() {
      input.focus();
      if (typeof input.select === "function" && input.tagName === "INPUT") input.select();
    },
  };
  input.addEventListener("input", () => {
    if (input.getAttribute("aria-invalid") === "true") handle.validate();
  });
  input.addEventListener("blur", () => handle.validate());
  return handle;
}

/**
 * Error summary listing every invalid field; each entry is a button that jumps to it.
 * `show(entries)` takes `[{ field, message }]`.
 */
export function createErrorSummary() {
  const element = el("div", "error-summary");
  element.setAttribute("role", "alert");
  element.hidden = true;

  function clear() {
    element.textContent = "";
    element.hidden = true;
  }

  function show(entries) {
    element.textContent = "";
    if (!entries.length) {
      clear();
      return;
    }
    element.appendChild(el("p", null, `${entries.length} field${entries.length === 1 ? "" : "s"} need attention`));
    const list = el("ul");
    for (const entry of entries) {
      const item = el("li");
      const link = el("button", "link", entry.message);
      link.type = "button";
      link.addEventListener("click", () => entry.field.focus());
      item.appendChild(link);
      list.appendChild(item);
    }
    element.appendChild(list);
    element.hidden = false;
  }

  return { element, show, clear };
}

/**
 * Form controller: owns fields, the error summary and submit gating.
 * options: { fields, onSubmit(values), submitLabel }
 */
export function createForm(options = {}) {
  const fields = options.fields || [];
  const summary = createErrorSummary();
  const controller = {
    fields,
    summary,
    values() {
      const values = {};
      for (const field of fields) values[field.name] = field.value();
      return values;
    },
    reset(values = {}) {
      for (const field of fields) field.setValue(values[field.name] ?? "");
      summary.clear();
    },
    validateAll() {
      const failures = [];
      for (const field of fields) {
        const message = field.validate();
        if (message) failures.push({ field, message });
      }
      summary.show(failures);
      if (failures.length) failures[0].field.focus();
      return failures.length === 0;
    },
    async submit() {
      if (!controller.validateAll()) return false;
      if (options.onSubmit) await options.onSubmit(controller.values());
      return true;
    },
  };
  return controller;
}

/**
 * Dirty-state guard over an opaque snapshot (usually `JSON.stringify(state)`).
 * options: { snapshot: () => string, message }
 */
export function createDirtyGuard(options = {}) {
  const snapshot = options.snapshot || (() => "");
  const message = options.message || "You have unsaved changes. Discard them?";
  let baseline = snapshot();
  return {
    isDirty() {
      return snapshot() !== baseline;
    },
    markClean() {
      baseline = snapshot();
    },
    async confirmDiscard() {
      if (snapshot() === baseline) return true;
      return confirmDialog({
        title: "Unsaved changes",
        message,
        confirmLabel: "Discard changes",
        danger: true,
      });
    },
  };
}

/**
 * Modal confirm built on the native `<dialog>` element. Resolves true only when the user
 * explicitly confirms.
 */
export function confirmDialog(options = {}) {
  const title = options.title || "Confirm";
  const message = options.message || "";
  const confirmLabel = options.confirmLabel || "Confirm";
  const cancelLabel = options.cancelLabel || "Cancel";
  return new Promise((resolve) => {
    const dialog = el("dialog", "confirm-dialog amb-surface amb-elevation-3");
    dialog.setAttribute("aria-labelledby", "confirm-dialog-title");
    const shell = el("form", "confirm-dialog-shell");
    shell.method = "dialog";
    shell.appendChild(el("h2", null, title));
    if (message) shell.appendChild(el("p", "confirm-dialog-message", message));
    const actions = el("div", "actions");
    const cancel = el("button", "btn", cancelLabel);
    cancel.value = "cancel";
    const confirm = el("button", `btn primary${options.danger ? " danger" : ""}`, confirmLabel);
    confirm.value = "confirm";
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    shell.appendChild(actions);
    dialog.appendChild(shell);
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(accepted);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
