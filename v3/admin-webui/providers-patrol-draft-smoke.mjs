// Providers patrol draft regression: an inventory auto-refresh must not rebuild
// the patrol editor while it holds unsaved input. The editor DOM owns the draft;
// the refresh may update only the read-only stored-plan rows and status/history.
//
// Zero dependencies: runs with plain `node v3/admin-webui/providers-patrol-draft-smoke.mjs`.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./app/views/providers.js", import.meta.url), "utf8");
const start = source.indexOf("function selectPatrolProvider(");
const end = source.indexOf("function resultRow(", start);
assert.ok(start >= 0 && end > start, "providers.js must expose the patrol editor owners");
const patrolSource = source.slice(start, end);

// Minimal DOM: enough for the patrol editor, rows and refresh path. It is not a
// general browser replacement; the public browser receipt is separate.
let activeElement = null;

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.listeners = {};
    this.text = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.type = "";
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  set innerHTML(value) {
    this.text = "";
    this.children = [];
    this.html = value;
  }

  get innerHTML() {
    return this.html || "";
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners[type] || []) handler({ target: this });
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    activeElement = this;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSelector(node, selector) {
  if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
  const input = selector.match(/^input\[type=(\w+)\]$/);
  if (input) return node.tagName === "input" && node.type === input[1];
  return node.tagName === selector;
}

function el(tag, className, text) {
  const node = new FakeNode(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function resultRow(label, value) {
  const row = el("div", "row");
  row.appendChild(el("span", "name", label));
  row.appendChild(el("span", "meta mono", value));
  return row;
}

const planHost = new FakeNode("div");
const historyHost = new FakeNode("div");
const statusHost = new FakeNode("div");
const elements = {
  "patrol-plan": planHost,
  "patrol-history": historyHost,
  "patrol-status": statusHost,
  "patrol-panel": new FakeNode("div"),
};
const document = {
  getElementById: (id) => elements[id] || null,
  createTextNode: (text) => {
    const node = new FakeNode("#text");
    node.textContent = text;
    return node;
  },
  get activeElement() {
    return activeElement;
  },
};

const state = {
  patrolProvider: "alpha",
  patrolDirty: false,
  patrolEditorProvider: null,
  patrolEditorEpoch: 0,
};
const plans = {
  alpha: { enabled: false, interval_secs: 300, stages: ["l1_contract", "l2_reachability_auth"] },
  beta: { enabled: true, interval_secs: 600, stages: ["l1_contract"] },
};
const calls = [];
let statusTick = 0;
let nextMutationGate = null;

// Hold the next PUT/DELETE so a test can interleave a provider switch.
function holdNextApi() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const gate = {
    promise,
    release: () => {
      release();
      return promise;
    },
  };
  nextMutationGate = gate;
  return gate;
}

async function api(path, options = {}) {
  calls.push(`${options.method || "GET"} ${path}`);
  const match = path.match(/^\/api\/providers\/([^/]+)\/patrol(\/results|\/run)?$/);
  if (!match) {
    if (path === "/api/providers/patrol/status") {
      statusTick += 1;
      return { plan_count: 2, enabled_count: 1, next_tick_ms: statusTick, results_path: "/tmp/results" };
    }
    throw new Error(`unexpected api ${path}`);
  }
  const id = decodeURIComponent(match[1]);
  if (match[2] === "/results") return { results: [] };
  if (match[2] === "/run") return { ok: true, result: { stages: [] } };
  if (!options.method) {
    return { provider_id: id, stored: true, plan: structuredClone(plans[id]), last_run_epoch_ms: null };
  }
  if (nextMutationGate) {
    const gate = nextMutationGate;
    nextMutationGate = null;
    await gate.promise;
  }
  if (options.method === "PUT") {
    plans[id] = JSON.parse(options.body);
    return { ok: true, provider_id: id, stored: true, plan: plans[id] };
  }
  if (options.method === "DELETE") {
    delete plans[id];
    return { ok: true };
  }
  throw new Error(`unexpected ${options.method} ${path}`);
}

const context = vm.createContext({
  state,
  document,
  el,
  resultRow,
  api,
  PROBE_STAGES: ["l1_contract", "l2_reachability_auth", "l3_semantic"],
  fmtMs: (value) => `${value} ms`,
  badge: (status) => el("span", `badge ${status}`, status),
  showStatus: () => {},
  Date,
  Number,
  encodeURIComponent,
  JSON,
});
vm.runInContext(`${patrolSource}\nthis.__loadPatrol = loadPatrol;\nthis.__selectPatrolProvider = selectPatrolProvider;`, context);
const loadPatrol = context.__loadPatrol;
const selectPatrolProvider = context.__selectPatrolProvider;

async function settle(turns = 25) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fire(node, type) {
  node.dispatch(type);
}

function readState() {
  const number = planHost.querySelector("input[type=number]");
  const boxes = planHost.querySelectorAll("input[type=checkbox]");
  return {
    interval: number?.value,
    enabled: boxes[0]?.checked,
    stages: boxes.slice(1).map((box) => box.checked),
    focused: activeElement === number,
    readOnly: planHost.querySelector(".patrol-readonly")?.textContent || "",
    status: statusHost.textContent,
  };
}

await loadPatrol();
const initial = readState();
assert.equal(initial.interval, "300");
assert.equal(initial.enabled, false);
assert.deepEqual(initial.stages, [true, true, false]);

const number = planHost.querySelector("input[type=number]");
const boxes = planHost.querySelectorAll("input[type=checkbox]");
number.value = "777";
fire(number, "input");
boxes[0].checked = true;
fire(boxes[0], "change");
boxes[2].checked = false;
fire(boxes[2], "change");
boxes[3].checked = true;
fire(boxes[3], "change");
number.focus();
assert.equal(state.patrolDirty, true, "editing must mark the patrol draft dirty");
assert.equal(activeElement, number);

const editorNode = planHost.querySelector(".patrol-editor");
assert.ok(editorNode, "the live editor must be identifiable");
const statusBefore = statusHost.textContent;
const callsBefore = calls.length;

// Another writer updates the stored plan. The refresh must show that read-only
// truth without replacing the editor or its draft.
plans.alpha = { enabled: true, interval_secs: 300, stages: ["l1_contract"] };
await loadPatrol();
const refreshed = readState();
assert.equal(planHost.querySelector(".patrol-editor"), editorNode, "auto refresh must keep the editor node");
assert.equal(refreshed.interval, "777", "auto refresh must keep the draft interval");
assert.equal(refreshed.enabled, true, "auto refresh must keep the draft enabled state");
assert.deepEqual(refreshed.stages, [true, false, true], "auto refresh must keep the draft stage selection");
assert.equal(refreshed.focused, true, "auto refresh must keep editor focus");
assert.match(refreshed.readOnly, /interval_secs300/);
assert.match(refreshed.readOnly, /l1_contract(?!,)/);
assert.notEqual(refreshed.status, statusBefore, "auto refresh must update read-only status");
assert.ok(calls.length > callsBefore, "auto refresh must keep polling");

// A real provider switch is a declared reload and replaces the draft.
state.patrolProvider = "beta";
state.patrolDirty = false;
state.patrolEditorProvider = null;
await loadPatrol();
const beta = readState();
assert.equal(beta.interval, "600");
assert.equal(beta.enabled, true);
assert.deepEqual(beta.stages, [true, false, false]);

// Switching back reloads alpha's stored truth, not the earlier draft.
state.patrolProvider = "alpha";
state.patrolDirty = false;
state.patrolEditorProvider = null;
await loadPatrol();
const alpha = readState();
assert.equal(alpha.interval, "300");
assert.equal(alpha.enabled, true);
assert.deepEqual(alpha.stages, [true, false, false]);

// Save updates the editor only from the read that follows the successful PUT.
const alphaNumber = planHost.querySelector("input[type=number]");
const alphaBoxes = planHost.querySelectorAll("input[type=checkbox]");
const editorBeforeSave = planHost.querySelector(".patrol-editor");
alphaNumber.value = "900";
fire(alphaNumber, "input");
alphaBoxes[3].checked = true;
fire(alphaBoxes[3], "change");
planHost.querySelectorAll("button").find((button) => button.textContent === "Save plan").click();
for (let attempt = 0; attempt < 50 && plans.alpha.interval_secs !== 900; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
for (let attempt = 0; attempt < 50 && planHost.querySelector(".patrol-editor") === editorBeforeSave; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const saved = readState();
assert.deepEqual(plans.alpha, { enabled: true, interval_secs: 900, stages: ["l1_contract", "l3_semantic"] });
assert.equal(saved.interval, "900");
assert.equal(saved.enabled, true);
assert.deepEqual(saved.stages, [true, false, true]);
assert.equal(state.patrolDirty, false);
assert.match(saved.readOnly, /interval_secs900/);

// A later auto refresh keeps the saved provider truth.
await loadPatrol();
const settled = readState();
assert.equal(settled.interval, "900");
assert.equal(settled.enabled, true);
assert.deepEqual(settled.stages, [true, false, true]);

// A save whose response arrives after a provider switch and a newer draft must
// not clear, rebuild or overwrite that newer draft.
{
  const saveNumber = planHost.querySelector("input[type=number]");
  saveNumber.value = "1200";
  fire(saveNumber, "input");
  const gate = holdNextApi();
  planHost.querySelectorAll("button").find((button) => button.textContent === "Save plan").click();
  await settle(1);
  selectPatrolProvider("beta");
  await settle();
  const betaEditor = planHost.querySelector(".patrol-editor");
  const betaNumber = planHost.querySelector("input[type=number]");
  betaNumber.value = "888";
  fire(betaNumber, "input");
  assert.equal(state.patrolDirty, true);
  await gate.release();
  await settle();
  const afterLateSave = readState();
  assert.equal(afterLateSave.interval, "888", "a late save must not overwrite a newer provider draft");
  assert.equal(afterLateSave.focused, false);
  assert.equal(planHost.querySelector(".patrol-editor"), betaEditor, "a late save must not rebuild the current editor");
  assert.equal(state.patrolDirty, true, "a late save must not clear the newer draft flag");
  assert.equal(state.patrolEditorProvider, "beta");
}

// The same guard applies to a delete response that arrives after a switch.
{
  selectPatrolProvider("alpha");
  await settle();
  const gate = holdNextApi();
  planHost.querySelectorAll("button").find((button) => button.textContent === "Delete plan").click();
  await settle(1);
  selectPatrolProvider("beta");
  await settle();
  const betaEditor = planHost.querySelector(".patrol-editor");
  const betaNumber = planHost.querySelector("input[type=number]");
  betaNumber.value = "555";
  fire(betaNumber, "input");
  assert.equal(state.patrolDirty, true);
  await gate.release();
  await settle();
  const afterLateDelete = readState();
  assert.equal(afterLateDelete.interval, "555", "a late delete must not overwrite a newer provider draft");
  assert.equal(planHost.querySelector(".patrol-editor"), betaEditor, "a late delete must not rebuild the current editor");
  assert.equal(state.patrolDirty, true, "a late delete must not clear the newer draft flag");
}

// Same-provider case: a delete that returns after a newer edit in the very same
// editor must keep the newer draft instead of reloading the deleted plan.
{
  assert.equal(state.patrolProvider, "beta");
  assert.equal(state.patrolDirty, true);
  const editorBeforeDelete = planHost.querySelector(".patrol-editor");
  const betaNumber = planHost.querySelector("input[type=number]");
  betaNumber.value = "777";
  fire(betaNumber, "input");
  const gate = holdNextApi();
  planHost.querySelectorAll("button").find((button) => button.textContent === "Delete plan").click();
  await settle(1);
  betaNumber.value = "654";
  fire(betaNumber, "input");
  await gate.release();
  await settle();
  const afterSameProviderDelete = readState();
  assert.equal(afterSameProviderDelete.interval, "654", "a late delete must not discard a newer same-provider edit");
  assert.equal(planHost.querySelector(".patrol-editor"), editorBeforeDelete, "a late delete must not rebuild the same-provider editor");
  assert.equal(state.patrolDirty, true, "a late delete must retain the newer same-provider draft flag");
  assert.equal(state.patrolEditorProvider, "beta");
}

console.log("providers patrol draft smoke passed");
