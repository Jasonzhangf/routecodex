// Public Admin consumer for bug e56edd5. The Rust fixture supplies the HTTP
// server; query assembly, status rendering and drilldown execute served JS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const TEST_NAME = "observability_error_row_terminal_status_never_uses_success_carrier";
const base = process.argv[2];
if (!base) {
  const result = spawnSync("cargo", ["test", "--manifest-path", "v3/Cargo.toml",
    "-p", "routecodex-v3-admin", "--test", "l4_admin_observability", TEST_NAME,
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
const statusErrors = [];
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
  showStatus: (_kind, message) => statusErrors.push(message),
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

const failures = [];
function check(condition, message, detail = undefined) {
  if (condition) return;
  failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}
function recordByKey(key) {
  return state.records.find((row) => row.request_key === key);
}
async function recordsQuery(params) {
  const response = await fetch(`${base}/api/observability/records?${new URLSearchParams(params)}`);
  const body = await response.json();
  check(response.status === 200, `records query HTTP ${params.error_status_code || "all"}`, {
    status: response.status,
    body,
  });
  return body;
}

await context.loadRecords();

const unsupportedKeys = {
  main: "50294:openai-responses-router-test.test-20261007T235341489-919058-54707",
  success: "4444:success-control",
  upstream502: "4444:upstream-http-502",
  typed599: "4444:typed-error06-599",
  conflict599: "4444:typed-conflict-599",
  noStatus: "4444:error-no-status",
  typed200: "4444:error06-200",
};
const rows = Object.fromEntries(Object.entries(unsupportedKeys).map(([name, key]) => [name, recordByKey(key)]));
for (const [name, row] of Object.entries(rows)) {
  check(Boolean(row), `seeded record missing: ${name}`, unsupportedKeys[name]);
}

const main = rows.main;
if (main) {
  check(main.result === "error", "retained row must stay an error", main);
  check(main.error_origin === "local", "retained row origin must stay local", main.error_origin);
  check(main.meta?.provider_status === 200, "retained provider_status must stay 200", main.meta);
  check(main.meta?.error_category === "http_200", "retained error_category must stay http_200", main.meta);
  check(main.meta?.observed_error?.source === "error06_projection_not_exposed",
    "retained observed_error source must stay unchanged", main.meta?.observed_error);
  check(Array.isArray(main.meta?.observed_error?.chain)
    && main.meta.observed_error.chain.length === 0,
  "retained typed chain must stay empty", main.meta?.observed_error?.chain);
  check(context.statusText(main) === "unknown",
    "retained error row must render unknown, not the legacy 200 carrier",
    context.statusText(main));
}

if (rows.success) {
  check(context.statusText(rows.success) === "200", "success 200 control changed",
    context.statusText(rows.success));
  check(rows.success.error_origin == null, "success control gained an error origin",
    rows.success.error_origin);
}
if (rows.upstream502) {
  check(rows.upstream502.result === "failed-attempt", "upstream 502 result changed");
  check(rows.upstream502.error_origin === "upstream", "upstream 502 origin changed",
    rows.upstream502.error_origin);
  check(context.statusText(rows.upstream502) === "502", "upstream 502 label changed",
    context.statusText(rows.upstream502));
}
if (rows.typed599) {
  check(rows.typed599.error_origin === "local", "typed 599 origin changed",
    rows.typed599.error_origin);
  check(rows.typed599.meta?.provider_status === 200,
    "typed 599 control must preserve provider_status=200", rows.typed599.meta);
  check(context.statusText(rows.typed599) === "599",
    "typed Error06 599 must beat the legacy carrier", context.statusText(rows.typed599));
}
if (rows.conflict599) {
  check(context.statusText(rows.conflict599) === "599",
    "typed Error06 599 must beat a conflicting category", context.statusText(rows.conflict599));
}
for (const name of ["noStatus", "typed200"]) {
  if (rows[name]) {
    check(context.statusText(rows[name]) === "unknown",
      `${name} must render unknown`, context.statusText(rows[name]));
  }
}

const facets = state.facets?.error_status_codes || {};
const origins = state.facets?.error_status_origins || {};
check(Number(facets.unknown || 0) >= 1, "unknown error status facet is missing", facets);
check(Number(origins.unknown?.local || 0) === 1,
  "exactly the retained row must contribute unknown/local", origins);
check(context.statusText(main) !== "200", "retained error row still renders 200");
check(facets["200"] == null, "an error row still contributes a 200 facet", facets);
check(Number(facets["502"] || 0) === 1, "upstream 502 facet is missing", facets);
check(Number(origins["502"]?.upstream || 0) === 1,
  "upstream 502 origin facet is missing", origins);
check(Number(facets["599"] || 0) === 2, "typed Error06 599 facets are missing", facets);

const unknownLocal = {
  page: "1", page_size: "100", range: "all", status: "error",
  error_status_code: "unknown", error_origin: "local",
};
const unknownLocalBody = await recordsQuery(unknownLocal);
check(unknownLocalBody.total === 1,
  "unknown/local query must match exactly the retained row", unknownLocalBody.total);
check(unknownLocalBody.records?.length === 1
  && unknownLocalBody.records[0].request_key === unsupportedKeys.main,
  "unknown/local query returned the wrong row", unknownLocalBody.records);

const code200Body = await recordsQuery({ ...unknownLocal, error_status_code: "200" });
check(code200Body.total === 0, "code=200 must not match an error row", code200Body.total);
check(!code200Body.records?.some((row) => row.request_key === unsupportedKeys.main),
  "code=200 query returned the retained error row");

const upstreamBody = await recordsQuery({
  page: "1", page_size: "100", range: "all", status: "error",
  error_status_code: "502", error_origin: "upstream",
});
check(upstreamBody.total === 1
  && upstreamBody.records?.[0]?.request_key === unsupportedKeys.upstream502,
  "502/upstream drilldown changed", upstreamBody.records);

const loadRecords = context.loadRecords;
let reload;
context.loadRecords = () => (reload = loadRecords());
context.drilldownErrorStatus("unknown", "local");
await reload;
check(state.errorStatusCode === "unknown", "unknown drilldown did not set the status filter");
check(state.errorOrigin === "local", "unknown drilldown did not set the origin filter");
check(state.total === 1, "unknown/local drilldown did not narrow to one row", state.total);
check(state.records.length === 1 && state.records[0].request_key === unsupportedKeys.main,
  "unknown/local drilldown loaded the wrong row", state.records);
check(statusErrors.length === 0, "served UI reported status errors", statusErrors);
check(requests.every((request) => request.status === 200),
  "a served UI request failed", requests.filter((request) => request.status !== 200));

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("records-error-terminal-status smoke passed");
}
