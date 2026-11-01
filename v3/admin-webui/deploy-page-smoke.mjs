// Deploy page smoke: the page modules must parse and the deploy entry points must exist.
// Zero dependencies — runs with plain `node v3/admin-webui/deploy-page-smoke.mjs`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODULES = [
  "./app/core.js",
  "./app/shell.js",
  "./app/form.js",
  "./app/views/deploy.js",
];

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertModuleParses(relativePath) {
  const text = source(relativePath);
  const tmp = path.join(
    os.tmpdir(),
    `rcc-deploy-smoke-${process.pid}-${path.basename(relativePath)}`,
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

const markup = source("./deploy.html");
assert.match(markup, /<script type="module" src="\/app\/views\/deploy\.js"><\/script>/);
assert.match(markup, /id="environment-cards"/);
assert.match(markup, /id="doctor-panel"/);
assert.match(markup, /id="lifecycle-panel"/);
assert.match(markup, /id="first-run-guide"/);
assert.match(markup, /id="status-bar"/);
assert.match(markup, /href="\/styles.css"/);

const shell = source("./app/shell.js");
assert.match(shell, /\["\/deploy\.html", "deploy", "Deploy"/);
assert.match(shell, /export function ensureAdminSession\(\)/);
assert.match(shell, /export async function requireAdminSession\(\)/);
assert.match(shell, /setAdminToken\(token\)/);
assert.match(shell, /fetch\("\/api\/admin\/session"/);
assert.match(shell, /export function initShell\(/);

const form = source("./app/form.js");
assert.match(form, /export function createField\(/);
assert.match(form, /export function createErrorSummary\(/);
assert.match(form, /export function createForm\(/);
assert.match(form, /export function createDirtyGuard\(/);
assert.match(form, /export function confirmDialog\(/);
assert.match(form, /aria-invalid/);
assert.match(form, /aria-describedby/);
assert.match(form, /error-summary/);
assert.match(form, /"ff-hint"/);

const view = source("./app/views/deploy.js");
assert.match(view, /initShell\("deploy",/);
assert.match(view, /requireAdminSession\(\)/);
assert.match(view, /confirmDialog\(/);
assert.match(view, /api\("\/api\/environment"\)/);
assert.match(view, /api\("\/api\/environment\/doctor", \{ method: "POST" \}\)/);
assert.match(view, /api\("\/api\/runtime\/restart", \{ method: "POST" \}\)/);
assert.match(view, /api\("\/api\/reload", \{ method: "POST" \}\)/);
assert.match(view, /terminal-line/);
assert.match(view, /First run/);

console.log("deploy page smoke passed");
