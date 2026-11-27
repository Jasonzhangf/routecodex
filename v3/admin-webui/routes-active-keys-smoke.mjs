import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the shipped view with a small DOM/API harness. This checks UI behavior;
// the parent still owns actual-browser and real Runtime acceptance.
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    innerHTML: "", textContent: "", value: "", disabled: false,
    classList: { add() {}, toggle() {} }, handlers: {},
    setAttribute() {}, addEventListener(name, handler) { this.handlers[name] = handler; },
  });
  return nodes.get(id);
}
const calls = [];
const identity = { provider_id: "p", interface_id: "responses", model_id: "m", auth_alias: "a" };
const server = { server_id: "test", port: 18080, pools: [{ name: "default", selection: { strategy: "weighted" }, active_keys: null, tiers: [{ members: [{ use: "p/m", weight: null }] }] }] };
const api = async (path, options) => {
  calls.push({ path, options });
  if (path === "/api/routes") return { servers: [structuredClone(server)] };
  if (path.startsWith("/api/routes/active-keys?")) return { pools: [{ routing_group_id: "test", pool_id: "default", strategy: "active_queue", configured_members: [{ provider: "p", alias: "a" }], order: [], held: [identity], health: [{ ...identity, eligible: false, reason: "cooldown" }] }] };
  if (path === "/api/routes/active-keys/release") return { ok: true };
  throw new Error(`unexpected API: ${path}`);
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const context = vm.createContext({ api, escapeHtml, initShell() {}, document: { getElementById: node }, window: { addEventListener() {} }, console, Map, Set });
let source = fs.readFileSync(new URL("./app/views/routes.js", import.meta.url), "utf8");
source = source.replace(/^import .*;\n/gm, "");
vm.runInContext(source, context);
await new Promise(resolve => setImmediate(resolve));
assert.match(node("route-tree").innerHTML, /Legacy \(weighted\)/);
assert.doesNotMatch(node("route-tree").innerHTML, /data-action="load-queue"[^>]*disabled/,
  "the queue control is usable after initial Routes load completes");
assert.equal(calls.length, 1, "loading Routes does not automatically call a control or probe");
assert.equal(vm.runInContext("state.servers[0].pools[0].selection.strategy", context), "weighted");
const change = node("route-tree").handlers.change;
change({ target: { dataset: { action: "selection-mode", pool: "0" }, value: "active_queue", selectedIndex: 1 } });
assert.equal(vm.runInContext("state.servers[0].pools[0].active_keys.members.length", context), 0, "opting in never silently activates aliases");
change({ target: { dataset: { action: "key-retries", pool: "0" }, value: "2" } });
assert.equal(vm.runInContext("state.servers[0].pools[0].active_keys.retries", context), 2);
await vm.runInContext("loadQueue()", context);
assert.match(node("route-tree").innerHTML, /Held by queue policy/);
assert.match(node("route-tree").innerHTML, /Health cooldown \(separate\)/);
assert.match(node("route-tree").innerHTML, /Release to tail/);
await vm.runInContext("releaseKey(state.servers[0].pools[0], 0)", context);
const release = calls.find(call => call.path.endsWith("/release"));
assert.deepEqual(JSON.parse(release.options.body), { server_id: "test", routing_group_id: "test", pool_id: "default", ...identity });
assert.ok(calls.at(-1).path.includes("active-keys?"), "release reloads Runtime state");
const beforeRemovalReload = calls.length;
node("route-tree").handlers.click({ target: { closest() { return { dataset: { action: "legacy-keys", pool: "0" } }; } } });
assert.equal(vm.runInContext("state.servers[0].pools[0].active_keys", context), null);
assert.equal(vm.runInContext("state.servers[0].pools[0].selection.strategy", context), "priority", "removal uses an explicit legacy selection");
assert.equal(calls.length, beforeRemovalReload, "local policy edits do not call a probe or control endpoint");
console.log("routes active-key behavior smoke passed");
