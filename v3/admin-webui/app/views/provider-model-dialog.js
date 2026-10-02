// RCC V3 Admin WebUI — provider model authoring: the add/edit model dialog (E5 + E4).
//
// The dialog renders the model's rendered controls, the capability gate, and the
// E1 write. A capability the operator ticks by hand is written only after
// `POST /api/providers/:id/models/capability-test` returned `passed: true` for that
// capability in this dialog session.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-model-dialog.js)

import { el, showStatus } from "../core.js";
import {
  REPLACE_FIELD,
  REASON,
  buildModelWritePayload,
  describeApiError,
  requestCapabilityTest,
  writeModels,
} from "./provider-model-api.js";
import {
  MODEL_CAPABILITIES,
  capabilitySourceLabel,
  createCapabilitySession,
  writtenCapabilities,
} from "./provider-model-capabilities.js";

export function dialogShell(className, title) {
  const dialog = el("dialog", `modal amb-surface amb-elevation-2 ${className}`);
  const heading = el("h2", "model-dialog-title", title);
  dialog.appendChild(heading);
  document.body.appendChild(dialog);
  return dialog;
}

export function closeAndRemove(dialog) {
  if (dialog.open) dialog.close();
  dialog.remove();
}

// ---------------------------------------------------------------------------
// E5/E4 — add or edit one model
// ---------------------------------------------------------------------------

export function openModelDialog({ providerId, modelName, entry, detectedCapabilities, isNew, onChanged }) {
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
  const { session, preserved } = createCapabilitySession({
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
    const write = writtenCapabilities(session, preserved);
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

    // Capabilities outside the canonical vocabulary are shown but not editable: they
    // are not operator claims (so they never go through the E4 gate) and they must
    // ride through the write verbatim, because `add` replaces the whole entry.
    if (preserved.length) {
      const row = el("div", "model-cap-row model-cap-preserved");
      row.dataset.capability = "preserved";
      row.appendChild(el("span", "model-cap-name", "preserved"));
      const chips = el("span", "model-cap-chips");
      for (const capability of preserved) {
        chips.appendChild(el("span", "model-cap chip", `${capability} — kept verbatim`));
      }
      row.appendChild(chips);
      row.appendChild(el("span", "model-cap-source", "authored — outside the canonical set, preserved on write"));
      capRows.appendChild(row);
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

      // `add` is a whole-entry replacement, so the payload round-trips the stored
      // entry and overlays only what the operator changed. See buildModelWritePayload.
      const payload = buildModelWritePayload({
        isNew,
        existing,
        values: {
          wireName: inputs.wireName.value,
          thinking: inputs.thinking.value,
          maxTokens: inputs.maxTokens.value,
          maxContextTokens: inputs.maxContextTokens.value,
          supportsStreaming: boolInputs.supportsStreaming.checked,
          supportsThinking: boolInputs.supportsThinking.checked,
        },
        capabilities: writtenCapabilities(session, preserved),
      });

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
