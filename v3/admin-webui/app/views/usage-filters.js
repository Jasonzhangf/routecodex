// RCC V3 Admin WebUI — Usage (Requests) filter model.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-filters.js)
//
// Whitelist-by-default, opt-out filter rail.
// - Within a layer, checked values are OR (a row passes the layer if it matches
//   at least one checked value).
// - Across layers the layers AND (Status × Provider × Model × Error code).
// - "No values checked in a layer" means "this layer excludes everything", so
//   the table is empty — the visible signal that the user hid everything.
// - New values that appear after a refresh are added to the checked set
//   automatically, so a brand-new provider or error code is never silently
//   hidden.

import { api, el } from "../core.js";
import { state, hooks } from "./usage-state.js";

export const STATUS_KIND_LABELS = { success: "Success (2xx)", error: "Error (4xx/5xx)", cancelled: "Cancelled (499)", active: "In progress" };

const LAYER_KEYS = ["status", "provider", "model", "errorCode"];

function layerValues(layer) {
  const rail = state.railFacets || {};
  if (layer === "status") return Object.keys(STATUS_KIND_LABELS);
  if (layer === "provider") return Object.keys(rail.providers || {});
  if (layer === "model") return Object.keys(rail.models || {});
  if (layer === "errorCode") return Object.keys(rail.error_status_codes || {});
  return [];
}

export function activePlans() {
  // Build a flat list of {status, provider, model, errorCode} permutations from
  // the user's include sets.
  //
  // A null set means the layer has not been seeded yet, so it must not
  // constrain the query — otherwise the very first load, which happens before
  // the unfiltered value list arrives, would hide every row. An *empty* set is
  // different: the user unchecked everything in that layer, which must yield
  // zero plans and therefore zero rows rather than silently dropping the
  // constraint.
  //
  // A layer with every known value checked is indistinguishable from no
  // constraint, so it is dropped. That keeps the common "nothing filtered" case
  // at a single request instead of the product of all four layers.
  const active = [];
  for (const key of LAYER_KEYS) {
    const set = state[`${key}Include`];
    if (set == null) continue;
    if (!set.size) return [];
    const every = layerValues(key);
    if (every.length && every.every((value) => set.has(value))) continue;
    active.push([key, [...set]]);
  }
  const plans = [{}];
  for (const [key, values] of active) {
    const next = [];
    for (const plan of plans) {
      for (const value of values) next.push({ ...plan, [key]: value });
    }
    plans.splice(0, plans.length, ...next);
  }
  return plans;
}

export async function fetchPlan(base, plan) {
  const params = new URLSearchParams(base);
  if (plan.status) params.set("status", plan.status);
  if (plan.provider) params.set("provider", plan.provider);
  if (plan.model) params.set("model", plan.model);
  if (plan.errorCode) params.set("error_status_code", plan.errorCode);
  return api(`/api/observability/records?${params}`);
}

export function seedIncludeSets() {
  // A null include-set means "the user has not chosen yet", so the layer is
  // unconstrained and every value is admitted. Seeding happens once the
  // unfiltered value list is known.
  //
  // Only genuinely new values are added to an already-seeded layer: a value the
  // user unchecked must stay unchecked, or the next load would silently undo
  // their choice. `knownLayerValues` remembers what has already been offered
  // for exactly that reason.
  const rail = state.railFacets || {};
  const buckets = [
    ["statusInclude", layerValues("status")],
    ["providerInclude", Object.keys(rail.providers || {})],
    ["modelInclude", Object.keys(rail.models || {})],
    ["errorCodeInclude", Object.keys(rail.error_status_codes || {})],
  ];
  for (const [key, values] of buckets) {
    if (!values.length) continue;
    const seen = state.knownLayerValues[key] || (state.knownLayerValues[key] = new Set());
    if (state[key] == null) {
      state[key] = new Set(values);
    } else {
      for (const value of values) {
        if (!seen.has(value)) state[key].add(value);
      }
    }
    values.forEach((value) => seen.add(value));
  }
}

export function allLayerValues(layer) {
  return layerValues(layer);
}

export function checkAll(layer) {
  // "All" restores the default: every value in the layer is checked again.
  const key = `${layer}Include`;
  state[key] = new Set(layerValues(layer));
}

export function drilldownErrorStatus(code) {
  // Drill into Entries narrowed to one status code. Error codes are their own
  // filter layer now, so set that layer to just this code and make sure the
  // status layer still admits error rows.
  state.page = 1;
  state.statusInclude = new Set(["error"]);
  state.errorCodeInclude = new Set([String(code)]);
}

// `entries` is [storedValue, displayLabel, count]: the checkbox tracks the
// value that goes on the wire while the row shows the friendly label.
// Rebuilding the checkbox nodes on every data load destroys the node the user
// is currently interacting with, so the rail is only re-rendered when its
// contents actually change; otherwise the existing inputs are updated in place.
export function checkboxList(container, entries, selectedSet, onToggle) {
  if (!container) return;
  const signature = JSON.stringify(entries.map(([value, label, count]) => [value, label, count]));
  if (container.dataset.signature === signature) {
    const inputs = container.querySelectorAll("input[type=checkbox]");
    entries.forEach(([, label], index) => {
      const input = inputs[index];
      if (input) input.checked = selectedSet.has(label);
    });
    return;
  }
  container.dataset.signature = signature;
  container.replaceChildren(...entries.map(([value, label, count]) => {
    const item = el("label", "filter-item");
    const input = el("input");
    input.type = "checkbox";
    input.checked = selectedSet.has(label);
    input.addEventListener("change", () => onToggle(label, input.checked));
    item.append(input, el("span", null, label), el("span", "n", String(count)));
    return item;
  }));
  if (!entries.length) {
    container.appendChild(el("span", "mono muted tiny", "Nothing recorded yet"));
  }
}

// `onChange` defaults to the standard "re-query from page 1" reaction, which is
// what every caller wants; it is a parameter only so tests can observe a toggle
// without driving the loader.
export function renderRail(onChange = () => { state.page = 1; hooks.loadRecords(); }) {
  const stats = state.stats || {};
  // The value list and the include-set seeding both come from the unfiltered
  // rail snapshot (see seedIncludeSets). A null set here means the snapshot has
  // not arrived yet; render it as unconstrained rather than as an empty filter.
  const kindKeys = layerValues("status");
  const rail = state.railFacets || {};

  state.kindCounts = {
    success: Number(stats.success_count || 0),
    error: Number(stats.error_count || 0),
    cancelled: Number(stats.cancelled_count || 0),
    active: Number(stats.active_count || 0),
  };
  state.providerCounts = { ...(rail.providers || {}) };
  state.modelCounts = { ...(rail.models || {}) };
  state.errorCodeCounts = { ...(rail.error_status_codes || {}) };

  checkboxList(document.getElementById("filter-status"),
    kindKeys.map((kind) => [kind, STATUS_KIND_LABELS[kind], state.kindCounts[kind] || 0]),
    new Set([...(state.statusInclude || [])].map((kind) => STATUS_KIND_LABELS[kind])),
    (label, on) => {
      const kind = kindKeys.find((key) => STATUS_KIND_LABELS[key] === label);
      on ? state.statusInclude.add(kind) : state.statusInclude.delete(kind);
      onChange();
    });
  checkboxList(document.getElementById("filter-provider"),
    Object.entries(state.providerCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, name, count]),
    new Set([...(state.providerInclude || [])]),
    (value, on) => {
      on ? state.providerInclude.add(value) : state.providerInclude.delete(value);
      onChange();
    });
  checkboxList(document.getElementById("filter-model"),
    Object.entries(state.modelCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, name, count]),
    new Set([...(state.modelInclude || [])]),
    (value, on) => {
      on ? state.modelInclude.add(value) : state.modelInclude.delete(value);
      onChange();
    });
  checkboxList(document.getElementById("filter-error-code"),
    Object.entries(state.errorCodeCounts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([code, count]) => [code, code, count]),
    new Set([...(state.errorCodeInclude || [])]),
    (value, on) => {
      on ? state.errorCodeInclude.add(value) : state.errorCodeInclude.delete(value);
      onChange();
    });
  // "Clear" re-checks every value rather than unchecking it: the default is
  // "show everything", so clearing a filter means returning to that default.
  document.querySelectorAll(".filter-clear").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.clear;
      if (key === "statusInclude") checkAll("status");
      if (key === "providerInclude") checkAll("provider");
      if (key === "modelInclude") checkAll("model");
      if (key === "errorCodeInclude") checkAll("errorCode");
      onChange();
    };
  });
}
