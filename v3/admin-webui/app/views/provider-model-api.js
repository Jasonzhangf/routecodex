// RCC V3 Admin WebUI — provider model authoring: E1 plumbing and payload construction.
//
// Owns the provider-model HTTP surface and the `add` entry builder. Every mutation
// goes through the E1 endpoint and is followed by a fresh provider read
// (`onChanged`), so nothing here keeps optimistic state.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-model-api.js)

import { api } from "../core.js";

// E1 refuses `add` for an existing name with `409 model_exists` unless that name
// is listed in the request's top-level `replace` list. The marker is a list of
// names and never a key inside the entry, so an entry object stays pure config
// fields and no control flag can be absorbed by `V2ProviderModelConfig` as a
// silent no-op.
export const REPLACE_FIELD = "replace";

export const REASON = {
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

export async function writeModels(providerId, body) {
  return api(modelsPath(providerId), { method: "POST", body: JSON.stringify(body) });
}

/** E4 capability test. Read-only on the server: it must never mutate config. */
export async function requestCapabilityTest(providerId, model, capabilities) {
  return api(capabilityTestPath(providerId), {
    method: "POST",
    body: JSON.stringify({ model, capabilities }),
  });
}

export function modelEntries(config) {
  return config?.provider?.models || {};
}

export function defaultModelOf(config) {
  return config?.provider?.defaultModel || null;
}

export function limitsText(entry) {
  const parts = [];
  if (entry?.maxTokens != null) parts.push(`maxTokens ${Number(entry.maxTokens).toLocaleString()}`);
  if (entry?.maxContextTokens != null) parts.push(`maxContext ${Number(entry.maxContextTokens).toLocaleString()}`);
  return parts.length ? parts.join(" · ") : "—";
}

// ---------------------------------------------------------------------------
// E1 payload construction
// ---------------------------------------------------------------------------

function positiveInteger(key, raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive number`);
  return Math.trunc(parsed);
}

/**
 * Build one `add` entry for `POST /api/providers/:id/models`.
 *
 * The server applies `add` as a WHOLE-ENTRY replacement, so an entry assembled only
 * from this dialog's controls resets every `V2ProviderModelConfig` field the dialog
 * does not render (`maxContext`, `contextWindow`, `aliases`, `features`,
 * `contextTokenEstimateScaleBps`, `webSearchExecutionMode`, `webSearchBackend`, …)
 * back to its schema default. The payload therefore starts from the entry already on
 * disk and overlays ONLY the controls the operator actually changed; an untouched
 * control leaves the stored value exactly as it was, including a stored `null`.
 *
 * `capabilities` is the one field always written: it is the resolved union, so the
 * stored array is normalized to canonical names (aliases folded) in a single place.
 */
export function buildModelWritePayload({ isNew, existing, values, capabilities }) {
  const before = isNew ? {} : existing || {};
  const payload = { ...before };

  const overlayText = (key, transform) => {
    const raw = String(values[key] ?? "").trim();
    const previous = before[key] == null ? "" : String(before[key]);
    if (raw === previous) return;
    if (!raw) {
      delete payload[key];
      return;
    }
    payload[key] = transform ? transform(key, raw) : raw;
  };
  overlayText("wireName");
  overlayText("thinking");
  overlayText("maxTokens", positiveInteger);
  overlayText("maxContextTokens", positiveInteger);

  for (const key of ["supportsStreaming", "supportsThinking"]) {
    const next = Boolean(values[key]);
    // An untouched checkbox must not narrow a stored `null` into an explicit `false`.
    if (next === Boolean(before[key])) continue;
    payload[key] = next;
  }

  payload.capabilities = capabilities;
  return payload;
}
