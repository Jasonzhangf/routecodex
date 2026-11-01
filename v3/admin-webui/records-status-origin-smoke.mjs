// Public Admin consumer for bug 4beffbf. The Rust fixture supplies the HTTP
// server; status rendering, facets and drilldown execute served JS bodies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const base = process.argv[2];
if (!base) {
  const result = spawnSync("cargo", ["test", "--manifest-path", "v3/Cargo.toml",
    "-p", "routecodex-v3-admin", "--test", "l4_admin_observability",
    "observability_local_conversion_and_upstream_400_remain_distinct",
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
  records: [], attemptRecords: [], errorFacets: [], page: 1, pageSize: 100,
  total: 0, attemptsTotal: 0, attemptsPage: 1, errorStatuses: 0,
  errorExamples: {}, tab: "entries", entriesGroup: "pool", stats: {},
  timeseries: [],
  facets: { ports: {}, providers: {}, models: {}, routes: {}, endpoints: {}, sessions: {}, response_types: {}, entry_protocols: {}, error_status_codes: {} },
  statusKinds: new Set(), providerSel: new Set(), modelSel: new Set(),
  sortMode: "time", port: "all", timeFrom: null, timeTo: null,
  errorStatusCode: null, errorOrigin: null,
};
const context = vm.createContext({
  state, URLSearchParams, Date,
  document: { getElementById: (id) => elements[id] },
  renderAll() {},
  showStatus: (_kind, message) => errors.push(message),
  el: (_tag, _className, text) => ({ textContent: text }),
  loadAttempts: async () => {},
  fetch: async (path, options) => {
    const response = await fetch(new URL(path, base), options);
    const body = await response.clone().json();
    requests.push({ path, status: response.status, error: body.error ?? null });
    return response;
  },
});
vm.runInContext("let adminToken = null;\n" +
  region(core, "export async function api(", "export function el(").replace(/^export /, "") +
  region(view, "function statusText(row)", "function compactFinishReason(row)") +
  region(view, "function activePlans()", "async function loadAttempts()") +
  region(view, "// ---------- error origin ----------", "function drilldownErrorStatus(code, origin = null)") +
  region(view, "function drilldownErrorStatus(code, origin = null)", "// ---------- error-detail modal"), context);

await context.loadRecords();
const byKey = Object.fromEntries(state.records.map((row) => [row.request_key, row]));

const local = byKey["4444:local-conversion-400"];
const upstream = byKey["4444:upstream-http-400"];
const success = byKey["4444:success-control"];
assert.ok(local && upstream && success, "all seeded records must load");
assert.equal(local.error_origin, "local");
assert.equal(upstream.error_origin, "upstream");
assert.equal(context.statusText(local), "598",
  "typed internal_request_lane must render as 598 even with legacy provider_status=400");
assert.equal(context.statusText(upstream), "400",
  "typed provider_http_400 must render as upstream 400");
assert.equal(context.statusText(success), "200", "success control must keep 200");

assert.equal(Number(state.facets.error_status_codes["598"] || 0), 1,
  "local conversion must contribute a 598 facet");
assert.equal(Number(state.facets.error_status_codes["400"] || 0), 1,
  "only the upstream 400 may contribute the 400 facet");
assert.equal(Number(state.facets.error_status_origins?.["598"]?.local || 0), 1);
assert.equal(Number(state.facets.error_status_origins?.["400"]?.upstream || 0), 1);
assert.equal(state.facets.error_status_origins?.["400"]?.local, undefined,
  "legacy provider_status=400 must not create a local 400 facet");

const loadRecords = context.loadRecords;
let reload;
context.loadRecords = () => (reload = loadRecords());
context.drilldownErrorStatus("598", "local");
await reload;
assert.equal(state.errorStatusCode, "598");
assert.equal(state.errorOrigin, "local");
assert.equal(state.total, 1);
assert.deepEqual(Array.from(state.records, (row) => row.request_key), [
  "4444:local-conversion-400",
]);

context.drilldownErrorStatus("400", "upstream");
await reload;
assert.equal(state.errorStatusCode, "400");
assert.equal(state.errorOrigin, "upstream");
assert.equal(state.total, 1);
assert.deepEqual(Array.from(state.records, (row) => row.request_key), [
  "4444:upstream-http-400",
]);
assert.deepEqual(errors, []);
console.log("records-status-origin smoke passed");
