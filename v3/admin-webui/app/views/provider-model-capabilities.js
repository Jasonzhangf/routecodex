// RCC V3 Admin WebUI — provider model capability vocabulary and the E4 test gate.
//
// Owns the canonical capability names and the provenance a single add/edit dialog
// session keeps per capability:
//   default  — the baseline every model gets (`text`), never operator-ticked.
//   detected — came from the provider's own discovery response, or was already
//              authored in the provider file. The file records no provenance, so
//              the dialog must not re-assert an already-authored capability as a
//              new manual claim; carrying it forward is not a new assertion.
//   manual   — a NEW claim the operator made in this dialog. It is written only
//              after its capability test returned `tested && passed` here.
//
// Zero-build ES module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_model_authoring (v3/admin-webui/app/views/provider-model-capabilities.js)

import { el } from "../core.js";

// The canonical capability vocabulary the runtime and the candidate validator
// accept (`validate.rs`). `text` is the baseline every model gets, so it is always
// present and is never an operator claim.
//
// `thinking` and `web_search_direct` are deliberately NOT rows: the V2->V3 boundary
// folds them into `reasoning` and `web_search` (`normalize_v2_capabilities`), so a
// separate row for each alias would offer the operator two controls for one
// capability and a write carrying both would be rejected as a duplicate.
export const MODEL_CAPABILITIES = [
  "text",
  "reasoning",
  "tools",
  "web_search",
  "multimodal",
  "vision",
  "longcontext",
  "no_reasoning_summary",
  "tool_outputs",
];

// The exact alias map `normalize_v2_capabilities` applies at the V2->V3 boundary.
const CAPABILITY_ALIASES = {
  thinking: "reasoning",
  web_search_direct: "web_search",
};

/**
 * Canonical name for a stored/discovered capability, or `null` when the canonical
 * vocabulary does not model it. Callers must preserve a `null` verbatim rather than
 * drop it: the write replaces the whole entry, so anything omitted here is deleted
 * from the provider file.
 */
export function normalizeCapability(capability) {
  const name = String(capability ?? "").trim();
  if (!name) return null;
  const canonical = CAPABILITY_ALIASES[name] || name;
  return MODEL_CAPABILITIES.includes(canonical) ? canonical : null;
}

export function capabilityChips(capabilities) {
  const host = el("div", "model-caps");
  for (const capability of capabilities || []) {
    host.appendChild(el("span", "model-cap", capability));
  }
  if (!host.childElementCount) host.appendChild(el("span", "muted", "—"));
  return host;
}

// ---------------------------------------------------------------------------
// E4 — capability session
// ---------------------------------------------------------------------------

/**
 * Build the dialog's capability state.
 *
 * Returns `{ session, preserved }`:
 *   * `session` holds one entry per CANONICAL capability, with a stored alias
 *     (`thinking`) pre-ticking the row it normalizes to (`reasoning`).
 *   * `preserved` holds the authored capabilities the canonical vocabulary does not
 *     model. They are not operator claims, so they never go through the E4 gate, but
 *     they MUST ride through the write: the E1 request replaces the whole entry, so
 *     omitting them would silently delete them from the provider file.
 */
export function createCapabilitySession({ stored, detected }) {
  const session = new Map();
  for (const capability of MODEL_CAPABILITIES) {
    session.set(capability, { source: null, tested: false, passed: false, detail: null, refused: false });
  }
  session.get("text").source = "default";

  const preserved = [];
  for (const capability of stored || []) {
    const canonical = normalizeCapability(capability);
    if (canonical) {
      session.get(canonical).source = "detected";
      continue;
    }
    const name = String(capability ?? "").trim();
    if (name && !preserved.includes(name)) preserved.push(name);
  }
  // Discovery may only propose capabilities the validator can check; adopting an
  // unknown name would author an unchecked claim, so those are ignored.
  for (const capability of detected || []) {
    const canonical = normalizeCapability(capability);
    if (canonical) session.get(canonical).source = "detected";
  }
  return { session, preserved };
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

/**
 * The capability array actually written: the ticked canonical rows plus every
 * preserved-verbatim capability. Both halves are deduplicated by their canonical
 * name, so an authored `thinking` next to `reasoning` cannot produce the duplicate
 * the candidate validator rejects.
 */
export function writtenCapabilities(session, preserved) {
  const out = writableCapabilities(session);
  for (const capability of preserved || []) {
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

/**
 * Canonical, de-duplicated array for a capability set proposed by discovery. A
 * discovered name the canonical vocabulary does not model is dropped rather than
 * authored: it is a proposal, not an existing claim, and writing an unknown name
 * would make the candidate validator reject the whole request.
 */
export function canonicalCapabilities(capabilities) {
  const out = [];
  for (const capability of capabilities || []) {
    const canonical = normalizeCapability(capability);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function capabilitySourceLabel(entry) {
  if (entry.refused) return `refused — ${entry.detail || "capability test did not pass"}`;
  if (entry.source === "default") return "default — baseline, always on";
  if (entry.source === "detected") return "detected — no test required";
  if (entry.source === "manual") {
    if (entry.detail === "testing…") return "manual — testing…";
    return "manual — test passed in this session";
  }
  return "not set";
}
