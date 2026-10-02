// RCC V3 Admin WebUI — the provider drawer's editable Models section (E5).
//
// Owns the model table, its selection bar, and the entry points into the add/edit
// dialog (E5/E4) and the discovery picker (E6). Every mutation goes through the E1
// endpoint and is followed by a fresh provider read (`onChanged`), so nothing here
// keeps optimistic state.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-models.js)

import { el, showStatus } from "../core.js";
import { REASON, defaultModelOf, describeApiError, limitsText, modelEntries, writeModels } from "./provider-model-api.js";
import { capabilityChips } from "./provider-model-capabilities.js";
import { openModelDialog } from "./provider-model-dialog.js";
import { openModelPicker } from "./provider-model-picker.js";

// `providers.js` keeps importing `{ describeApiError, renderModelsSection }` from this
// module; the error identity lives with the E1 plumbing it describes.
export { describeApiError };

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
