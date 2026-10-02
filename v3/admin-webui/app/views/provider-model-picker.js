// RCC V3 Admin WebUI — provider model authoring: the discovery picker (E6).
//
// "Fetch models": authenticated discovery, then a checkbox picker whose checked set
// is written in exactly one E1 request.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-model-picker.js)

import { api, el, showStatus } from "../core.js";
import { REASON, describeApiError, limitsText, modelEntries, writeModels } from "./provider-model-api.js";
import { canonicalCapabilities, capabilityChips } from "./provider-model-capabilities.js";
import { closeAndRemove, dialogShell } from "./provider-model-dialog.js";

// ---------------------------------------------------------------------------
// E6 — discovery picker
// ---------------------------------------------------------------------------

export async function openModelPicker({ providerId, config, onChanged }) {
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
        const capabilities = canonicalCapabilities(item.capabilities);
        if (capabilities.length) payload.capabilities = capabilities;
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
