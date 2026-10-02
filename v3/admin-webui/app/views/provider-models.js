// RCC V3 Admin WebUI — provider model authoring.
//
// Owns the provider drawer's model surface:
//   * E5 — the editable Models section (add / edit / remove / set default),
//   * E6 — "Fetch models": authenticated discovery, then a checkbox picker whose
//          checked set is written in exactly one E1 request,
//   * E4 — the capability test gate: a capability the operator ticks by hand is
//          written only after `POST /api/providers/:id/models/capability-test`
//          returned `passed: true` for that capability in the same dialog session.
//
// Every mutation goes through the E1 endpoint and is followed by a fresh provider
// read (`onChanged`), so nothing here keeps optimistic state.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-models.js)

import { api, el, showStatus } from "../core.js";

// The capability vocabulary the runtime understands. `text` is the baseline every
// model gets, so it is always present and is never an operator claim.
export const MODEL_CAPABILITIES = [
  "text",
  "reasoning",
  "thinking",
  "tools",
  "multimodal",
  "vision",
  "longcontext",
  "web_search_direct",
];

// E1 refuses `add` for an existing name with `409 model_exists` unless that name
// is listed in the request's top-level `replace` list. The marker is a list of
// names and never a key inside the entry, so an entry object stays pure config
// fields and no control flag can be absorbed by `V2ProviderModelConfig` as a
// silent no-op.
const REPLACE_FIELD = "replace";

const REASON = {
  discovered: "webui add models from discovery",
  manualAdd: "webui add model",
  edit: "webui edit model",
  remove: "webui remove models",
  setDefault: "webui set default model",
};

function modelsPath(providerId) {
  return `/api/providers/${encodeURIComponent(providerId)}/models`;
}

function capabilityTestPath(providerId) {
  return `/api/providers/${encodeURIComponent(providerId)}/models/capability-test`;
}

/**
 * E9: render the server's own error identity (status + error_code + message).
 * Nothing in this module is allowed to replace a real failure with a generic
 * string or with success.
 */
export function describeApiError(error) {
  const parts = [];
  if (error?.status) parts.push(`HTTP ${error.status}`);
  if (error?.code) parts.push(String(error.code));
  parts.push(error?.message || "request failed");
  return parts.join(" · ");
}

async function writeModels(providerId, body) {
  return api(modelsPath(providerId), { method: "POST", body: JSON.stringify(body) });
}

/** E4 capability test. Read-only on the server: it must never mutate config. */
async function requestCapabilityTest(providerId, model, capabilities) {
  return api(capabilityTestPath(providerId), {
    method: "POST",
    body: JSON.stringify({ model, capabilities }),
  });
}

function modelEntries(config) {
  return config?.provider?.models || {};
}

function defaultModelOf(config) {
  return config?.provider?.defaultModel || null;
}

function limitsText(entry) {
  const parts = [];
  if (entry?.maxTokens != null) parts.push(`maxTokens ${Number(entry.maxTokens).toLocaleString()}`);
  if (entry?.maxContextTokens != null) parts.push(`maxContext ${Number(entry.maxContextTokens).toLocaleString()}`);
  return parts.length ? parts.join(" · ") : "—";
}

function capabilityChips(capabilities) {
  const host = el("div", "model-caps");
  for (const capability of capabilities || []) {
    host.appendChild(el("span", "model-cap", capability));
  }
  if (!host.childElementCount) host.appendChild(el("span", "muted", "—"));
  return host;
}

function dialogShell(className, title) {
  const dialog = el("dialog", `modal amb-surface amb-elevation-2 ${className}`);
  const heading = el("h2", "model-dialog-title", title);
  dialog.appendChild(heading);
  document.body.appendChild(dialog);
  return dialog;
}

function closeAndRemove(dialog) {
  if (dialog.open) dialog.close();
  dialog.remove();
}

// ---------------------------------------------------------------------------
// E4 — capability session
//
// Provenance per capability inside one dialog session:
//   default  — the baseline every model gets (`text`), never operator-ticked.
//   detected — came from the provider's own discovery response, or was already
//              authored in the provider file. The file records no provenance, so
//              the dialog must not re-assert an already-authored capability as a
//              new manual claim; carrying it forward is not a new assertion.
//   manual   — a NEW claim the operator made in this dialog. It is written only
//              after its capability test returned `tested && passed` here.
// ---------------------------------------------------------------------------

function createCapabilitySession({ stored, detected }) {
  const session = new Map();
  for (const capability of MODEL_CAPABILITIES) {
    session.set(capability, { source: null, tested: false, passed: false, detail: null, refused: false });
  }
  session.get("text").source = "default";
  for (const capability of stored || []) {
    if (session.has(capability)) session.get(capability).source = "detected";
  }
  for (const capability of detected || []) {
    if (session.has(capability)) session.get(capability).source = "detected";
  }
  return session;
}

/**
 * The capabilities this dialog is allowed to write.
 * A `manual` capability that did not pass its test in this session is excluded
 * even if some other path left the tick in place.
 */
function writableCapabilities(session) {
  const out = [];
  for (const capability of MODEL_CAPABILITIES) {
    const entry = session.get(capability);
    if (!entry) continue;
    if (entry.source === "default" || entry.source === "detected") out.push(capability);
    else if (entry.source === "manual" && entry.tested && entry.passed) out.push(capability);
  }
  return out;
}

function capabilitySourceLabel(entry) {
  if (entry.refused) return `refused — ${entry.detail || "capability test did not pass"}`;
  if (entry.source === "default") return "default — baseline, always on";
  if (entry.source === "detected") return "detected — no test required";
  if (entry.source === "manual") {
    if (entry.detail === "testing…") return "manual — testing…";
    return "manual — test passed in this session";
  }
  return "not set";
}

// ---------------------------------------------------------------------------
// E5/E4 — add or edit one model
// ---------------------------------------------------------------------------

function openModelDialog({ providerId, modelName, entry, detectedCapabilities, isNew, onChanged }) {
  const existing = entry || {};
  const dialog = dialogShell("model-dialog", isNew ? `Add model — ${modelName}` : `Edit model — ${modelName}`);

  const body = el("div", "model-dialog-body");
  dialog.appendChild(body);
  // Saving goes through the provider writer, which re-serializes the whole file from the typed
  // schema. Verified live: that keeps every setting the runtime reads, but it does drop TOML
  // comments and any key the schema does not model, so say so rather than let it surprise anyone.
  body.appendChild(
    el(
      "p",
      "ff-hint",
      "Saving rewrites the whole provider file in canonical form and keeps a backup next to it. Comments and keys the config schema does not model are not preserved.",
    ),
  );

  const nameField = el("div", "ff");
  const nameLabel = el("label", "ff-label", "Model name");
  const nameInput = el("input");
  nameInput.id = `model-name-${modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  nameInput.value = modelName;
  nameInput.disabled = !isNew;
  nameLabel.htmlFor = nameInput.id;
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);
  nameField.appendChild(
    el(
      "p",
      "ff-hint",
      isNew
        ? "The map key in provider.models. It is sent as the add key."
        : "The model name is the config map key and cannot be renamed here; remove and add to rename.",
    ),
  );
  body.appendChild(nameField);

  const textFields = [
    { key: "wireName", label: "Wire name", hint: "Upstream model id sent on the wire. Empty keeps the model name." },
    { key: "maxTokens", label: "Max tokens", hint: "Per-response output token ceiling." },
    { key: "maxContextTokens", label: "Max context tokens", hint: "Context window used for compaction decisions." },
    { key: "thinking", label: "Thinking", hint: "Provider-specific thinking/reasoning selector, if any." },
  ];
  const inputs = { name: nameInput };
  for (const spec of textFields) {
    const field = el("div", "ff");
    const label = el("label", "ff-label", spec.label);
    const input = el("input");
    input.id = `model-${spec.key}-${modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    input.value = existing[spec.key] == null ? "" : String(existing[spec.key]);
    label.htmlFor = input.id;
    field.appendChild(label);
    field.appendChild(input);
    field.appendChild(el("p", "ff-hint", spec.hint));
    body.appendChild(field);
    inputs[spec.key] = input;
  }

  const boolRow = el("div", "model-bool-row");
  const boolInputs = {};
  for (const spec of [
    { key: "supportsStreaming", label: "Supports streaming" },
    { key: "supportsThinking", label: "Supports thinking" },
  ]) {
    const label = el("label", "model-bool");
    const input = el("input");
    input.type = "checkbox";
    input.checked = Boolean(existing[spec.key]);
    label.appendChild(input);
    label.appendChild(el("span", null, spec.label));
    boolRow.appendChild(label);
    boolInputs[spec.key] = input;
  }
  body.appendChild(boolRow);

  // --- capability gate -----------------------------------------------------
  const session = createCapabilitySession({
    stored: existing.capabilities,
    detected: detectedCapabilities,
  });

  const fieldset = el("fieldset", "model-cap-fieldset");
  fieldset.appendChild(el("legend", null, "Capabilities"));
  fieldset.appendChild(
    el(
      "p",
      "ff-hint",
      "A capability you tick yourself is written only after its capability test passes in this dialog. A capability that reports tested:false (for example longcontext) can never be set by hand.",
    ),
  );
  const capRows = el("div", "model-cap-rows");
  fieldset.appendChild(capRows);
  const preview = el("p", "model-write-preview");
  fieldset.appendChild(preview);
  body.appendChild(fieldset);

  const errorLine = el("p", "ff-error");
  errorLine.hidden = true;
  body.appendChild(errorLine);

  const actions = el("div", "actions");
  const cancelBtn = el("button", "btn", "Cancel");
  const saveBtn = el("button", "btn primary", isNew ? "Add model" : "Save model");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  dialog.appendChild(actions);

  const checkboxes = new Map();

  function renderPreview() {
    const write = writableCapabilities(session);
    preview.textContent = `Will write capabilities: ${write.length ? write.join(", ") : "(none)"}`;
  }

  function renderCapabilities() {
    capRows.textContent = "";
    checkboxes.clear();
    for (const capability of MODEL_CAPABILITIES) {
      const state = session.get(capability);
      const row = el("div", "model-cap-row");
      row.dataset.capability = capability;

      const label = el("label", "model-cap-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = state.source !== null;
      input.dataset.capability = capability;
      const isBaseline = capability === "text";
      input.disabled = isBaseline || state.detail === "testing…";
      label.appendChild(input);
      label.appendChild(el("span", "model-cap-name", capability));
      row.appendChild(label);
      checkboxes.set(capability, input);

      const source = el("span", `model-cap-source${state.refused ? " bad" : ""}`, capabilitySourceLabel(state));
      source.dataset.role = "source";
      row.appendChild(source);

      capRows.appendChild(row);

      input.addEventListener("change", async () => {
        if (input.checked) {
          await claimCapability(capability);
        } else {
          const current = session.get(capability);
          current.source = null;
          current.tested = false;
          current.passed = false;
          current.detail = null;
          current.refused = false;
          renderCapabilities();
          renderPreview();
        }
      });
    }
    renderPreview();
  }

  /**
   * A manual tick is a claim, so it is proven before it is kept. The test is
   * scoped to this capability and this model; a non-passing or non-testable
   * result reverts the tick and keeps the capability out of the write set.
   */
  async function claimCapability(capability) {
    const state = session.get(capability);
    state.source = "manual";
    state.tested = false;
    state.passed = false;
    state.refused = false;
    state.detail = "testing…";
    renderCapabilities();

    let failure = null;
    try {
      const result = await requestCapabilityTest(providerId, modelName, [capability]);
      const row = (result?.results || []).find((item) => item.capability === capability);
      if (!row) {
        failure = "capability-test returned no result for this capability";
      } else {
        state.tested = Boolean(row.tested);
        state.passed = Boolean(row.passed);
        state.detail = row.detail || (state.tested ? "capability test failed" : "capability is not testable");
        if (!(state.tested && state.passed)) failure = state.detail;
      }
    } catch (error) {
      failure = describeApiError(error);
    }

    if (failure) {
      state.source = null;
      state.tested = false;
      state.passed = false;
      state.refused = true;
      state.detail = failure;
      const box = checkboxes.get(capability);
      if (box) box.checked = false;
      showStatus("warn", `${capability} refused: ${failure}`);
    }
    renderCapabilities();
  }

  renderCapabilities();

  cancelBtn.addEventListener("click", () => closeAndRemove(dialog));

  saveBtn.addEventListener("click", async () => {
    errorLine.hidden = true;
    saveBtn.disabled = true;
    try {
      const name = isNew ? nameInput.value.trim() : modelName;
      if (!name) throw new Error("model name is required");

      const payload = { capabilities: writableCapabilities(session) };
      if (inputs.wireName.value.trim()) payload.wireName = inputs.wireName.value.trim();
      if (inputs.thinking.value.trim()) payload.thinking = inputs.thinking.value.trim();
      for (const key of ["maxTokens", "maxContextTokens"]) {
        const raw = inputs[key].value.trim();
        if (!raw) continue;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive number`);
        payload[key] = Math.trunc(parsed);
      }
      payload.supportsStreaming = boolInputs.supportsStreaming.checked;
      payload.supportsThinking = boolInputs.supportsThinking.checked;

      const body = { add: { [name]: payload }, reason: isNew ? REASON.manualAdd : REASON.edit };
      // Editing an existing name needs the top-level replacement marker; without
      // it the server answers 409 model_exists and writes nothing.
      if (!isNew) body[REPLACE_FIELD] = [name];

      await writeModels(providerId, body);
      closeAndRemove(dialog);
      showStatus("ok", `${isNew ? "added" : "updated"} model ${name}`);
      await onChanged();
    } catch (error) {
      errorLine.textContent = describeApiError(error);
      errorLine.hidden = false;
      showStatus("err", `model write failed: ${describeApiError(error)}`);
    } finally {
      saveBtn.disabled = false;
    }
  });

  dialog.showModal();
}

// ---------------------------------------------------------------------------
// E6 — discovery picker
// ---------------------------------------------------------------------------

async function openModelPicker({ providerId, config, onChanged }) {
  const dialog = dialogShell("model-picker", `Fetch models — ${providerId}`);
  const stateHost = el("div", "model-picker-state", "Contacting the provider…");
  dialog.appendChild(stateHost);

  let entries = [];
  let selected = new Set();

  try {
    const result = await api("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify({ id: providerId }),
    });
    // E2 adds `entries` alongside the unchanged `models` name list. Names alone
    // cannot carry capabilities, so a response without `entries` is a contract
    // failure and is reported as one instead of silently degrading.
    if (!Array.isArray(result?.entries)) {
      throw new Error(
        "discovery returned no `entries` array — POST /api/providers/discover must return entries (E2); model names alone cannot be authored",
      );
    }
    entries = result.entries;
  } catch (error) {
    stateHost.className = "model-picker-state error";
    stateHost.textContent = `Discovery failed: ${describeApiError(error)}`;
    showStatus("err", `discover failed: ${describeApiError(error)}`);
    dialog.showModal();
    const closeActions = el("div", "actions");
    const closeBtn = el("button", "btn", "Close");
    closeBtn.addEventListener("click", () => closeAndRemove(dialog));
    closeActions.appendChild(closeBtn);
    dialog.appendChild(closeActions);
    return;
  }

  stateHost.remove();

  const configured = new Set(Object.keys(modelEntries(config)));

  const filterField = el("div", "ff");
  const filter = el("input");
  filter.type = "search";
  filter.id = "model-picker-filter";
  filter.placeholder = "Filter discovered models…";
  filterField.appendChild(filter);
  dialog.appendChild(filterField);

  const table = el("table", "model-table");
  const head = el("thead");
  const headRow = el("tr");
  const checkHead = el("th", "col-check");
  const selectAll = el("input");
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", "Select all addable discovered models");
  checkHead.appendChild(selectAll);
  headRow.appendChild(checkHead);
  for (const label of ["Model", "Capabilities", "Limits", "Source"]) headRow.appendChild(el("th", null, label));
  head.appendChild(headRow);
  table.appendChild(head);
  const tbody = el("tbody");
  table.appendChild(tbody);
  const pickerTableWrap = el("div", "model-table-wrap");
  pickerTableWrap.appendChild(table);
  dialog.appendChild(pickerTableWrap);

  const summary = el("p", "hint");
  dialog.appendChild(summary);

  const actions = el("div", "actions");
  const count = el("span", "muted model-picker-count");
  const cancelBtn = el("button", "btn", "Cancel");
  const addBtn = el("button", "btn primary", "Add selected");
  actions.appendChild(count);
  actions.appendChild(cancelBtn);
  actions.appendChild(addBtn);
  dialog.appendChild(actions);

  const boxes = new Map();

  function visibleEntries() {
    const query = filter.value.trim().toLowerCase();
    return entries.filter((item) => !query || String(item.name).toLowerCase().includes(query));
  }

  function render() {
    tbody.textContent = "";
    boxes.clear();
    for (const item of visibleEntries()) {
      const row = el("tr");
      row.dataset.model = item.name;
      const isConfigured = configured.has(item.name);

      const checkCell = el("td", "col-check");
      const box = el("input");
      box.type = "checkbox";
      box.dataset.model = item.name;
      box.checked = selected.has(item.name);
      box.disabled = isConfigured;
      checkCell.appendChild(box);
      row.appendChild(checkCell);
      boxes.set(item.name, box);

      const nameCell = el("td", "mono");
      nameCell.appendChild(el("span", null, item.name));
      if (isConfigured) nameCell.appendChild(el("span", "model-cap configured", "configured"));
      row.appendChild(nameCell);

      const capCell = el("td");
      capCell.appendChild(capabilityChips(item.capabilities));
      row.appendChild(capCell);

      row.appendChild(el("td", "mono", limitsText(item)));
      row.appendChild(el("td", null, item.source || "—"));
      tbody.appendChild(row);

      box.addEventListener("change", () => {
        if (box.checked) selected.add(item.name);
        else selected.delete(item.name);
        syncActions();
      });
    }
    const addable = visibleEntries().filter((item) => !configured.has(item.name));
    selectAll.disabled = !addable.length;
    selectAll.checked = addable.length > 0 && addable.every((item) => selected.has(item.name));
    const total = entries.length;
    summary.textContent = `${total} discovered · ${configured.size ? `${[...configured].filter((name) => entries.some((item) => item.name === name)).length} already configured and not selectable` : "none already configured"}`;
    syncActions();
  }

  function syncActions() {
    count.textContent = `${selected.size} selected`;
    addBtn.disabled = selected.size === 0;
  }

  filter.addEventListener("input", render);
  selectAll.addEventListener("change", () => {
    for (const item of visibleEntries()) {
      if (configured.has(item.name)) continue;
      if (selectAll.checked) selected.add(item.name);
      else selected.delete(item.name);
      const box = boxes.get(item.name);
      if (box) box.checked = selectAll.checked;
    }
    syncActions();
  });

  cancelBtn.addEventListener("click", () => closeAndRemove(dialog));

  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    try {
      // Exactly the checked set, in one E1 request.
      const add = {};
      for (const item of entries) {
        if (!selected.has(item.name)) continue;
        const payload = {};
        if (Array.isArray(item.capabilities) && item.capabilities.length) payload.capabilities = item.capabilities;
        if (item.maxTokens != null) payload.maxTokens = item.maxTokens;
        if (item.maxContextTokens != null) payload.maxContextTokens = item.maxContextTokens;
        add[item.name] = payload;
      }
      const names = Object.keys(add);
      if (!names.length) return;
      await writeModels(providerId, { add, reason: REASON.discovered });
      closeAndRemove(dialog);
      showStatus("ok", `added ${names.length} model(s): ${names.join(", ")}`);
      await onChanged();
    } catch (error) {
      addBtn.disabled = false;
      summary.className = "hint model-picker-error";
      summary.textContent = `Add failed: ${describeApiError(error)}`;
      showStatus("err", `add models failed: ${describeApiError(error)}`);
    }
  });

  render();
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// E5 — the drawer's Models section
// ---------------------------------------------------------------------------

/**
 * Render the editable model table into `host`.
 * options: { providerId, config, onChanged } where `config` is the freshly read
 * provider file and `onChanged` re-reads the provider after every write.
 */
export function renderModelsSection(host, options) {
  const { providerId, config, onChanged } = options;
  const models = modelEntries(config);
  const currentDefault = defaultModelOf(config);
  const names = Object.keys(models);

  const selected = new Set();
  let filterText = "";

  const root = el("div", "model-editor");

  const toolbar = el("div", "model-editor-toolbar");
  const filterField = el("div", "ff model-editor-filter");
  const filterInput = el("input");
  filterInput.type = "search";
  filterInput.id = "model-editor-filter";
  filterInput.placeholder = "Filter models…";
  filterInput.setAttribute("aria-label", "Filter provider models");
  filterField.appendChild(filterInput);
  toolbar.appendChild(filterField);

  const fetchBtn = el("button", "btn", "Fetch models");
  const addBtn = el("button", "btn", "Add model");
  toolbar.appendChild(fetchBtn);
  toolbar.appendChild(addBtn);
  root.appendChild(toolbar);

  const selectionBar = el("div", "model-editor-selection");
  const selectionCount = el("span", "muted");
  const removeBtn = el("button", "btn", "Remove selected");
  const defaultBtn = el("button", "btn", "Set as default");
  selectionBar.appendChild(selectionCount);
  selectionBar.appendChild(removeBtn);
  selectionBar.appendChild(defaultBtn);
  root.appendChild(selectionBar);

  const table = el("table", "model-table");
  const head = el("thead");
  const headRow = el("tr");
  const checkHead = el("th", "col-check");
  const selectAll = el("input");
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", "Select all visible models");
  checkHead.appendChild(selectAll);
  headRow.appendChild(checkHead);
  for (const label of ["Model", "Wire name", "Capabilities", "Limits", "Default", "Actions"]) {
    headRow.appendChild(el("th", null, label));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const tbody = el("tbody");
  table.appendChild(tbody);
  const tableWrap = el("div", "model-table-wrap");
  tableWrap.appendChild(table);
  root.appendChild(tableWrap);

  const emptyLine = el("p", "hint model-editor-empty");
  root.appendChild(emptyLine);

  const errorLine = el("p", "ff-error model-editor-error");
  errorLine.hidden = true;
  root.appendChild(errorLine);

  const boxes = new Map();

  function visibleNames() {
    const query = filterText.trim().toLowerCase();
    return names.filter((name) => !query || name.toLowerCase().includes(query));
  }

  function syncSelection() {
    selectionCount.textContent = `${selected.size} selected`;
    removeBtn.disabled = selected.size === 0;
    defaultBtn.disabled = selected.size !== 1;
    const visible = visibleNames();
    selectAll.disabled = !visible.length;
    selectAll.checked = visible.length > 0 && visible.every((name) => selected.has(name));
  }

  function reportError(prefix, error) {
    errorLine.textContent = `${prefix}: ${describeApiError(error)}`;
    errorLine.hidden = false;
    showStatus("err", `${prefix}: ${describeApiError(error)}`);
  }

  async function mutate(body, okMessage) {
    errorLine.hidden = true;
    try {
      await writeModels(providerId, body);
      showStatus("ok", okMessage);
      // No optimistic state: the drawer re-reads the provider after every write.
      await onChanged();
    } catch (error) {
      reportError("model write failed", error);
    }
  }

  function renderRows() {
    tbody.textContent = "";
    boxes.clear();
    const visible = visibleNames();
    for (const name of visible) {
      const entry = models[name];
      const row = el("tr");
      row.dataset.model = name;

      const checkCell = el("td", "col-check");
      const box = el("input");
      box.type = "checkbox";
      box.dataset.model = name;
      box.checked = selected.has(name);
      box.setAttribute("aria-label", `Select model ${name}`);
      checkCell.appendChild(box);
      row.appendChild(checkCell);
      boxes.set(name, box);

      row.appendChild(el("td", "mono", name));
      row.appendChild(el("td", "mono", entry?.wireName || "—"));
      const capCell = el("td");
      capCell.appendChild(capabilityChips(entry?.capabilities));
      row.appendChild(capCell);
      row.appendChild(el("td", "mono", limitsText(entry)));
      row.appendChild(el("td", null, name === currentDefault ? "default" : "—"));

      const actionCell = el("td", "model-row-actions");
      const editBtn = el("button", "btn", "Edit");
      editBtn.addEventListener("click", () => {
        openModelDialog({
          providerId,
          modelName: name,
          entry,
          detectedCapabilities: [],
          isNew: false,
          onChanged,
        });
      });
      const removeOne = el("button", "btn", "Remove");
      removeOne.addEventListener("click", () => {
        mutate({ remove: [name], reason: REASON.remove }, `removed model ${name}`);
      });
      actionCell.appendChild(editBtn);
      actionCell.appendChild(removeOne);
      row.appendChild(actionCell);

      tbody.appendChild(row);

      box.addEventListener("change", () => {
        if (box.checked) selected.add(name);
        else selected.delete(name);
        syncSelection();
      });
    }
    emptyLine.textContent = names.length
      ? visible.length
        ? ""
        : "No model matches the filter."
      : "No models authored yet. Use Fetch models to discover and pick them.";
    syncSelection();
  }

  filterInput.addEventListener("input", () => {
    filterText = filterInput.value;
    renderRows();
  });

  selectAll.addEventListener("change", () => {
    for (const name of visibleNames()) {
      if (selectAll.checked) selected.add(name);
      else selected.delete(name);
      const box = boxes.get(name);
      if (box) box.checked = selectAll.checked;
    }
    syncSelection();
  });

  removeBtn.addEventListener("click", () => {
    const targets = names.filter((name) => selected.has(name));
    if (!targets.length) return;
    mutate({ remove: targets, reason: REASON.remove }, `removed ${targets.length} model(s): ${targets.join(", ")}`);
  });

  defaultBtn.addEventListener("click", () => {
    const [name] = names.filter((item) => selected.has(item));
    if (!name) return;
    // E1 requires at least one of `add`/`remove` in every request, so a bare
    // `{defaultModel}` is `400 no_model_mutation`. The entry is re-sent verbatim
    // under `replace`, which leaves the model's config exactly as authored and
    // makes the default change the request's actual mutation.
    mutate(
      {
        add: { [name]: { ...models[name] } },
        replace: [name],
        defaultModel: name,
        reason: REASON.setDefault,
      },
      `default model is now ${name}`,
    );
  });

  addBtn.addEventListener("click", () => {
    openModelDialog({
      providerId,
      modelName: "",
      entry: null,
      detectedCapabilities: [],
      isNew: true,
      onChanged,
    });
  });

  fetchBtn.addEventListener("click", () => {
    openModelPicker({ providerId, config, onChanged });
  });

  renderRows();
  host.appendChild(root);
}
