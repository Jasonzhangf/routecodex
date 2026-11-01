// Public Admin consumer for bug 2eafcc2. The Rust fixture supplies the HTTP
// server; query assembly, error samples and drilldown execute served JS bodies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const base = process.argv[2];
if (!base) {
  const result = spawnSync("cargo", ["test", "--manifest-path", "v3/Cargo.toml",
    "-p", "routecodex-v3-admin", "--test", "l4_admin_observability",
    "observability_records_accept_declared_network_facet_label_from_frontend",
    "--", "--exact", "--nocapture"], {
    cwd: new URL("../../", import.meta.url), stdio: "inherit",
    env: { ...process.env, CARGO_NET_OFFLINE: "true" },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const view = await (await fetch(`${base}/app/views/usage.js`)).text();
const core = await (await fetch(`${base}/app/core.js`)).text();
function region(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `served source region ${from}`);
  return source.slice(start, end);
}

const values = {
  "chart-range": "all", "sort-field": "started_epoch_ms", "sort-order": "desc",
  "port-filter": "all", "provider-filter": "all", "model-filter": "all",
  "endpoint-filter": "all", "route-filter": "", "protocol-filter": "all",
  "mode-filter": "all", "search-filter": "",
};
const elements = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]));
const requests = [];
const errors = [];
const state = {
  page: 1, pageSize: 100, attemptsPage: 1, sortMode: "time", port: "all",
  timeFrom: null, timeTo: null, errorStatusCode: null, errorOrigin: null,
  statusKinds: new Set(), providerSel: new Set(), modelSel: new Set(),
};
const context = vm.createContext({
  state, URLSearchParams, Date,
  document: { getElementById: (id) => elements[id] },
  // Stub rendering only. Every API request executes served core.api and HTTP.
  renderAll() {},
  showStatus: (_kind, message) => errors.push(message),
  fetch: async (path, options) => {
    const response = await fetch(new URL(path, base), options);
    const body = await response.clone().json();
    requests.push({ path, status: response.status, error: body.error ?? null });
    return response;
  },
});
vm.runInContext("let adminToken = null;\n" +
  region(core, "export async function api(", "export function el(").replace(/^export /, "") +
  region(view, "function activePlans()", "async function load()") +
  region(view, "function drilldownErrorStatus(", "// ---------- error-detail modal"), context);

await context.loadRecords();
await context.loadRecords();
const networkQueries = requests.filter((r) => new URL(r.path, base).searchParams.get("error_status_code") === "network");
console.log(JSON.stringify({ networkQueries, sample: state.errorExamples?.["network|local"] }));
assert.equal(networkQueries.length, 2, "both loads must request the backend's network/local facet");
assert.ok(networkQueries.every((r) => r.status === 200), "actual loadErrors network query must succeed");
assert.ok(networkQueries.every((r) => new URL(r.path, base).searchParams.get("error_origin") === "local"));
assert.equal(state.errorExamples["network|local"], "provider attempt transport failed");
assert.equal(state.attemptRecords.length, 1);
assert.equal(state.attemptRecords[0].request_key, "4444:attempt-network");
assert.deepEqual(errors, []);

// Observe the async reload started by the real drilldown callback.
const loadRecords = context.loadRecords;
let reload;
context.loadRecords = () => (reload = loadRecords());
context.drilldownErrorStatus("network", "local");
await reload;
assert.equal(state.errorStatusCode, "network");
assert.equal(state.errorOrigin, "local");
assert.equal(state.total, 2);
assert.deepEqual(Array.from(state.records, (row) => row.request_key), [
  "4444:attempt-network", "4444:terminal-network",
]);
assert.deepEqual(errors, []);
console.log("records-network-facet smoke passed");
