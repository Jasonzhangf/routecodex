// RCC V3 Admin WebUI — Usage (Requests) view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage.js)
//
// Thin orchestrator: it owns the query lifecycle (build params, load records,
// stats and facets, then render) and all DOM event wiring. The filter model,
// the row/panel renderers, the export helpers and the summary cards live in
// their own modules so this file stays within the project line limit.

import { api, el, fmtMs, fmtCompact, timeText, escapeHtml, showStatus, startAutoRefresh } from "../core.js";
import { openPanel, closePanel, wireDrawer } from "../drawer.js";
import { renderBarChart, renderDonut } from "../charts.js";
import { initShell } from "../shell.js";
import { state, hooks } from "./usage-state.js";
import {
  activePlans, fetchPlan, seedIncludeSets, renderRail,
} from "./usage-filters.js";
import {
  renderRequests, renderRequestDetail,
} from "./usage-panels.js";
import {
  exportCSV, copyTSV, renderSelection,
} from "./usage-export.js";
import {
  renderStats, renderStatsCards,
} from "./usage-summary.js";

initShell("usage", {
  title: "Usage",
  subtitle: "Request records, tokens, cache hit rate and errors",
});

wireDrawer();

function mergeFacets(target, source) {
  for (const [key, values] of Object.entries(source || {})) {
    const bucket = target[key] || (target[key] = {});
    for (const [value, count] of Object.entries(values || {})) {
      bucket[value] = (bucket[value] || 0) + Number(count || 0);
    }
  }
  return target;
}

function mergeStats(statsList, rowsTotal) {
  if (statsList.length === 1) return statsList[0] || {};
  const keys = ["count", "success_count", "error_count", "cancelled_count", "active_count",
    "switch_count", "input_tokens", "output_tokens", "cached_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens",
    "provider_failure_count"];
  const merged = {};
  for (const key of keys) {
    merged[key] = statsList.reduce((sum, item) => sum + Number(item?.[key] || 0), 0);
  }
  // Cache hit rate recomputed from summed read/input; the server uses the
  // effective input denominator, so multi-plan mode is a close estimate.
  merged.cache_hit_rate_percent = merged.input_tokens > 0
    ? (merged.cache_read_input_tokens / merged.input_tokens) * 100
    : 0;
  const durationWeighted = statsList.reduce((sum, item) => {
    const avg = Number(item?.avg_duration_ms || 0);
    const withDuration = Number(item?.count || 0);
    return sum + avg * withDuration;
  }, 0);
  merged.avg_duration_ms = merged.count > 0 ? durationWeighted / merged.count : 0;
  const byPort = {};
  const byProvider = {};
  for (const item of statsList) {
    for (const [port, entry] of Object.entries(item?.by_port || {})) {
      const bucket = byPort[port] || (byPort[port] = { total: 0, active: 0, success: 0, error: 0, provider_failures: 0, cancelled: 0 });
      for (const field of Object.keys(bucket)) bucket[field] += Number(entry?.[field] || 0);
    }
    for (const [provider, entry] of Object.entries(item?.by_provider || {})) {
      const bucket = byProvider[provider] || (byProvider[provider] = { total: 0, active: 0, success: 0, error: 0, provider_failures: 0, cancelled: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 });
      for (const field of Object.keys(bucket)) bucket[field] += Number(entry?.[field] || 0);
    }
  }
  merged.by_port = byPort;
  merged.by_provider = byProvider;
  return merged;
}

// Latest-wins loading: a filter change that lands while a query is in
// flight queues exactly one trailing reload instead of being dropped.
let loadInFlight = false;
let loadQueued = false;
async function loadRecords() {
  if (loadInFlight) {
    loadQueued = true;
    return;
  }
  loadInFlight = true;
  state.loading = true;
  try {
    await loadRecordsInner();
  } finally {
    loadInFlight = false;
    state.loading = false;
    if (loadQueued) {
      loadQueued = false;
      loadRecords();
    }
  }
}

async function loadRecordsInner() {
  try {
    const params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("page_size", String(state.pageSize));
    params.set("range", document.getElementById("chart-range").value);
    params.set("timezone_offset_minutes", String(new Date().getTimezoneOffset()));
    const sortMode = state.sortMode;
    if (sortMode === "time") {
      params.set("sort_by", "started_epoch_ms");
      params.set("sort_order", "desc");
    } else if (sortMode === "code") {
      params.set("sort_by", "result");
      params.set("sort_order", "desc");
    } else {
      params.set("sort_by", document.getElementById("sort-field").value);
      params.set("sort_order", document.getElementById("sort-order").value);
    }
    const port = document.getElementById("port-filter").value;
    if (port !== "all") params.set("port", port);
    const provider = document.getElementById("provider-filter").value;
    if (provider !== "all") params.set("provider", provider);
    const model = document.getElementById("model-filter").value;
    if (model !== "all") params.set("model", model);
    const endpoint = document.getElementById("endpoint-filter").value;
    if (endpoint !== "all") params.set("endpoint", endpoint);
    const route = document.getElementById("route-filter").value.trim();
    if (route) params.set("route", route);
    const protocol = document.getElementById("protocol-filter").value;
    if (protocol !== "all") params.set("entry_protocol", protocol);
    const mode = document.getElementById("mode-filter").value;
    if (mode !== "all") params.set("execution_mode", mode);
    const search = document.getElementById("search-filter").value.trim();
    if (search) params.set("search", search);
    if (state.errorStatusCode) params.set("error_status_code", state.errorStatusCode);
    // Rail multi-selects win over the single-value facet selects when set.
    const plans = activePlans();
    if (!plans.length) {
      // A layer is empty, so nothing can match. Clear the table without
      // querying and keep the stats/facets the rail needs to recover from.
      state.records = [];
      state.total = 0;
      state.stats = {};
      state.timeseries = [];
      state.attemptRecords = [];
      state.attemptsTotal = 0;
      state.errorFacets = [];
      state.errorStatuses = 0;
      renderAll();
      return;
    }
    if (plans.length > 60) {
      showStatus("err", "Too many filter combinations to run at once (>60 queries) — uncheck more provider or model boxes.");
      return;
    }
    const responses = await Promise.all(plans.map((plan) => fetchPlan(params, plan)));
    state.records = responses.flatMap((response) => response.records || []);
    state.total = responses.reduce((sum, response) => sum + Number(response.total || 0), 0);
    state.stats = mergeStats(responses.map((response) => response.stats || {}), state.total);
    state.timeseries = responses[0]?.timeseries || [];
    const mergedFacets = {};
    for (const response of responses) mergeFacets(mergedFacets, response.facets || {});
    state.facets = mergedFacets;
    if (state.port === "all") state.portCountsCache = { ...(mergedFacets.ports || {}) };
    await Promise.all([loadAttempts(), loadErrors(), loadRailFacets()]);
    renderAll();
  } catch (error) {
    showStatus("err", `records query failed: ${error.message}`);
  }
}

async function loadRailFacets() {
  // One unfiltered query per range, used only to enumerate the values the rail
  // offers and their totals. Kept separate from `loadRecordsInner` so the rail
  // keeps every value visible regardless of what is currently checked.
  try {
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("page_size", "1");
    params.set("range", document.getElementById("chart-range").value);
    params.set("timezone_offset_minutes", String(new Date().getTimezoneOffset()));
    const response = await api(`/api/observability/records?${params}`);
    const merged = state.railFacets || {};
    mergeFacets(merged, response.facets || {});
    state.railFacets = merged;
  } catch (error) {
    // Keep the previous snapshot: a stale value list still lets the user
    // re-check something, an empty one does not.
    if (!state.railFacets) state.railFacets = {};
  }
  seedIncludeSets();
}

async function loadAttempts() {
  try {
    const params = new URLSearchParams();
    params.set("status", "error");
    params.set("page", String(state.attemptsPage));
    params.set("page_size", "50");
    params.set("sort_by", "updated_epoch_ms");
    params.set("sort_order", "desc");
    params.set("range", "today");
    const response = await api(`/api/observability/records?${params}`);
    state.attemptRecords = (response.records || []).filter((row) => row.result === "failed-attempt");
    state.attemptsTotal = state.attemptRecords.length;
  } catch (error) {
    state.attemptRecords = [];
    state.attemptsTotal = 0;
  }
}

async function loadErrors() {
  try {
    const codes = Object.entries(state.facets.error_status_codes || {})
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
    state.errorFacets = codes;
    state.errorStatuses = codes.reduce((sum, item) => sum + Number(item.count || 0), 0);
    state.errorExamples = {};
    await Promise.all(codes.slice(0, 12).map(async (item) => {
      try {
        const params = new URLSearchParams();
        params.set("status", "error");
        params.set("error_status_code", item.code);
        params.set("page", "1");
        params.set("page_size", "1");
        params.set("range", "today");
        const response = await api(`/api/observability/records?${params}`);
        const first = (response.records || [])[0];
        state.errorExamples[item.code] = first?.meta?.error_detail
          || first?.meta?.error_category
          || "—";
      } catch (error) {
        state.errorExamples[item.code] = "—";
      }
    }));
  } catch (error) {
    state.errorFacets = [];
    state.errorStatuses = 0;
  }
}

async function load() {
  await loadRecords();
}

// The panel and rail modules sit below the view in the import graph, so they
// call back into these two view-owned functions through the registry rather
// than importing the view, which would be a cycle.
hooks.loadRecords = () => loadRecords();
hooks.renderSelection = () => renderSelection();

function renderTimeseries() {
  const chart = document.getElementById("usage-chart");
  const metric = document.getElementById("chart-metric").value;
  const range = document.getElementById("chart-range").value;
  renderBarChart(chart, state.timeseries || [], metric, range);
}

function renderPagination() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const info = document.getElementById("page-info");
  info.textContent = `page ${state.page} of ${pages} · ${state.total.toLocaleString()} records`;
  document.getElementById("page-prev").disabled = state.page <= 1;
  document.getElementById("page-next").disabled = state.page >= pages;
}

function renderAll() {
  renderStats(state.stats);
  renderStatsCards();
  renderTimeseries();
  renderTabCounts();
  renderRequests();
  renderPagination();
  renderRequestDetail();
}

function renderTabCounts() {
  const entriesCount = document.getElementById("tab-count-entries");
  const attemptsCount = document.getElementById("tab-count-attempts");
  const errorsCount = document.getElementById("tab-count-errors");
  if (entriesCount) entriesCount.textContent = state.total ? `${state.total}` : "0";
  if (attemptsCount) attemptsCount.textContent = state.attemptsTotal ? `${state.attemptsTotal}` : "0";
  if (errorsCount) errorsCount.textContent = state.errorStatuses ? `${state.errorStatuses}` : "0";
  document.querySelectorAll("#requests-tab-bar .tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === (state.tab || "entries"));
  });
}

document.getElementById("reload-btn").addEventListener("click", () => load().catch((error) => showStatus("err", error.message)));
document.querySelectorAll("#requests-tab-bar .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    if (state.tab === "attempts" && !state.attemptRecords.length) loadAttempts().then(renderAll);
    else renderAll();
  });
});
document.querySelectorAll("#entries-sub-tab-bar .sub-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.subTab === "reason" ? "reason" : "pool";
    if (state.entriesGroup === next) return;
    state.entriesGroup = next;
    renderAll();
  });
});
["chart-range","chart-metric"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { state.page = 1; loadRecords(); });
});
["provider-filter","model-filter","endpoint-filter","route-filter","protocol-filter","mode-filter","search-filter"].forEach((id) => {
  const input = document.getElementById(id);
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.page = 1; loadRecords(); }, 400);
  });
  if (input.tagName === "SELECT") input.addEventListener("change", () => {
    state.page = 1;
    loadRecords();
  });
});
document.getElementById("sort-field").addEventListener("change", () => {
  setSortMode(null);
  state.page = 1;
  loadRecords();
});
document.getElementById("sort-order").addEventListener("change", () => { state.page = 1; loadRecords(); });
document.getElementById("page-prev").addEventListener("click", () => {
  if (state.page > 1) { state.page -= 1; loadRecords(); }
});
document.getElementById("page-size").addEventListener("change", (event) => {
  state.pageSize = Number(event.currentTarget.value);
  state.page = 1;
  loadRecords();
});
document.getElementById("page-next").addEventListener("click", () => {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < pages) { state.page += 1; loadRecords(); }
});
document.getElementById("sort-mode").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-mode]");
  if (!btn) return;
  setSortMode(btn.dataset.mode);
  state.page = 1;
  loadRecords();
});
function setSortMode(mode) {
  state.sortMode = mode || "custom";
  document.querySelectorAll("#sort-mode button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.sortMode));
  });
}
for (const id of ["copy-tsv-bar", "copy-tsv-top"]) document.getElementById(id).addEventListener("click", copyTSV);
for (const id of ["export-csv-bar", "export-csv-top"]) document.getElementById(id).addEventListener("click", exportCSV);
document.getElementById("sel-clear").addEventListener("click", () => {
  state.selection.clear();
  renderSelection();
  renderRequests();
});
startAutoRefresh(() => loadRecords(), 5000);
document.getElementById("drawer-back")?.addEventListener("click", () => {
  const previous = state.drawerSourceTab;
  closePanel();
  if (previous && previous !== state.tab) {
    state.tab = previous;
    renderAll();
  }
});
document.getElementById("drawer")?.addEventListener("transitionend", (event) => {
  if (event.propertyName !== "transform" && event.propertyName !== "opacity") return;
  const drawer = document.getElementById("drawer");
  if (!drawer || drawer.classList.contains("is-open")) return;
  const previous = state.drawerSourceTab;
  state.drawerSourceTab = null;
  if (previous && previous !== state.tab) {
    state.tab = previous;
    renderAll();
  }
});

load().catch((error) => showStatus("err", `observability failed: ${error.message}`));
