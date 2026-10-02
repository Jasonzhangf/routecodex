// Providers onboarding smoke: the page modules must parse, the wizard/probe entry points
// must exist, and the page must consume the shared form primitives instead of forking them.
// Zero dependencies — runs with plain `node v3/admin-webui/providers-onboarding-smoke.mjs`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODULES = [
  "./app/core.js",
  "./app/shell.js",
  "./app/form.js",
  "./app/probe.js",
  "./app/views/providers.js",
  "./app/views/provider-models.js",
];

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertModuleParses(relativePath) {
  const text = source(relativePath);
  const tmp = path.join(
    os.tmpdir(),
    `rcc-providers-smoke-${process.pid}-${path.basename(relativePath)}`,
  );
  fs.writeFileSync(tmp, text);
  const result = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.rmSync(tmp, { force: true });
  assert.equal(
    result.status,
    0,
    `${relativePath} must parse as an ES module: ${result.stderr || result.stdout}`,
  );
}

for (const modulePath of MODULES) assertModuleParses(modulePath);

// ---------------------------------------------------------------------------
// page markup
// ---------------------------------------------------------------------------

const markup = source("./providers.html");
assert.match(markup, /<script type="module" src="\/app\/views\/providers\.js"><\/script>/);
assert.match(markup, /href="\/styles.css"/);
for (const id of [
  "summary-cards",
  "providers-panel",
  "providers-bulk-bar",
  "health-donut",
  "status-bar",
  "add-provider-btn",
  "wizard-panel",
  "wizard-steps",
  "wizard-summary",
  "wizard-body",
  "wizard-actions",
  "probe-panel",
  "probe-target",
  "probe-host",
  "patrol-panel",
  "patrol-provider",
  "patrol-plan",
  "patrol-status",
  "patrol-history",
  "import-panel",
  "import-text",
  "import-preview-btn",
  "import-run-btn",
  "import-summary",
  "import-results",
  "drawer-body",
]) {
  assert.match(markup, new RegExp(`id="${id}"`), `providers.html must expose #${id}`);
}

// ---------------------------------------------------------------------------
// shared shell + shared form primitives (no second implementation)
// ---------------------------------------------------------------------------

const shell = source("./app/shell.js");
assert.match(shell, /\["\/providers\.html", "providers", "Providers"/);
assert.match(shell, /export function initShell\(/);

const form = source("./app/form.js");
for (const primitive of [
  "createField",
  "createForm",
  "createErrorSummary",
  "createDirtyGuard",
  "confirmDialog",
]) {
  assert.match(form, new RegExp(`export function ${primitive}\\(`), `form.js must own ${primitive}`);
}

// confirmDialog is driven by explicit handlers, not by `<form method="dialog">`:
// `el()` forces `type="button"`, so a dialog form never submits and its `close`
// event never fires, which left the promise pending forever.
assert.doesNotMatch(
  form,
  /shell\.method = "dialog"/,
  "confirmDialog must not depend on form submission",
);
assert.match(form, /function settle\(accepted\)/);
assert.match(form, /confirm\.addEventListener\("click", \(\) => settle\(true\)\)/);
assert.match(form, /cancel\.addEventListener\("click", \(\) => settle\(false\)\)/);

// ---------------------------------------------------------------------------
// streaming probe terminal
// ---------------------------------------------------------------------------

const probe = source("./app/probe.js");
assert.match(probe, /export function createProbeTerminal\(/);
assert.match(probe, /export const PROBE_STAGES/);
assert.match(probe, /"l1_contract"/);
assert.match(probe, /l2_reachability_auth/);
assert.match(probe, /l3_semantic/);
for (const event of ["stage_started", "stage_result", "stage_failed", "evidence", "probe_complete"]) {
  assert.match(probe, new RegExp(`"${event}"`), `probe.js must handle the ${event} SSE event`);
}
assert.match(probe, /text\/event-stream/);
assert.match(probe, /requireAdminSession\(\)/);
assert.match(probe, /x-routecodex-admin-token/);
assert.match(probe, /\/api\/providers\/\$\{encodeURIComponent\(request\.id\)\}\/probe/);
assert.match(probe, /"\/api\/providers\/probe"/);
assert.match(probe, /terminal-line/);

// ---------------------------------------------------------------------------
// providers view: wizard + probe + patrol + import entry points
// ---------------------------------------------------------------------------

const view = source("./app/views/providers.js");
assert.match(view, /initShell\("providers",/);
assert.match(view, /requireAdminSession\(\)/);
assert.match(
  view,
  /import \{ confirmDialog, createDirtyGuard, createField, createForm, validators \} from "\.\.\/form\.js";/,
  "the wizard must consume app/form.js primitives",
);
assert.match(view, /import \{ PROBE_STAGES, createProbeTerminal, probeStageLabel \} from "\.\.\/probe\.js";/);
assert.doesNotMatch(
  view,
  /function createField\(/,
  "providers.js must not fork a second field implementation",
);
assert.doesNotMatch(
  view,
  /function createErrorSummary\(/,
  "providers.js must not fork a second error-summary implementation",
);
assert.match(view, /createForm\(\{ fields \}\)/);
assert.match(view, /createDirtyGuard\(\{/);
assert.match(view, /confirmDialog\(\{/);

// wizard ladder
for (const step of ["credentials", "discover", "validate", "probe", "commit", "route"]) {
  assert.match(view, new RegExp(`id: "${step}"`), `the wizard must declare the ${step} step`);
}
assert.match(view, /api\("\/api\/providers\/validate", \{ method: "POST"/);
assert.match(view, /api\("\/api\/providers\/discover", \{ method: "POST"/);
assert.match(view, /"\/api\/providers\/routes\/bind"/);
assert.match(view, /api\("\/api\/providers\/import", \{/);
assert.match(view, /probeTerminal\.run\(\{ config: candidate, stages \}\)/);
assert.match(view, /wizard\?\.open\(\)/);
assert.match(view, /openProbeFor\(/);
assert.match(view, /createProbeTerminal\(\)/);
assert.match(view, /encodeURIComponent\(id\)\}\/health/);
assert.match(view, /health-test/);
assert.match(view, /api\("\/api\/providers\/patrol\/status"\)/);
assert.match(view, /patrol\/results/);
assert.match(view, /method: "PUT"/);
assert.match(view, /method: "DELETE"/);
assert.match(view, /runImport\(true\)/);
assert.match(view, /runImport\(false\)/);

// ---------------------------------------------------------------------------
// provider model authoring (E4/E5/E6 live in their own module; E7/E8 in providers.js)
// ---------------------------------------------------------------------------

assert.match(
  view,
  /import \{ describeApiError, renderModelsSection \} from "\.\/provider-models\.js";/,
  "providers.js must delegate model authoring to app/views/provider-models.js",
);
assert.match(view, /renderModelsSection\(modelsPanel, \{/);
assert.match(view, /providers-bulk-bar/);
assert.match(view, /providers-select-all/);
assert.match(view, /setProvidersEnabled/);
assert.match(view, /bindProvidersToRoute/);
assert.match(view, /await confirmDialog\(\{/);

const models = source("./app/views/provider-models.js");
assert.match(models, /export function renderModelsSection\(/);
assert.match(models, /export function describeApiError\(/);
assert.match(models, /encodeURIComponent\(providerId\)\}\/models`/);
assert.match(models, /models\/capability-test`/);
assert.match(models, /api\("\/api\/providers\/discover", \{/);
assert.match(models, /body: JSON\.stringify\(\{ id: providerId \}\)/);
// E1: the replacement marker is a top-level list of names, never an entry key.
assert.match(models, /REPLACE_FIELD\] = \[name\]/);
assert.doesNotMatch(
  models,
  /payload\[REPLACE_FIELD\]|MODEL_ENTRY_REPLACE_FLAG/,
  "the replacement marker must not be written into the model entry",
);
// E4: a manual capability is written only after its test returned tested && passed.
assert.match(models, /entry\.source === "manual" && entry\.tested && entry\.passed/);
assert.match(models, /if \(!\(state\.tested && state\.passed\)\) failure = state\.detail;/);
assert.match(models, /state\.source = null;/);

// ---------------------------------------------------------------------------
// E1 round-trip regression (task-21)
//
// `POST /api/providers/:id/models` applies `add` as a WHOLE-ENTRY replacement, so a
// payload assembled only from the dialog's controls deletes every field the dialog
// does not render, and a capability list that omits a stored name deletes that too.
// These assertions drive the real payload builder and capability resolver.
// ---------------------------------------------------------------------------

const modelModule = await import(new URL("./app/views/provider-models.js", import.meta.url));

// One row per CANONICAL capability: `thinking` and `web_search_direct` are aliases
// the V2->V3 boundary folds into `reasoning` / `web_search`, so offering them as
// extra rows would let a write carry two names for one capability.
assert.ok(modelModule.MODEL_CAPABILITIES.includes("web_search"), "web_search must be a real row");
for (const alias of ["thinking", "web_search_direct"]) {
  assert.ok(
    !modelModule.MODEL_CAPABILITIES.includes(alias),
    `${alias} must not be a row: it normalizes to its canonical capability`,
  );
}
assert.equal(modelModule.normalizeCapability("thinking"), "reasoning");
assert.equal(modelModule.normalizeCapability("web_search_direct"), "web_search");
assert.equal(modelModule.normalizeCapability("web_search"), "web_search");
assert.equal(modelModule.normalizeCapability("not_a_capability"), null);

// A stored alias plus its canonical name must collapse to ONE written entry.
const aliased = modelModule.createCapabilitySession({ stored: ["text", "reasoning", "thinking"], detected: [] });
assert.deepEqual(
  modelModule.writtenCapabilities(aliased.session, aliased.preserved),
  ["text", "reasoning"],
  "thinking and reasoning must not both be written",
);

// A stored capability the vocabulary cannot name rides through verbatim.
const preserved = modelModule.createCapabilitySession({ stored: ["text", "web_search", "custom_probe"], detected: [] });
assert.deepEqual(preserved.preserved, ["custom_probe"]);
assert.deepEqual(modelModule.writtenCapabilities(preserved.session, preserved.preserved), [
  "text",
  "web_search",
  "custom_probe",
]);

// THE REGRESSION: edit a model that carries unrendered fields and a canonical
// capability the dialog does not offer, changing ONLY maxTokens.
const storedEntry = {
  aliases: ["mm"],
  capabilities: ["text", "web_search"],
  supportsStreaming: true,
  maxTokens: 8192,
  maxContext: 64000,
  maxContextTokens: 200000,
  contextWindow: 196608,
  contextTokenEstimateScaleBps: 10000,
  webSearchExecutionMode: "provider",
  features: { json_mode: true },
  wireName: null,
};
const editSession = modelModule.createCapabilitySession({ stored: storedEntry.capabilities, detected: [] });
const editPayload = modelModule.buildModelWritePayload({
  isNew: false,
  existing: storedEntry,
  values: {
    wireName: "",
    thinking: "",
    maxTokens: "4096",
    maxContextTokens: "200000",
    supportsStreaming: true,
    supportsThinking: false,
  },
  capabilities: modelModule.writtenCapabilities(editSession.session, editSession.preserved),
});
assert.equal(editPayload.maxTokens, 4096, "the edited field must be applied");
for (const [key, value] of Object.entries({
  maxContext: 64000,
  contextWindow: 196608,
  contextTokenEstimateScaleBps: 10000,
  webSearchExecutionMode: "provider",
})) {
  assert.deepEqual(editPayload[key], value, `${key} must survive an edit of another field`);
}
assert.deepEqual(editPayload.aliases, ["mm"]);
assert.deepEqual(editPayload.features, { json_mode: true });
assert.equal(editPayload.maxContextTokens, 200000);
assert.equal(editPayload.wireName, null, "an untouched null must not be narrowed");
assert.equal(editPayload.supportsStreaming, true);
assert.ok(editPayload.capabilities.includes("web_search"), "web_search must survive the edit");
assert.ok(!editPayload.capabilities.includes("web_search_direct"));

// Clearing a rendered field really clears it instead of silently keeping the old value.
const cleared = modelModule.buildModelWritePayload({
  isNew: false,
  existing: { maxTokens: 8192, capabilities: ["text"] },
  values: { wireName: "", thinking: "", maxTokens: "", maxContextTokens: "", supportsStreaming: false, supportsThinking: false },
  capabilities: ["text"],
});
assert.ok(!("maxTokens" in cleared), "clearing maxTokens must drop the field");

// A new model starts from nothing, so only rendered fields are written.
const fresh = modelModule.buildModelWritePayload({
  isNew: true,
  existing: undefined,
  values: { wireName: "wire-1", thinking: "", maxTokens: "16", maxContextTokens: "", supportsStreaming: false, supportsThinking: false },
  capabilities: ["text"],
});
assert.deepEqual(fresh, { wireName: "wire-1", maxTokens: 16, capabilities: ["text"] });

// A non-positive numeric control is rejected instead of written.
assert.throws(
  () =>
    modelModule.buildModelWritePayload({
      isNew: true,
      existing: undefined,
      values: { wireName: "", thinking: "", maxTokens: "0", maxContextTokens: "", supportsStreaming: false, supportsThinking: false },
      capabilities: ["text"],
    }),
  /maxTokens must be a positive number/,
);

console.log("providers onboarding smoke passed");
