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

console.log("providers onboarding smoke passed");
