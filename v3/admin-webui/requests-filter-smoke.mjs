import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import vm from "node:vm";

// Filter rail + facet selects live in the view module; the markup shell keeps
// the hidden compatibility select and the panel host.
const markup = fs.readFileSync(new URL("./requests.html", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("./app/views/usage.js", import.meta.url), "utf8");

function makeSelect() {
  const options = [];
  let value = "all";
  const select = {
    options,
    replaceChildren(...nextOptions) {
      options.splice(0, options.length, ...nextOptions);
      if (!options.some((option) => option.value === value)) value = "all";
    },
  };
  Object.defineProperty(select, "value", {
    get: () => value,
    set: (next) => {
      value = String(next);
    },
  });
  return select;
}

const portFilterSelect = makeSelect();
const protocolFilterSelect = makeSelect();
const modelFilterSelect = makeSelect();
const endpointFilterSelect = makeSelect();

assert.match(markup, /<select id="port-filter"><option value="all">All ports<\/option>/);
assert.match(markup, /id="filter-provider"/);
assert.match(markup, /<select id="model-filter"><option value="all">all models<\/option>/);
assert.match(markup, /<select id="endpoint-filter"><option value="all">all endpoints<\/option>/);
assert.match(markup, /<label>Route<input id="route-filter" type="search" placeholder="route"><\/label>/);
assert.match(markup, /id="calendar-period"/);
assert.match(markup, /id="timezone"/);
assert.match(markup, /id="calendar-anchor"/);
assert.match(markup, /<option value="custom">Custom<\/option>/);
assert.match(markup, /id="provider-usage-table"/);
assert.match(markup, /id="clear-selected-provider"/);
assert.match(view, /state\.providerCounts = \{ \.\.\.\(state\.facets\.provider_ids \|\| \{\}\) \}/);
assert.match(view, /populateFacetSelect\("model-filter", state\.facets\.models \|\| \{\}, "all models"\)/);
assert.match(view, /populateFacetSelect\("endpoint-filter", state\.facets\.endpoints \|\| \{\}, "all endpoints"\)/);
assert.match(view, /const model = document\.getElementById\("model-filter"\)\.value;/);
assert.match(view, /if \(model !== "all"\) params\.set\("model", model\);/);
assert.match(view, /const endpoint = document\.getElementById\("endpoint-filter"\)\.value;/);
assert.match(view, /if \(endpoint !== "all"\) params\.set\("endpoint", endpoint\);/);
assert.match(view, /const route = document\.getElementById\("route-filter"\)\.value\.trim\(\);/);
assert.match(view, /if \(route\) params\.set\("route", route\);/);
assert.match(view, /params\.set\("calendar_period", period\);/);
assert.match(view, /params\.set\("timezone", timezone\);/);
assert.match(view, /params\.set\("grain", grain\);/);
assert.match(view, /if \(anchor\) params\.set\("anchor_date", anchor\);/);
assert.match(view, /document\.getElementById\("calendar-anchor"\)\.addEventListener\("change", \(\) => \{\n  resetSelectionAndPage\(\);/);
assert.match(view, /if \(state\.providerSel\.size\) params\.set\("provider_ids", JSON\.stringify\(\[\.\.\.state\.providerSel\]\)\);/);
assert.doesNotMatch(view, /params\.set\("provider", provider\)/);
assert.match(view, /\.filter\(\(item\) => item\.provider_id !== ""\)/);
assert.match(view, /state\.providerUsageSummary = response\.provider_usage\?\.summary \|\| state\.statisticsStats;/);
assert.match(view, /state\.providerUsage = \(response\.provider_usage\?\.by_provider \|\| \[\]\)/);
assert.match(view, /state\.records = response\.records \|\| \[\];\n\s+state\.total = Number\(response\.total \|\| 0\);/);
assert.match(view, /document\.getElementById\("port-filter"\)\.addEventListener\("change"/);
assert.doesNotMatch(view, /portSelect\.replaceChildren\(allPorts, \.\.\.Object\.entries\(state\.facets\.ports \|\| \{\}\)/,
  "the port select must not rebuild only from the filtered response facets");
assert.match(view, /params\.set\("view", "requests"\);/);
assert.match(view, /params\.set\("view", "attempts"\);/);
assert.match(view, /const MAX_EXPORT_ROWS = 5000;/);
assert.match(view, /const attempts = \(state\.tab \|\| "entries"\) === "attempts";/);
assert.match(view, /const params = attempts\n      \? applyAttemptViewParams\(buildQueryParams\(page\)\)\n      : buildQueryParams\(page\);/);
assert.match(view, /const hasFiltered = total > 0;/);
assert.match(view, /rowType\(row\),\n    rowStableKey\(row\),/);
assert.match(view, /function renderProviderUsage\(\)/);
assert.match(view, /response\.provider_usage\?\.by_provider/);
assert.match(view, /function rowStableKey\(row\)/);
assert.match(view, /button\.disabled = typeof onClick !== "function";/);
assert.doesNotMatch(view, /function activePlans\(\)/);
assert.doesNotMatch(view, /function mergeStats\(/);

const base = process.argv[2];
if (base) {
  const servedView = await (await fetch(`${base}/app/views/usage.js`)).text();
  const core = await (await fetch(`${base}/app/core.js`)).text();
  function region(source, from, to) {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `served source region ${from}`);
    return source.slice(start, end);
  }

  const attemptRows = [1, 2, 3].map((attemptIndex) => ({
    request_key: "7777:retry-p1-only",
    event_type: "request.provider_attempt_failed",
    result: "failed-attempt",
    started_epoch_ms: attemptIndex * 100,
    updated_epoch_ms: attemptIndex * 100 + 10,
    scope: { port: 7777 },
    meta: {
      provider: "p1",
      provider_id: "p1",
      model: "m1",
      endpoint: "/v1/responses",
      error_category: "provider_http_500",
      error_detail: attemptIndex === 2 ? "provider \"500\", retry\nsecond line" : "provider attempt failed",
      observed_error: { attempt_index: attemptIndex },
    },
  }));
  const requestRows = [
    {
      request_key: "7777:retry-success",
      event_type: "request.completed",
      result: "success",
      started_epoch_ms: 500,
      updated_epoch_ms: 600,
      scope: { port: 7777 },
      meta: { provider: "p2", provider_id: "p2", model: "m1", endpoint: "/v1/responses" },
    },
    {
      request_key: "7777:other-success",
      event_type: "request.completed",
      result: "success",
      started_epoch_ms: 700,
      updated_epoch_ms: 800,
      scope: { port: 7777 },
      meta: { provider: "p2", provider_id: "p2", model: "m1", endpoint: "/v1/responses" },
    },
    {
      request_key: "4444:port-only",
      event_type: "request.completed",
      result: "success",
      started_epoch_ms: 900,
      updated_epoch_ms: 1000,
      scope: { port: 4444 },
      meta: { provider: "p3", provider_id: "p3", model: "m1", endpoint: "/v1/responses" },
    },
  ];
  const fixtureRequests = [];
  const fixtureServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/app/core.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(core);
      return;
    }
    if (url.pathname === "/app/views/usage.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(servedView);
      return;
    }
    assert.equal(url.pathname, "/api/observability/records");
    const params = url.searchParams;
    fixtureRequests.push(url.pathname + url.search);
    const viewName = params.get("view") || "requests";
    const providerIds = JSON.parse(params.get("provider_ids") || "[]");
    const port = params.get("port");
    const source = viewName === "attempts" ? attemptRows : requestRows;
    const providerFiltered = providerIds.length
      ? source.filter((row) => providerIds.includes(row.meta.provider_id))
      : source;
    const filtered = port
      ? providerFiltered.filter((row) => String(row.scope.port) === port)
      : providerFiltered;
    const ports = {};
    for (const row of filtered) {
      const rowPort = String(row.scope.port);
      ports[rowPort] = (ports[rowPort] || 0) + 1;
    }
    if (port && !ports[port]) ports[port] = 0;
    if (viewName === "requests" && providerIds.includes("p2")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const page = Number(params.get("page") || 1);
    const pageSize = Number(params.get("page_size") || 100);
    const records = filtered.slice((page - 1) * pageSize, page * pageSize);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      records,
      total: filtered.length,
      page,
      page_size: pageSize,
      stats: { count: filtered.length },
      facets: { ports },
      listener_ports: [4444, 7777],
    }));
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
  try {
    const formValues = {
      "calendar-period": "all", "chart-grain": "day", "timezone": "UTC",
      "calendar-anchor": "", "sort-field": "started_epoch_ms", "sort-order": "desc",
      "port-filter": "all", "model-filter": "all",
      "endpoint-filter": "all", "route-filter": "", "protocol-filter": "all",
      "mode-filter": "all", "search-filter": "",
    };
    const fixtureElements = Object.fromEntries(
      Object.entries(formValues).map(([id, value]) => [id, { value }]),
    );
    const makeNode = () => ({
      children: [],
      className: "",
      dataset: {},
      disabled: false,
      style: {},
      textContent: "",
      append(...nodes) {
        this.children.push(...nodes);
      },
      appendChild(node) {
        this.children.push(node);
        return node;
      },
      replaceChildren(...nodes) {
        this.children.splice(0, this.children.length, ...nodes);
      },
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener() {},
    });
    Object.assign(fixtureElements, {
      "selection-bar": { classList: { show: false, toggle(_name, show) { this.show = show; } } },
      "sel-count": { textContent: "0" },
      "export-csv-top": { disabled: true },
      "copy-tsv-top": { disabled: true },
      "port-filter": portFilterSelect,
      "protocol-filter": protocolFilterSelect,
      "model-filter": modelFilterSelect,
      "endpoint-filter": endpointFilterSelect,
      "requests-panel": {},
      "requests-pagination": {},
      "requests-notice": { classList: { toggle() {} } },
    });
    const downloaded = [];
    const statuses = [];
    const URLWithObject = class extends URL {};
    URLWithObject.createObjectURL = (blob) => {
      downloaded.push(blob);
      return `blob:${downloaded.length}`;
    };
    URLWithObject.revokeObjectURL = () => {};
    const fixtureState = {
      records: [], attemptRecords: [], errorFacets: [], page: 1, pageSize: 2,
      total: 0, attemptsTotal: 0, attemptsPage: 1, errorStatuses: 0,
      errorExamples: {}, tab: "attempts", entriesGroup: "pool", stats: {},
      providerUsage: [], providerUsageSummary: {}, providerUsageRange: null,
      providerUsageCoverage: null, providerUsageError: null, timeseries: [],
      facets: {}, errorStatusCode: null, errorOrigin: null, loading: false,
      sortMode: "time", statusKinds: new Set(),
      providerSel: new Set(["p1"]),
      selection: new Set(["7777:retry-p1-only|attempt-1"]),
      exports: [], timeFrom: null, timeTo: null, listenerPorts: [],
    };
    const fixtureContext = vm.createContext({
      state: fixtureState,
      URL: URLWithObject,
      URLSearchParams,
      AbortController,
      Date,
      Intl,
      Blob,
      document: {
        getElementById: (id) => fixtureElements[id],
        createElement: (tag) => {
          const node = makeNode();
          node.tag = tag;
          if (tag === "a") node.click = () => {};
          return node;
        },
      },
      fetch: (path, options) => fetch(new URL(path, fixtureBase), options),
      renderAll() {},
      renderTabCounts() {},
      showStatus: (kind, message) => statuses.push({ kind, message }),
    });
    vm.runInContext("let adminToken = null;\n" +
      region(core, "export async function api(", "export function escapeHtml(").replace(/^export /gm, "") +
      region(core, "export function fmtMs(", "export function badge(").replace(/^export /gm, "") +
      region(servedView, "function endpointLabel(", "const state = {") +
      region(servedView, "function rowStableKey(", "// ---------- cooldown panel") +
      region(servedView, "function providerIdOf(", "function selectionButton(") +
      region(servedView, "function renderFacetFilters()", "function renderProviderUsage(") +
      region(servedView, "function populateFacetSelect(", "function numberCell(") +
      region(servedView, "// ---------- selection & export ----------", "function renderStatsCards(") +
      region(servedView, "function activePagination()", "function renderPagination("), fixtureContext);

    await fixtureContext.loadRecords();
    assert.equal(fixtureState.records.length, 0, "selected Provider p1 has no request rows");
    assert.equal(fixtureState.total, 0);
    assert.equal(fixtureState.attemptsTotal, 3);
    assert.equal(fixtureState.attemptRecords.length, 2);

    fixtureContext.renderSelection();
    assert.equal(fixtureState.exports.length, 1);
    assert.equal(fixtureState.exports[0].meta.observed_error.attempt_index, 1);
    assert.equal(fixtureElements["export-csv-top"].disabled, false,
      "Attempts with rows must enable filtered export even when requests total is zero");
    assert.equal(fixtureElements["copy-tsv-top"].disabled, false);

    const beforeExport = fixtureRequests.length;
    const exportedRows = await fixtureContext.fetchFilteredRows();
    assert.equal(exportedRows.total, 3);
    assert.equal(exportedRows.rows.length, 3);
    assert.deepEqual(
      Array.from(exportedRows.rows, (row) => row.meta.observed_error.attempt_index),
      [1, 2, 3],
    );
    const exportQueries = fixtureRequests.slice(beforeExport)
      .map((path) => new URL(path, fixtureBase).searchParams);
    assert.deepEqual(exportQueries.map((params) => params.get("page")), ["1", "2"]);
    for (const params of exportQueries) {
      assert.equal(params.get("include_provider_usage"), "false");
      assert.equal(params.get("view"), "attempts");
      assert.equal(params.get("status"), "retrying");
      assert.equal(params.get("provider_ids"), "[\"p1\"]");
      assert.equal(params.get("page_size"), "2");
      assert.equal(params.get("sort_by"), "updated_epoch_ms");
      assert.equal(params.get("sort_order"), "desc");
    }

    await fixtureContext.exportFilteredCSV();
    assert.equal(downloaded.length, 1);
    const csv = await downloaded[0].text();
    assert.match(csv, /^row_type,row_key,/);
    assert.match(csv, /attempt,7777:retry-p1-only\|attempt-1,/);
    assert.match(csv, /"provider ""500"", retry\nsecond line"/);
    assert.ok(statuses.some(({ kind, message }) =>
      kind === "ok" && message === "Exported 3 filtered rows to CSV."));

    downloaded.length = 0;
    fixtureContext.exportCSV();
    assert.equal(downloaded.length, 1);
    const selectedCSV = await downloaded[0].text();
    assert.match(selectedCSV, /attempt,7777:retry-p1-only\|attempt-1,/);
    assert.ok(!selectedCSV.includes("attempt-2"));

    fixtureState.providerSel = new Set(["p2"]);
    fixtureState.tab = "entries";
    const entryRows = await fixtureContext.fetchFilteredRows();
    assert.equal(entryRows.total, 2);
    assert.ok(fixtureRequests.slice(-1).every((path) =>
      new URL(path, fixtureBase).searchParams.get("view") === "requests"));

    fixtureState.tab = "attempts";
    const attemptsForP2 = await fixtureContext.fetchFilteredRows();
    assert.equal(attemptsForP2.total, 0);
    assert.equal(attemptsForP2.rows.length, 0);
    assert.equal(new URL(fixtureRequests.at(-1), fixtureBase).searchParams.get("view"), "attempts");

    fixtureState.tab = "entries";
    fixtureState.providerSel.add("p2");
    fixtureElements["port-filter"].value = "all";
    await fixtureContext.loadRecords();

    const optionValues = () => fixtureElements["port-filter"].options.map((option) => option.textContent);
    assert.deepEqual(optionValues(), ["All ports", "4444", "7777"],
      "Configured listeners must seed known ports even when p2 has no 4444 row");

    fixtureElements["port-filter"].value = "4444";
    await fixtureContext.loadRecords();
    const emptyPortQuery = new URL(fixtureRequests.at(-1), fixtureBase).searchParams;
    assert.equal(fixtureState.total, 0);
    assert.equal(emptyPortQuery.get("port"), "4444");
    assert.deepEqual(JSON.parse(emptyPortQuery.get("provider_ids")), ["p2"]);
    assert.equal(fixtureElements["port-filter"].value, "4444");
    assert.deepEqual(optionValues(), ["All ports", "4444", "7777"],
      "An empty intersection must retain every known port and the selected port");

    fixtureState.providerSel.clear();
    await fixtureContext.loadRecords();
    const clearedProviderQuery = new URL(fixtureRequests.at(-1), fixtureBase).searchParams;
    assert.equal(clearedProviderQuery.get("port"), "4444");
    assert.equal(clearedProviderQuery.get("provider_ids"), null);
    assert.equal(fixtureElements["port-filter"].value, "4444");
    assert.equal(fixtureState.total, 1);

    fixtureState.providerSel.add("p2");
    const delayedProviderLoad = fixtureContext.loadRecords();
    const beforeCoalescedRefresh = fixtureRequests.length;
    await fixtureContext.loadRecords();
    assert.equal(fixtureRequests.length, beforeCoalescedRefresh, "refresh joins the in-flight filter");
    fixtureState.providerSel.clear();
    await fixtureContext.loadRecords();
    await delayedProviderLoad;
    const latestQuery = new URL(fixtureRequests.at(-1), fixtureBase).searchParams;
    assert.equal(latestQuery.get("port"), "4444");
    assert.equal(latestQuery.get("provider_ids"), null);
    assert.equal(fixtureState.providerSel.size, 0);
  } finally {
    await new Promise((resolve, reject) => {
      fixtureServer.close((error) => error ? reject(error) : resolve());
    });
  }
}

console.log("requests provider/model/port/endpoint filter and export smoke passed");
