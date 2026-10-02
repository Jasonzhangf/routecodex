// RCC V3 Admin WebUI — Usage (Requests) view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage.js)

import { api, el, fmtMs, fmtCompact, timeText, escapeHtml, showStatus, startAutoRefresh, copyText, kv, badge, getAdminToken } from "../core.js";
import { renderBarChart, renderDonut } from "../charts.js";
import { initShell } from "../shell.js";

initShell("usage", {
  title: "Usage",
  subtitle: "Request records, tokens, cache hit rate and errors",
});

// Endpoint label: shorten canonical V3 entry paths so exports stay compact
// without losing the protocol identity; non-canonical paths pass through.
function endpointLabel(endpoint) {
  if (endpoint == null || endpoint === "—") return "—";
  if (endpoint === "/v1/responses") return "responses";
  if (endpoint === "/v1/chat/completions") return "chat";
  if (endpoint === "/v1/messages") return "messages";
  if (endpoint === "/v1beta/models") return "gemini";
  return endpoint;
}

function statusText(row) {
  const http = row.meta?.provider_status;
  if (http != null && Number.isFinite(Number(http))) {
    return String(http);
  }
  const errorCode = compactErrorReason(row);
  if (/^\d+$/.test(errorCode)) {
    return errorCode;
  }
  const fallback = row.result;
  if (fallback) {
    if (fallback === "success") return "200";
    if (fallback === "error") return "5xx";
    if (fallback === "cancelled") return "499";
    return fallback;
  }
  return "—";
}

function compactErrorReason(row) {
  const ec = row.meta?.error_category;
  if (!ec) return "—";
  const map = {
    provider_http_400: "400",
    provider_http_401: "401",
    provider_http_402: "402",
    provider_http_403: "403",
    provider_http_429: "429",
    provider_http_500: "500",
    provider_http_502: "502",
    provider_http_503: "503",
    provider_http_504: "504",
    target_pool: "exhausted",
    internal_request_lane: "598",
    v3_debug_failure: "598",
    debug_sink: "598",
    internal_response_lane: "599",
    provider_response_sse_event_invalid: "599",
    provider_response_body_error: "599",
    provider_stream_handoff_runtime_failed: "599",
  };
  return map[ec] || ec;
}
function compactFinishReason(row) {
  const reason = row.meta?.finish_reason;
  if (!reason || reason === "—") return "—";
  const map = {
    tool_calls: "tool_calls",
    stop: "stop",
    length: "length",
    content_filter: "filter",
    requires_action: "action",
    completed: "done",
    error: "error",
    cancel: "cancel",
    client_disconnected: "client drop",
    provider_http_400: "http_400",
    provider_http_401: "http_401",
    provider_http_402: "http_402",
    provider_http_403: "http_403",
    provider_http_429: "http_429",
    provider_http_500: "http_500",
    provider_http_502: "http_502",
    provider_http_503: "http_503",
    provider_http_504: "http_504",
  };
  return map[reason] || reason;
}

const state = {
  records: [],
  attemptRecords: [],
  errorFacets: [],
  page: 1,
  pageSize: 100,
  total: 0,
  attemptsTotal: 0,
  attemptsPage: 1,
  errorStatuses: 0,
  errorExamples: {},
  tab: "entries",
  entriesGroup: "pool",
  stats: {},
  timeseries: [],
  facets: { ports: {}, providers: {}, models: {}, routes: {}, endpoints: {}, sessions: {}, response_types: {}, entry_protocols: {}, error_status_codes: {} },
  errorStatusCode: null,
  tableWidths: { entries: null, attempts: null, errors: null },
  loading: false,
  // layered filter model: port tabs (Layer 1) → status kinds (Layer 2) →
  // provider (Layer 3) → model (Layer 4); within a layer selections are OR,
  // across layers they AND.
  port: "all",
  sortMode: "time",
  statusKinds: new Set(),
  providerSel: new Set(),
  modelSel: new Set(),
  excluded: {},
  collapsed: new Set(),
  openExclude: null,
  selection: new Set(),
  kindCounts: {},
  providerCounts: {},
  modelCounts: {},
  exports: [],
  // Absolute time range (epoch ms). When either bound is set the request uses
  // range=all so the server cannot overwrite the explicit bounds.
  timeFrom: null,
  timeTo: null,
  // Current cooldown truth, read only from GET /api/observability/cooldown-pool.
  cooldown: null,
  cooldownError: null,
  cooldownFetchedAtMs: 0,
  // SSE live mode. Polling stays the default and resumes when live is off.
  live: false,
  liveCursor: 0,
  liveEvents: 0,
  liveLastEventAtMs: 0,
  liveAbort: null,
  // Error-detail modal payload for the currently open request key.
  detail: null,
  detailKey: null,
  detailRow: null,
  detailTimer: null,
};

function statusOf(row) {
  const r = row.result;
  if (r === "success") return "success";
  if (r === "error") return "error";
  if (r === "cancelled") return "cancelled";
  if (r === "failed-attempt") return "error";
  return "active";
}
function usageText(usage) {
  if (!usage) return "—";
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const read = Number(usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0);
  const created = Number(usage.cache_creation_input_tokens ?? 0);
  return `${fmtCompact(input)} / ${fmtCompact(output)} · read=${fmtCompact(read)} · created=${fmtCompact(created)}`;
}

function hitRateText(usage) {
  if (!usage) return "—";
  const input = Number(usage.input_tokens ?? 0);
  const read = Number(usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0);
  return input > 0 ? `${((read / input) * 100).toFixed(1)}%` : "—";
}

function metaValue(row, key) {
  return row.meta?.[key] ?? "—";
}

function comboOf(row) {
  const provider = metaValue(row, "provider");
  const model = metaValue(row, "model");
  const key = metaValue(row, "auth_alias");
  return `${provider}/${model} · ${key}`;
}

// Group rank: error codes first (numeric desc), then success, then
// in-flight, cancelled last.
function groupRank(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 2;
  if (n === 499) return 3;
  if (n >= 400) return 0;
  return 1;
}
function compareCodes(a, b) {
  const ra = groupRank(a), rb = groupRank(b);
  if (ra !== rb) return ra - rb;
  const na = Number(a), nb = Number(b);
  if (ra === 0) return nb - na;
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

// Per-tab Excel-style column resizing with localStorage persistence so
// each tab keeps its own widths across reloads.
const TABLE_WIDTH_PREFIX = "v3-admin-webui-requests-table";
function loadTableWidths(tab) {
  try {
    const raw = window.localStorage.getItem(`${TABLE_WIDTH_PREFIX}-${tab}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}
function saveTableWidths(tab, widths) {
  try {
    window.localStorage.setItem(`${TABLE_WIDTH_PREFIX}-${tab}`, JSON.stringify(widths));
  } catch (_error) {
    /* storage unavailable; layout still works for the session. */
  }
}
function applyTableWidths(table, widths) {
  if (!widths || !table) return;
  const colgroup = table.querySelector("colgroup");
  if (!colgroup) return;
  [...colgroup.children].forEach((col) => {
    const cls = [...col.classList].find((token) => token.startsWith("col-"));
    if (cls && typeof widths[cls] === "number" && widths[cls] >= 40) {
      col.style.width = `${widths[cls]}px`;
    }
  });
}
function attachColumnResizers(table, tab) {
  const colgroup = table.querySelector("colgroup");
  if (!colgroup || table.dataset.resizable === "attached") return;
  table.dataset.resizable = "attached";
  const headRow = table.querySelector("thead tr");
  if (!headRow) return;
  const columns = [...colgroup.children];
  [...headRow.children].forEach((th, index) => {
    const col = columns[index];
    if (!col) return;
    const cls = [...col.classList].find((token) => token.startsWith("col-"));
    if (!cls) return;
    if (th.querySelector(".col-resizer")) return;
    const handle = el("span", "col-resizer");
    handle.setAttribute("aria-hidden", "true");
    th.appendChild(handle);
    // Stop propagation so dragging the handle never triggers the header
    // click handler; preventDefault kills text selection and native DnD.
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const startX = event.clientX;
      const startWidth = col.getBoundingClientRect().width || 40;
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        const next = Math.max(40, Math.round(startWidth + (ev.clientX - startX)));
        col.style.width = `${next}px`;
        ev.preventDefault();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!moved) return;
        const updated = { ...(state.tableWidths[tab] || {}) };
        const finalWidth = Math.round(col.getBoundingClientRect().width || startWidth);
        updated[cls] = finalWidth;
        state.tableWidths[tab] = updated;
        saveTableWidths(tab, updated);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
}

function activePlans() {
  const kinds = state.statusKinds.size ? [...state.statusKinds] : [null];
  const providers = state.providerSel.size ? [...state.providerSel] : [null];
  const models = state.modelSel.size ? [...state.modelSel] : [null];
  const plans = [];
  for (const status of kinds) {
    for (const provider of providers) {
      for (const model of models) {
        plans.push({ status, provider, model });
      }
    }
  }
  return plans;
}

async function fetchPlan(base, plan) {
  const params = new URLSearchParams(base);
  if (plan.status) params.set("status", plan.status);
  if (plan.provider) params.set("provider", plan.provider);
  if (plan.model) params.set("model", plan.model);
  return api(`/api/observability/records?${params}`);
}

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

// An absolute range overrides the relative Range selector; the server rewrites
// time_from_ms for range=today|week|month, so the explicit bounds are only
// honoured with range=all.
function activeRange() {
  return state.timeFrom != null || state.timeTo != null
    ? "all"
    : document.getElementById("chart-range").value;
}

function applyTimeRange(params) {
  params.set("range", activeRange());
  params.set("timezone_offset_minutes", String(new Date().getTimezoneOffset()));
  if (state.timeFrom != null) params.set("time_from_ms", String(state.timeFrom));
  if (state.timeTo != null) params.set("time_to_ms", String(state.timeTo));
}

// Single owner of the record query parameters: the table load, the export and
// the error-example probes all build the same filtered query.
function buildQueryParams(page) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(state.pageSize));
  applyTimeRange(params);
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
  return params;
}

async function loadRecordsInner() {
  try {
    const params = buildQueryParams(state.page);
    // Rail multi-selects win over the single-value facet selects when set.
    const plans = activePlans();
    if (plans.length > 12) {
      showStatus("err", "Too many checked combinations (>12 queries) — uncheck some Layer 2-4 selections.");
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
    await Promise.all([loadAttempts(), loadErrors()]);
    renderAll();
  } catch (error) {
    showStatus("err", `records query failed: ${error.message}`);
  }
}

async function loadAttempts() {
  try {
    // `status=retrying` is the failed-attempt projection: exactly the provider
    // attempt rows, with a server-side total that matches the filter.
    const params = new URLSearchParams();
    params.set("status", "retrying");
    params.set("page", String(state.attemptsPage));
    params.set("page_size", String(state.pageSize));
    params.set("sort_by", "updated_epoch_ms");
    params.set("sort_order", "desc");
    applyTimeRange(params);
    const response = await api(`/api/observability/records?${params}`);
    state.attemptRecords = response.records || [];
    state.attemptsTotal = Number(response.total || 0);
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
    // Every facet status code is probed, not a truncated sample.
    await Promise.all(codes.map(async (item) => {
      try {
        const params = buildQueryParams(1);
        params.set("status", "error");
        params.set("error_status_code", item.code);
        params.set("page_size", "1");
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
  await Promise.all([loadRecords(), loadCooldown()]);
}

// ---------- cooldown panel ----------
// GET /api/observability/cooldown-pool is the only current provider health /
// cooldown truth. Observability rows only ever carry immutable attempt-time
// snapshots and are never read as current state.

async function loadCooldown() {
  try {
    state.cooldown = await api("/api/observability/cooldown-pool");
    state.cooldownError = null;
    state.cooldownFetchedAtMs = Date.now();
  } catch (error) {
    state.cooldown = null;
    state.cooldownError = error.message;
  }
  renderCooldownPanel();
  if (state.detailKey) renderDetailCooldown();
}

const COOLDOWN_ADD_KINDS = ["auth_key", "probe"];
const COOLDOWN_MANUAL_MAX_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_STATE_BADGE = {
  session_cooldown: "failed",
  auth_key_cooldown: "failed",
  blocked: "warning",
  probing: "warning",
};
let cooldownAddOpen = false;

// The panel host keeps two JS-rendered regions plus the static add form, so the
// operator's half-typed add request survives the 5 s pool refresh.
function renderCooldownPanel() {
  const head = document.getElementById("cooldown-panel-head");
  const body = document.getElementById("cooldown-panel-body");
  if (!head || !body) return;
  if (state.cooldownError) {
    head.replaceChildren();
    body.replaceChildren(el("div", "error-summary", `cooldown pool unavailable: ${state.cooldownError}`));
    syncCooldownAddState();
    return;
  }
  if (!state.cooldown) {
    head.replaceChildren();
    body.replaceChildren(el("div", "loading", "loading…"));
    syncCooldownAddState();
    return;
  }
  const listeners = Array.isArray(state.cooldown.listeners) ? state.cooldown.listeners : [];
  const entryCount = listeners.reduce((n, listener) => n + (Array.isArray(listener.entries) ? listener.entries.length : 0), 0);

  const title = el("h3", "cooldown-head-title",
    `${listeners.length} listener${listeners.length === 1 ? "" : "s"} · ${entryCount} active cooldown ${entryCount === 1 ? "entry" : "entries"}`);
  const addToggle = el("button", "btn", "Add cooldown");
  addToggle.id = "cooldown-add-toggle";
  addToggle.setAttribute("aria-expanded", String(cooldownAddOpen));
  addToggle.setAttribute("aria-controls", "cooldown-add-form");
  addToggle.addEventListener("click", () => toggleCooldownAddForm());
  head.replaceChildren(title, addToggle);

  if (!listeners.length) {
    body.replaceChildren(el("div", "empty-state", "No listener returned a cooldown pool."));
  } else {
    body.replaceChildren(...listeners.map((listener) => renderCooldownListener(listener)));
  }
  body.appendChild(el("div", "muted cooldown-foot", state.cooldownFetchedAtMs ? `pool read at ${timeText(state.cooldownFetchedAtMs)} · refreshes every 5 s` : ""));
  syncCooldownAddForm(listeners);
  syncCooldownAddState();
}

function syncCooldownAddState() {
  const form = document.getElementById("cooldown-add-form");
  const toggle = document.getElementById("cooldown-add-toggle");
  const poolReady = Boolean(state.cooldown) && !state.cooldownError;
  if (toggle) {
    toggle.disabled = !poolReady;
    toggle.title = poolReady ? "Inject a cooldown for a provider/auth/model" : "the cooldown pool must be readable before an entry can be added";
  }
  if (form) form.hidden = !(cooldownAddOpen && poolReady);
}

function renderCooldownListener(listener) {
  const entries = Array.isArray(listener.entries) ? listener.entries : [];
  const section = el("section", "cooldown-listener");
  const header = el("header", "cooldown-listener-head");
  header.appendChild(el("h4", "cooldown-listener-id", `${listener.server_id ?? "unknown"} :${listener.port ?? "—"}`));
  header.appendChild(el("span", "cooldown-count muted", `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`));
  section.appendChild(header);

  const table = el("table", "cooldown-table");
  const columns = [
    ["Provider", "col-provider"],
    ["Auth", "col-auth"],
    ["Model", "col-model"],
    ["Kind", "col-kind"],
    ["State", "col-state"],
    ["Remaining", "num col-remaining"],
    ["Failures", "num"],
    ["Reason", "col-reason"],
    ["Actions", "col-actions"],
  ];
  const thead = el("thead");
  const headRow = el("tr");
  for (const [label, cls] of columns) headRow.appendChild(el("th", cls, label));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  if (!entries.length) {
    const row = el("tr");
    const cell = el("td", "muted", "no active cooldown entries");
    cell.colSpan = columns.length;
    row.appendChild(cell);
    tbody.appendChild(row);
  } else {
    for (const entry of entries) tbody.appendChild(cooldownRow(listener, entry));
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function cooldownRow(listener, entry) {
  const tr = el("tr");
  const providerId = entry.provider_id ?? "unknown";
  const authAlias = entry.auth_alias || null;
  const modelId = entry.model_id || null;
  const kind = entry.kind ?? "auth_key";
  const identity = { port: Number(listener.port), provider_id: providerId, auth_alias: authAlias, model_id: modelId, kind };

  const providerCell = el("td", "col-provider");
  providerCell.appendChild(el("span", "cooldown-provider mono", providerId));
  const secondary = el("span", "cooldown-secondary");
  const secondaryParts = [];
  if (authAlias) secondaryParts.push(`key ${authAlias}`);
  if (modelId) secondaryParts.push(`model ${modelId}`);
  if (entry.reason) secondaryParts.push(entry.reason);
  secondary.textContent = secondaryParts.join(" · ");
  providerCell.appendChild(secondary);
  tr.appendChild(providerCell);
  tr.appendChild(el("td", "col-auth", authAlias ?? "—"));
  tr.appendChild(el("td", "col-model mono", modelId ?? "—"));
  tr.appendChild(el("td", "col-kind mono", kind));
  const stateCell = el("td", "col-state");
  stateCell.appendChild(cooldownBadge(entry.state ?? "unknown"));
  tr.appendChild(stateCell);

  const remainingCell = el("td", "num col-remaining");
  if (entry.remaining_ms != null) {
    const remaining = el("span", "cooldown-remaining", fmtMs(Math.max(0, Number(entry.remaining_ms))));
    remaining.dataset.remainingMs = String(entry.remaining_ms);
    remainingCell.appendChild(remaining);
  } else {
    remainingCell.appendChild(el("span", "muted", "unknown"));
  }
  tr.appendChild(remainingCell);
  tr.appendChild(el("td", "num", entry.failure_count != null ? String(entry.failure_count) : "—"));
  tr.appendChild(el("td", "col-reason", entry.reason ?? "—"));

  const actionsCell = el("td", "col-actions");
  const probeBtn = el("button", "btn cooldown-action", "Probe now");
  const releaseBtn = el("button", "btn cooldown-action cooldown-release", "Release");
  if (kind === "session") {
    probeBtn.disabled = true;
    probeBtn.title = "Probes only apply to auth_key/probe entries";
  }
  probeBtn.addEventListener("click", () => manualCooldownProbe(identity, [probeBtn, releaseBtn]));
  releaseBtn.addEventListener("click", () => manualCooldownRelease(identity, [probeBtn, releaseBtn]));
  actionsCell.append(probeBtn, releaseBtn);
  tr.appendChild(actionsCell);
  return tr;
}

function cooldownBadge(state) {
  const node = badge(COOLDOWN_STATE_BADGE[state] || "neutral");
  node.textContent = state || "unknown";
  return node;
}

function cooldownIdentityText({ provider_id, auth_alias, model_id }) {
  const parts = [provider_id ?? "unknown"];
  if (auth_alias) parts.push(`key ${auth_alias}`);
  if (model_id) parts.push(`model ${model_id}`);
  return parts.join(" · ");
}

// Every action disables its own buttons while in flight, reports the outcome
// through showStatus, and re-reads GET /api/observability/cooldown-pool. No
// optimistic mutation of state.cooldown: the pool stays the only truth.
async function runCooldownAction(buttons, run, errorPrefix) {
  for (const button of buttons) if (button) button.disabled = true;
  try {
    try {
      await run();
    } catch (error) {
      showStatus("err", `${errorPrefix}: ${error.message}`);
    }
    await loadCooldown();
  } finally {
    for (const button of buttons) if (button) button.disabled = false;
  }
}

// Release is a direct POST: the row already names the exact identity and kind
// being cleared, and the entry stays visible until the pool re-read confirms it
// is gone, so a second modal step would only add a failure mode.
async function manualCooldownRelease(identity, buttons) {
  const label = cooldownIdentityText(identity);
  await runCooldownAction(buttons, async () => {
    const body = { port: identity.port, provider_id: identity.provider_id, kind: identity.kind };
    if (identity.auth_alias) body.auth_alias = identity.auth_alias;
    if (identity.model_id) body.model_id = identity.model_id;
    const result = await api("/api/observability/cooldown-pool", { method: "POST", body: JSON.stringify(body) });
    const removed = result?.removed === true ? "removed" : "no matching entry";
    showStatus("ok", `Released ${label}: ${removed}.`);
  }, `release failed for ${label}`);
}

async function manualCooldownProbe(identity, buttons) {
  const label = cooldownIdentityText(identity);
  await runCooldownAction(buttons, async () => {
    const body = { port: identity.port, provider_id: identity.provider_id };
    if (identity.auth_alias) body.auth_alias = identity.auth_alias;
    if (identity.model_id) body.model_id = identity.model_id;
    const result = await api("/api/observability/cooldown-pool/probe", { method: "POST", body: JSON.stringify(body) });
    if (result?.scheduled === false) {
      showStatus("warn", `Probe: no probe state exists for ${label}; nothing scheduled.`);
    } else {
      showStatus("ok", `Probe now applied for ${label}; recovery probe will run on the next health tick.`);
    }
  }, `probe failed for ${label}`);
}

function toggleCooldownAddForm(force) {
  cooldownAddOpen = force !== undefined ? force : !cooldownAddOpen;
  syncCooldownAddState();
  if (cooldownAddOpen) {
    const providerInput = document.getElementById("cooldown-add-provider");
    if (providerInput) providerInput.focus();
  }
}

function syncCooldownAddForm(listeners) {
  const portSelect = document.getElementById("cooldown-add-port");
  if (!portSelect) return;
  const selected = portSelect.value;
  portSelect.replaceChildren(...listeners.map((listener) => {
    const option = el("option", null, `${listener.server_id ?? "unknown"} :${listener.port ?? "—"}`);
    option.value = String(listener.port ?? "");
    return option;
  }));
  if ([...portSelect.options].some((option) => option.value === selected)) portSelect.value = selected;
}

// The custom duration input only exists while the operator chose "custom";
// resyncing after a reset keeps the hidden/disabled state honest.
function syncCooldownAddDuration() {
  const preset = document.getElementById("cooldown-add-preset");
  const customField = document.getElementById("cooldown-add-custom-field");
  const custom = document.getElementById("cooldown-add-custom");
  if (!preset || !customField || !custom) return;
  const usesCustom = preset.value === "custom";
  customField.hidden = !usesCustom;
  custom.disabled = !usesCustom;
}

function resetCooldownAddForm() {
  const form = document.getElementById("cooldown-add-form");
  if (form) form.reset();
  const errorHost = document.getElementById("cooldown-add-error");
  if (errorHost) errorHost.textContent = "";
  syncCooldownAddDuration();
}

function initCooldownAddForm() {
  const form = document.getElementById("cooldown-add-form");
  const preset = document.getElementById("cooldown-add-preset");
  const custom = document.getElementById("cooldown-add-custom");
  const cancel = document.getElementById("cooldown-add-cancel");
  if (!form || !preset || !custom || !cancel) return;

  preset.addEventListener("change", syncCooldownAddDuration);
  syncCooldownAddDuration();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCooldownAdd([
      document.getElementById("cooldown-add-submit"),
      document.getElementById("cooldown-add-cancel"),
    ]);
  });
  cancel.addEventListener("click", () => {
    resetCooldownAddForm();
    toggleCooldownAddForm(false);
  });
}

async function submitCooldownAdd(buttons) {
  const errorHost = document.getElementById("cooldown-add-error");
  if (!errorHost) return;
  const port = Number(document.getElementById("cooldown-add-port")?.value);
  const provider = (document.getElementById("cooldown-add-provider")?.value || "").trim();
  const auth = (document.getElementById("cooldown-add-auth")?.value || "").trim();
  const model = (document.getElementById("cooldown-add-model")?.value || "").trim();
  const kind = document.getElementById("cooldown-add-kind")?.value || "auth_key";
  const preset = document.getElementById("cooldown-add-preset");
  const custom = document.getElementById("cooldown-add-custom");
  const rawDuration = preset && preset.value === "custom" ? custom?.value : preset?.value;
  const durationMs = Number(rawDuration);

  let invalid = null;
  if (!Number.isFinite(port) || port <= 0) invalid = "choose a listener port";
  else if (!provider) invalid = "provider id is required";
  else if (!COOLDOWN_ADD_KINDS.includes(kind)) invalid = "kind must be auth_key or probe";
  else if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > COOLDOWN_MANUAL_MAX_MS) {
    invalid = `duration must be a whole number of 1..${COOLDOWN_MANUAL_MAX_MS} ms (24 h)`;
  }
  if (invalid) {
    errorHost.textContent = invalid;
    showStatus("err", `add cooldown: ${invalid}`);
    return;
  }

  const body = { port, provider_id: provider, kind, duration_ms: durationMs };
  if (auth) body.auth_alias = auth;
  if (model) body.model_id = model;
  const label = cooldownIdentityText(body);

  await runCooldownAction(buttons, async () => {
    const result = await api("/api/observability/cooldown-pool/add", { method: "POST", body: JSON.stringify(body) });
    const until = result?.until_ms ? `, until ${new Date(result.until_ms).toLocaleTimeString([], { hour12: false })}` : "";
    const applied = result?.applied ? ` (${result.applied})` : "";
    showStatus("ok", `Added ${kind} cooldown for ${label}${applied}${until}.`);
    resetCooldownAddForm();
    toggleCooldownAddForm(false);
  }, `add cooldown failed for ${label}`);
}

function tickCooldowns() {
  const elapsed = state.cooldownFetchedAtMs ? Date.now() - state.cooldownFetchedAtMs : 0;
  document.querySelectorAll("#cooldown-panel .cooldown-remaining").forEach((node) => {
    const base = Number(node.dataset.remainingMs);
    if (!Number.isFinite(base)) return;
    const left = base - elapsed;
    node.textContent = left > 0 ? fmtMs(left) : "expired (pool refresh pending)";
  });
}

function renderStats(stats) {
  stats = stats || {};
  const portBody = document.querySelector("#ports-table tbody");
  const ports = [...(stats.by_port ? Object.entries(stats.by_port) : [])].sort(([a], [b]) => Number(a) - Number(b));
  portBody.replaceChildren(...ports.map(([port, item]) => {
    const failed = Number(item.provider_failures || 0);
    const cls = item.error || failed > 0 ? "status-error" : item.active ? "status-active" : "status-success";
    const row = el("tr", cls);
    row.append(el("td", null, String(port)), numberCell(item.total), numberCell(item.active), numberCell(item.success), numberCell(item.error), numberCell(failed), numberCell(item.cancelled));
    return row;
  }));
  if (!ports.length) {
    const cell = document.createElement("td");
    cell.colSpan = 7;
    const emptyRow = document.createElement("tr");
    emptyRow.appendChild(cell);
    portBody.replaceChildren(emptyRow);
  }
  const errorBody = document.querySelector("#errors-table tbody");
  // Group errors by raw numeric status; semantic error details stay in the drawer.
  const errorMap = new Map();
  for (const [code, count] of Object.entries(state.facets.error_status_codes || {})) {
    errorMap.set(code, { terminal: count });
  }
  const statusCodes = [...errorMap.entries()]
    .sort(([left], [right]) => Number(left) - Number(right));
  errorBody.replaceChildren(...statusCodes.map(([statusCode, entry]) => {
    const row = el("tr", "status-error");
    row.style.cursor = "pointer";
    row.title = `Filter requests by status code "${statusCode}"`;
    row.addEventListener("click", () => drilldownErrorStatus(statusCode));
    row.append(el("td", null, statusCode), numberCell(entry.terminal));
    return row;
  }));
  if (!statusCodes.length) {
    const cell = document.createElement("td");
    cell.colSpan = 2;
    const emptyRow = document.createElement("tr");
    emptyRow.appendChild(cell);
    errorBody.replaceChildren(emptyRow);
  }
  const portSelect = document.getElementById("port-filter");
  const selectedPort = portSelect.value;
  const allPorts = el("option", null, "all ports");
  allPorts.value = "all";
  portSelect.replaceChildren(allPorts, ...Object.entries(state.facets.ports || {}).sort(([a],[b])=>Number(a)-Number(b)).map(([port]) => {
    const option = el("option", null, String(port)); option.value = String(port); return option;
  }));
  portSelect.value = [...portSelect.options].some((option) => option.value === selectedPort) ? selectedPort : "all";
  populateFacetSelect("protocol-filter", state.facets.entry_protocols || {});
  populateFacetSelect("provider-filter", state.facets.providers || {}, "all providers");
  populateFacetSelect("model-filter", state.facets.models || {}, "all models");
  populateFacetSelect("endpoint-filter", state.facets.endpoints || {}, "all endpoints");
}
function populateFacetSelect(id, facet, allLabel = "all") {
  const select = document.getElementById(id);
  const selected = select.value;
  const all = el("option", null, allLabel); all.value = "all";
  select.replaceChildren(all, ...Object.entries(facet).sort(([,a],[,b])=>b-a).map(([value]) => {
    const option = el("option", null, String(value)); option.value = String(value); return option;
  }));
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "all";
}

function numberCell(value) {
  return el("td", "num", Number(value || 0).toLocaleString());
}

function detailGrid(row) {
  const grid = el("div", "detail-grid");
  const usage = row.usage || {};
  const fields = [
    ["request key", row.request_key], ["request id", row.meta?.request_id],
    ["port", row.scope?.port], ["protocol", row.meta?.entry_protocol], ["endpoint", row.meta?.endpoint],
    ["mode", row.meta?.execution_mode], ["transport", row.meta?.transport],
    ["session", row.scope?.session], ["workdir", row.scope?.workdir],
    ["route", row.meta?.route], ["pool", row.meta?.pool],
    ["model", row.meta?.model], ["wire model", row.meta?.wire_model], ["provider", row.meta?.provider],
    ["provider id", row.meta?.provider_id], ["provider type", row.meta?.provider_type],
    ["auth key", row.meta?.auth_alias],
    ["attempts", row.attempts], ["failed attempts", row.failed_attempts], ["switches", row.switches],
    ["provider status", row.meta?.provider_status], ["response status", row.meta?.response_status],
    ["finish reason", row.meta?.finish_reason],
    ["servertool", row.servertool ? "yes" : "no"],
    ["error category", row.meta?.error_category], ["error detail", row.meta?.error_detail],
    ["usage in", usage.input_tokens != null ? Number(usage.input_tokens).toLocaleString() : "—"],
    ["usage out", usage.output_tokens != null ? Number(usage.output_tokens).toLocaleString() : "—"],
    ["usage cache read", usage.cache_read_input_tokens != null ? Number(usage.cache_read_input_tokens).toLocaleString() : (usage.cached_tokens != null ? Number(usage.cached_tokens).toLocaleString() : "—")],
    ["usage cache creation", usage.cache_creation_input_tokens != null ? Number(usage.cache_creation_input_tokens).toLocaleString() : "—"],
    ["usage total", usage.total_tokens != null ? Number(usage.total_tokens).toLocaleString() : "—"],
    ["internal time", row.timing_internal_ms != null ? `${row.timing_internal_ms} ms` : "—"],
    ["external time", row.timing_external_ms != null ? `${row.timing_external_ms} ms` : "—"],
    ["duration", fmtMs(row.duration_ms)],
    ["artifact", row.raw_artifact_ref],
    ["started", timeText(row.started_epoch_ms)], ["updated", timeText(row.updated_epoch_ms)], ["finished", timeText(row.finished_epoch_ms)],
  ];
  for (const [label, value] of fields) {
    const item = el("span");
    item.append(el("strong", null, `${label}: `), document.createTextNode(String(value ?? "—")));
    grid.appendChild(item);
  }
  return grid;
}

function checkCell(row) {
  const td = el("td", "col-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = state.selection.has(row.request_key);
  input.setAttribute("aria-label", `Select row ${timeText(row.started_epoch_ms)} ${statusText(row)} ${metaValue(row, "model")}`);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    input.checked ? state.selection.add(row.request_key) : state.selection.delete(row.request_key);
    renderSelection();
  });
  td.appendChild(input);
  return td;
}

function requestRow(row) {
  const tr = el("tr");
  tr.dataset.requestKey = row.request_key;
  tr.style.cursor = "pointer";
  tr.addEventListener("click", () => openRequestDetail(row));
  tr.appendChild(checkCell(row));
  tr.appendChild(el("td", "mono", timeText(row.started_epoch_ms)));
  tr.appendChild(el("td", "col-port", String(row.scope?.port ?? "—")));
  const code = statusText(row);
  const kind = statusOf(row);
  const codeCell = el("td", "col-code");
  codeCell.appendChild(el("span", kind === "error" ? "status-text error" : "mono", code));
  codeCell.title = row.meta?.error_category ? `${row.meta.error_category}: ${row.meta.error_detail || ""}`.trim() : kind;
  tr.appendChild(codeCell);
  const modelCell = el("td", "col-model");
  modelCell.innerHTML = `<span>${escapeHtml(metaValue(row, "provider"))}/${escapeHtml(metaValue(row, "model"))}</span> <span class="key">· ${escapeHtml(metaValue(row, "auth_alias"))}</span>`;
  tr.appendChild(modelCell);
  if ((state.entriesGroup || "pool") === "reason") {
    tr.appendChild(el("td", "col-route", metaValue(row, "route_reason")));
  } else {
    tr.appendChild(el("td", "col-pool", metaValue(row, "pool")));
  }
  const usage = row.usage || {};
  const usageCell = el("td", "mono col-usage");
  usageCell.appendChild(el("div", "usage-value", usageText(usage)));
  usageCell.appendChild(el("div", "hit-rate", hitRateText(usage)));
  tr.appendChild(usageCell);
  tr.appendChild(el("td", "num mono", fmtMs(row.duration_ms)));
  tr.appendChild(copyCell(row));
  return tr;
}

// Per-row copy affordance: copies the request id plus the error detail, which
// is what an operator pastes into an issue or a log search.
function copyCell(row) {
  const td = el("td", "col-copy");
  const button = el("button", "btn row-copy", "copy");
  button.title = "Copy request id and error detail";
  button.setAttribute("aria-label", `Copy request id ${row.meta?.request_id || row.request_key}`);
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const text = [
      `request_id: ${row.meta?.request_id || row.request_key}`,
      `request_key: ${row.request_key}`,
      `status: ${statusText(row)}`,
      `error: ${row.meta?.error_detail || row.meta?.error_category || "—"}`,
    ].join("\n");
    const ok = await copyText(text);
    showStatus(ok ? "ok" : "err", ok ? "Copied request id and error detail." : "Clipboard unavailable (browser permission denied).");
  });
  td.appendChild(button);
  return td;
}

function groupHeadRow(code, groupRows) {
  const tr = el("tr", "group-head" + (state.collapsed.has(code) ? " collapsed" : ""));
  const td = el("td");
  td.colSpan = 9;
  const btn = el("button", "group-head-btn");
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(!state.collapsed.has(code)));
  btn.appendChild(el("span", "caret", "▾"));
  btn.appendChild(el("span", "code" + (groupRank(code) === 0 ? " error" : ""), code));
  const latest = groupRows[0] ? ` · latest ${timeText(Math.max(...groupRows.map((row) => row.started_epoch_ms || 0)))}` : "";
  btn.appendChild(el("span", "n", `${groupRows.length} rows${latest}`));
  const excludedCount = state.excluded[code]?.size || 0;
  if (excludedCount) btn.appendChild(el("span", "exclude-chip", `${excludedCount} excluded`));
  btn.addEventListener("click", () => {
    state.collapsed.has(code) ? state.collapsed.delete(code) : state.collapsed.add(code);
    renderRequests();
  });
  td.appendChild(btn);
  const actions = el("span", "group-actions");
  const excludeBtn = el("button", "btn", "Exclude…");
  excludeBtn.type = "button";
  excludeBtn.setAttribute("aria-expanded", String(state.openExclude === code));
  excludeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.openExclude = state.openExclude === code ? null : code;
    renderRequests();
  });
  actions.appendChild(excludeBtn);
  td.appendChild(actions);
  tr.appendChild(td);
  return tr;
}

function excludeRowEl(code, groupRows) {
  const tr = el("tr", "exclude-row");
  const td = el("td");
  td.colSpan = 9;
  const list = el("div", "exclude-list");
  const combos = new Map();
  for (const row of groupRows) combos.set(comboOf(row), (combos.get(comboOf(row)) || 0) + 1);
  for (const [combo, count] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
    const label = el("label", "filter-item");
    const input = el("input");
    input.type = "checkbox";
    input.checked = state.excluded[code]?.has(combo) || false;
    input.addEventListener("change", () => {
      const bucket = state.excluded[code] || (state.excluded[code] = new Set());
      input.checked ? bucket.add(combo) : bucket.delete(combo);
      renderRequests();
    });
    label.append(input, el("span", null, combo), el("span", "n", String(count)));
    list.appendChild(label);
  }
  list.appendChild(el("span", "mono muted", "checked = hide that provider/model/key within this group"));
  td.appendChild(list);
  tr.appendChild(td);
  return tr;
}

function drilldownErrorStatus(code) {
  // Drill into Entries with the clicked status code, layer-2 narrowed to
  // errors, keeping the rest of the filter rail.
  state.page = 1;
  state.statusKinds = new Set(["error"]);
  state.errorStatusCode = code;
  state.tab = "entries";
  loadRecords();
}

// ---------- error-detail modal ----------
// One detail surface per request. It reads GET /api/observability/records/:request_key
// for the immutable per-attempt truth (row, error chain, health action, artifacts) and
// GET /api/observability/cooldown-pool for the *current* cooldown countdown.

const ERROR_CHAIN_STATE_CLASS = {
  raised: "bad",
  observed: "warn",
  cleared: "ok",
  not_reached: "neutral",
};

function openRequestDetail(row) {
  state.detailKey = row.request_key;
  state.detailRow = row;
  state.detail = null;
  document.getElementById("error-detail-title").textContent = `Request ${row.meta?.request_id || row.request_key}`;
  document.getElementById("error-detail-body").replaceChildren(el("div", "loading", "loading detail…"));
  openDetailModal();
  loadRequestDetail(row);
}

async function loadRequestDetail(row) {
  try {
    const detail = await api(`/api/observability/records/${encodeURIComponent(row.request_key)}`);
    if (state.detailKey !== row.request_key) return;
    state.detail = detail;
    renderDetailBody();
  } catch (error) {
    if (state.detailKey !== row.request_key) return;
    const body = document.getElementById("error-detail-body");
    body.replaceChildren(
      el("div", "error-summary", `request detail unavailable: ${error.message}`),
      detailGrid(row),
    );
  }
}

function openDetailModal() {
  const modal = document.getElementById("error-detail-modal");
  const backdrop = document.getElementById("detail-backdrop");
  if (!modal) return;
  modal.hidden = false;
  if (backdrop) backdrop.hidden = false;
  document.getElementById("error-detail-close")?.focus();
  startDetailCountdown();
}

function closeDetailModal() {
  const modal = document.getElementById("error-detail-modal");
  const backdrop = document.getElementById("detail-backdrop");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (backdrop) backdrop.hidden = true;
  state.detailKey = null;
  state.detail = null;
  state.detailRow = null;
  stopDetailCountdown();
}

function detailSection(title, hostId) {
  const section = el("div", "detail-section");
  section.appendChild(el("h3", null, title));
  const host = el("div");
  host.id = hostId;
  section.appendChild(host);
  return section;
}

function renderDetailBody() {
  const body = document.getElementById("error-detail-body");
  const detail = state.detail || {};
  const row = detail.row || state.detailRow;
  if (!body || !row) return;
  const actions = el("div", "modal-actions");
  const copyId = el("button", "btn", "Copy request id");
  copyId.addEventListener("click", async () => {
    const ok = await copyText(row.meta?.request_id || row.request_key);
    showStatus(ok ? "ok" : "err", ok ? "Copied request id." : "Clipboard unavailable (browser permission denied).");
  });
  const copyError = el("button", "btn", "Copy error detail");
  copyError.addEventListener("click", async () => {
    const ok = await copyText(errorDetailText(row, detail));
    showStatus(ok ? "ok" : "err", ok ? "Copied error detail." : "Clipboard unavailable (browser permission denied).");
  });
  actions.append(copyId, copyError);
  body.replaceChildren(
    actions,
    detailGrid(row),
    detailSection("Current cooldown (live pool)", "detail-cooldown-live"),
    detailSection("Error chain (attempt-time snapshot)", "detail-error-chain"),
    detailSection("Health action (attempt-time snapshot)", "detail-health"),
    detailSection("Artifacts", "detail-artifacts"),
  );
  renderDetailCooldown();
  renderDetailChain();
  renderDetailHealth();
  renderDetailArtifacts();
}

function errorDetailText(row, detail) {
  return JSON.stringify({
    request_key: row.request_key,
    request_id: row.meta?.request_id ?? null,
    status: statusText(row),
    error_class: row.meta?.error_class ?? null,
    error_category: row.meta?.error_category ?? null,
    error_detail: row.meta?.error_detail ?? null,
    observed_error_source: detail?.observed_error_source ?? null,
    error_chain: detail?.error_chain ?? null,
  }, null, 2);
}

function renderDetailChain() {
  const host = document.getElementById("detail-error-chain");
  if (!host) return;
  const chain = Array.isArray(state.detail?.error_chain) ? state.detail.error_chain : [];
  if (!chain.length) {
    host.replaceChildren(el("div", "loading", "no error chain recorded for this request"));
    return;
  }
  const list = el("div", "timeline");
  for (const node of chain) {
    const nodeState = node?.state || "not_reached";
    const classes = ["timeline-node"];
    if (nodeState !== "not_reached") classes.push(nodeState);
    const item = el("div", classes.join(" "));
    item.appendChild(el("span", "node-id", node?.node || "unknown"));
    const value = el("span");
    value.appendChild(el("span", `badge ${ERROR_CHAIN_STATE_CLASS[nodeState] || "neutral"}`, nodeState));
    value.appendChild(el("span", "mono", node?.code ? ` · ${node.code}` : " · code —"));
    item.appendChild(value);
    list.appendChild(item);
  }
  host.replaceChildren(list);
}

function renderDetailHealth() {
  const host = document.getElementById("detail-health");
  if (!host) return;
  const detail = state.detail || {};
  const health = detail.health_action || null;
  const rows = [];
  if (!health) {
    rows.push(el("div", "loading", "no typed health action was exposed for this attempt (unknown)"));
  } else {
    rows.push(kv("scope", health.scope ?? "unknown"));
    rows.push(kv("scope target", health.scope_target ?? "—", { mono: true }));
    rows.push(kv("reason", health.reason ?? "unknown"));
    rows.push(kv("duration", health.duration_ms != null ? fmtMs(health.duration_ms) : "unknown"));
    rows.push(kv("retry eligible", health.retry_eligible === true ? "yes" : health.retry_eligible === false ? "no" : "unknown"));
    rows.push(kv("health affecting", health.health_affecting === true ? "yes" : health.health_affecting === false ? "no" : "unknown"));
    rows.push(kv("exhaustion effect", health.exhaustion_effect ?? "unknown"));
  }
  rows.push(kv("observed error source", detail.observed_error_source ?? "—", { mono: true }));
  host.replaceChildren(...rows);
}

function renderDetailArtifacts() {
  const host = document.getElementById("detail-artifacts");
  if (!host) return;
  const detail = state.detail || {};
  const row = detail.row || state.detailRow || {};
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  if (!artifacts.length) {
    host.replaceChildren(el("div", "loading", "no artifact files for this request"));
    return;
  }
  const port = row.scope?.port;
  const requestId = row.meta?.request_id;
  host.replaceChildren(...artifacts.map((artifact) => {
    const item = el("div", "artifact-row");
    item.appendChild(el("span", "mono", artifact?.file ?? "unknown"));
    item.appendChild(el("span", "muted", artifact?.size_bytes != null ? `${Number(artifact.size_bytes).toLocaleString()} bytes` : "size unknown"));
    item.appendChild(el("span", "spacer"));
    const open = el("button", "btn", "open artifact");
    open.addEventListener("click", () => openArtifact(port, requestId, artifact?.file));
    item.appendChild(open);
    return item;
  }));
}

function openArtifact(port, requestId, file) {
  if (port == null || !requestId || !file) {
    showStatus("err", "cannot open artifact: the row is missing port / request id / file");
    return;
  }
  const params = new URLSearchParams();
  params.set("port", String(port));
  params.set("request_id", String(requestId));
  params.set("file", String(file));
  window.open(`/api/observability/artifacts/content?${params}`, "_blank", "noopener");
}

// The row's attempt-time health snapshot is immutable history; current cooldown
// truth comes only from the cooldown pool.
function cooldownIdentity(row) {
  return {
    providerId: row?.meta?.provider_id ?? row?.meta?.provider ?? null,
    authAlias: row?.meta?.auth_alias ?? null,
    modelId: row?.meta?.model ?? null,
  };
}

function findCooldownEntry(row) {
  const pool = state.cooldown;
  if (!pool || !Array.isArray(pool.listeners)) return null;
  const identity = cooldownIdentity(row);
  if (!identity.providerId) return null;
  for (const listener of pool.listeners) {
    for (const entry of listener?.entries || []) {
      if (entry?.provider_id !== identity.providerId) continue;
      if ((entry.auth_alias ?? null) !== identity.authAlias) continue;
      if (entry.model_id != null && identity.modelId != null && entry.model_id !== identity.modelId) continue;
      return { listener, entry };
    }
  }
  return null;
}

function renderDetailCooldown() {
  const host = document.getElementById("detail-cooldown-live");
  if (!host) return;
  const row = state.detail?.row || state.detailRow;
  if (!row) return;
  if (!state.cooldown) {
    host.replaceChildren(el("div", "loading", state.cooldownError
      ? `cooldown pool unavailable: ${state.cooldownError}`
      : "cooldown pool not loaded yet"));
    return;
  }
  const match = findCooldownEntry(row);
  if (!match) {
    host.replaceChildren(kv("state", "no current cooldown entry for this provider/key/model"));
    return;
  }
  const { listener, entry } = match;
  host.replaceChildren(
    kv("state", entry.state ?? "unknown"),
    kv("kind", entry.kind ?? "unknown"),
    kv("listener", `${listener.server_id ?? "unknown"} :${listener.port ?? "—"}`, { mono: true }),
    kv("reason", entry.reason ?? "—"),
    kv("failure count", entry.failure_count != null ? String(entry.failure_count) : "unknown"),
    kv("until", entry.until_ms != null ? new Date(entry.until_ms).toLocaleString([], { hour12: false }) : "unknown"),
    (() => {
      const remaining = el("div", "kv");
      remaining.appendChild(el("span", "kv-key", "remaining"));
      const value = el("span", "kv-value cooldown-remaining", "—");
      value.id = "detail-cooldown-remaining";
      remaining.appendChild(value);
      return remaining;
    })(),
  );
  updateDetailCountdown();
}

function updateDetailCountdown() {
  const host = document.getElementById("detail-cooldown-remaining");
  if (!host) return;
  const row = state.detail?.row || state.detailRow;
  const match = row ? findCooldownEntry(row) : null;
  if (!match) {
    host.textContent = "—";
    return;
  }
  const base = Number(match.listener?.now_ms);
  const remaining = Number(match.entry?.remaining_ms);
  if (!Number.isFinite(base) || !Number.isFinite(remaining)) {
    host.textContent = "unknown";
    return;
  }
  const left = remaining - (Date.now() - base);
  host.textContent = left > 0 ? `${fmtMs(left)} remaining` : "expired (pool refresh pending)";
}

function startDetailCountdown() {
  stopDetailCountdown();
  state.detailTimer = setInterval(updateDetailCountdown, 500);
}

function stopDetailCountdown() {
  if (state.detailTimer) {
    clearInterval(state.detailTimer);
    state.detailTimer = null;
  }
}

function renderRequests() {
  const panel = document.getElementById("requests-panel");
  const tab = state.tab || "entries";
  const subBar = document.getElementById("entries-sub-tab-bar");
  if (subBar) subBar.hidden = tab !== "entries";
  if (tab === "attempts") {
    renderAttemptsPanel(panel);
    wireTableResizers(panel, "attempts");
    return;
  }
  if (tab === "errors") {
    renderErrorsPanel(panel);
    wireTableResizers(panel, "errors");
    return;
  }
  renderEntriesPanel(panel);
  wireTableResizers(panel, "entries");
  syncEntriesSubTabs();
  renderPortTabs();
  renderRail();
  renderSelection();
}

// Persist per-tab column widths once each table is rendered.
function wireTableResizers(panel, tab) {
  const table = panel ? panel.querySelector("table.request-table") : null;
  if (!table) return;
  const widths = state.tableWidths[tab] || loadTableWidths(tab);
  if (widths) state.tableWidths[tab] = widths;
  applyTableWidths(table, widths);
  attachColumnResizers(table, tab);
}

function syncEntriesSubTabs() {
  const bar = document.getElementById("entries-sub-tab-bar");
  if (!bar) return;
  const active = (state.entriesGroup || "pool") === "reason" ? "reason" : "pool";
  bar.querySelectorAll(".sub-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subTab === active);
  });
}

const ENTRY_COLUMNS = [
  { key: "__check", label: "", colClass: "col-check", width: 36 },
  { key: "started_epoch_ms", label: "Time", colClass: "col-time", width: 78 },
  { key: "scope.port", label: "Port", colClass: "col-port", width: 64 },
  { key: "result", label: "Status", colClass: "col-code", width: 78 },
  { key: "meta.provider", label: "Provider · Key", colClass: "col-model", width: 220 },
  { key: "meta.pool", label: "Pool", colClass: "col-pool", width: 110 },
  { key: "usage_total_tokens", label: "Usage", colClass: "col-usage", width: 160 },
  { key: "duration_ms", label: "Duration", colClass: "col-dur", width: 84 },
  { key: "__copy", label: "", colClass: "col-copy", width: 60 },
];

function renderEntriesPanel(panel) {
  const rows = state.records;
  const fragments = [];
  if (state.errorStatusCode) {
    const banner = el("div", "status-bar info", `Filtered by error status ${state.errorStatusCode}. `);
    const clear = el("button", "btn", "Clear filter");
    clear.addEventListener("click", () => {
      state.errorStatusCode = null;
      state.page = 1;
      loadRecords();
    });
    banner.appendChild(clear);
    fragments.push(banner);
  }
  if (!rows.length) {
    fragments.push(el("div", "empty-state", "<h2>No matching requests</h2><p>Adjust your search terms or clear the checked filters.</p>"));
    panel.replaceChildren(...fragments);
    return;
  }
  const table = el("table", "request-table");
  const colgroup = el("colgroup");
  ENTRY_COLUMNS.forEach((col) => colgroup.appendChild(el("col", col.colClass)));
  table.appendChild(colgroup);
  const tableHead = document.createElement("thead");
  const head = el("tr");
  ENTRY_COLUMNS.forEach((col) => {
    const th = el("th", col.colClass, col.label);
    if (col.key === "__check") {
      const checkAll = el("input");
      checkAll.type = "checkbox";
      checkAll.id = "check-all";
      checkAll.setAttribute("aria-label", "Select all visible rows");
      checkAll.addEventListener("change", () => {
        const inputs = [...panel.querySelectorAll("#table-body td.col-check input")];
        inputs.forEach((input) => {
          input.checked = checkAll.checked;
          const key = input.closest("tr").dataset.requestKey;
          checkAll.checked ? state.selection.add(key) : state.selection.delete(key);
        });
        renderSelection();
      });
      th.textContent = "";
      th.appendChild(checkAll);
    }
    head.appendChild(th);
  });
  tableHead.appendChild(head);
  table.appendChild(tableHead);
  const body = document.createElement("tbody");
  body.id = "table-body";
  if (state.sortMode === "code") {
    const sorted = [...rows].sort((a, b) => {
      const codeA = statusText(a), codeB = statusText(b);
      const rank = compareCodes(codeA, codeB);
      if (rank !== 0) return rank;
      return (b.started_epoch_ms || 0) - (a.started_epoch_ms || 0);
    });
    const groups = new Map();
    for (const row of sorted) {
      const code = statusText(row);
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push(row);
    }
    for (const code of [...groups.keys()].sort(compareCodes)) {
      const groupRows = groups.get(code);
      body.appendChild(groupHeadRow(code, groupRows));
      if (state.openExclude === code) body.appendChild(excludeRowEl(code, groupRows));
      if (state.collapsed.has(code)) continue;
      const excluded = state.excluded[code];
      const shown = excluded ? groupRows.filter((row) => !excluded.has(comboOf(row))) : groupRows;
      for (const row of shown) body.appendChild(requestRow(row));
    }
  } else {
    for (const row of rows) body.appendChild(requestRow(row));
  }
  table.appendChild(body);
  fragments.push(table);
  panel.replaceChildren(...fragments);
  state.tableWidths.entries = loadTableWidths("entries");
  applyTableWidths(table, state.tableWidths.entries);
  attachColumnResizers(table, "entries");
  const checkAll = panel.querySelector("#check-all");
  if (checkAll) {
    const inputs = [...body.querySelectorAll("td.col-check input")];
    checkAll.checked = inputs.length > 0 && inputs.every((input) => input.checked);
    checkAll.indeterminate = inputs.some((input) => input.checked) && !inputs.every((input) => input.checked);
  }
}

function renderAttemptsPanel(panel) {
  const rows = state.attemptRecords || [];
  if (!rows.length) {
    panel.replaceChildren(el("div", "loading", "no failed attempts"));
    return;
  }
  const table = el("table", "request-table");
  const head = el("tr");
  const columns = [
    { key: "status", label: "Status", colClass: "col-code" },
    { key: "scope.port", label: "Port", colClass: "col-port" },
    { key: "meta.pool", label: "Pool", colClass: "col-pool" },
    { key: "meta.route_reason", label: "Reason", colClass: "col-route" },
    { key: "meta.provider", label: "Model", colClass: "col-model" },
    { key: "duration_ms", label: "Duration", colClass: "col-dur" },
    { key: "error", label: "Error", colClass: "col-usage" },
    { key: "switches", label: "Next", colClass: "col-finish" },
    { key: "updated_epoch_ms", label: "When", colClass: "col-time col-time-last" },
    { key: "__copy", label: "", colClass: "col-copy" },
  ];
  const colgroup = el("colgroup");
  columns.forEach((col) => colgroup.appendChild(el("col", col.colClass)));
  table.appendChild(colgroup);
  const trh = el("tr");
  columns.forEach((col) => trh.appendChild(el("th", col.colClass, col.label)));
  const tableHead = document.createElement("thead");
  tableHead.appendChild(trh);
  table.appendChild(tableHead);
  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = el("tr");
    tr.dataset.requestKey = row.request_key;
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openRequestDetail(row));
    const detail = row.meta?.error_category
      ? `${row.meta.error_category}: ${row.meta.error_detail || ""}`.trim()
      : "—";
    const codeCell = el("td", "col-code");
    codeCell.appendChild(el("span", "status-text error", statusText(row)));
    codeCell.title = detail;
    tr.appendChild(codeCell);
    tr.appendChild(el("td", "col-port", String(row.scope?.port ?? "—")));
    tr.appendChild(el("td", "col-pool", metaValue(row, "pool")));
    tr.appendChild(el("td", "col-route", metaValue(row, "route_reason")));
    tr.appendChild(el("td", "col-model", `${metaValue(row, "provider")}/${metaValue(row, "model")} · ${metaValue(row, "auth_alias")}`));
    tr.appendChild(el("td", "num mono", fmtMs(row.duration_ms)));
    tr.appendChild(el("td", "mono col-usage", detail));
    tr.appendChild(el("td", "col-finish", row.switches > 0 ? "switched" : "terminal"));
    tr.appendChild(el("td", "mono col-time col-time-last", timeText(row.updated_epoch_ms)));
    tr.appendChild(copyCell(row));
    body.appendChild(tr);
  });
  table.appendChild(body);
  panel.replaceChildren(table);
  state.tableWidths.attempts = loadTableWidths("attempts");
  applyTableWidths(table, state.tableWidths.attempts);
  attachColumnResizers(table, "attempts");
}

function renderErrorsPanel(panel) {
  const codes = state.errorFacets || [];
  if (!codes.length) {
    panel.replaceChildren(el("div", "loading", "no errors"));
    return;
  }
  const wrapper = el("div");
  const table = el("table", "request-table");
  const columns = [
    { key: "code", label: "Status", colClass: "col-code" },
    { key: "count", label: "Count", colClass: "col-port" },
    { key: "example", label: "Example detail", colClass: "col-usage" },
  ];
  const colgroup = el("colgroup");
  columns.forEach((col) => colgroup.appendChild(el("col", col.colClass)));
  table.appendChild(colgroup);
  const trh = el("tr");
  columns.forEach((col) => trh.appendChild(el("th", col.colClass, col.label)));
  const head = document.createElement("thead");
  head.appendChild(trh);
  table.appendChild(head);
  const body = document.createElement("tbody");
  codes.forEach((item) => {
    const tr = el("tr");
    tr.style.cursor = "pointer";
    tr.title = `View Requests filtered by status ${item.code}`;
    // Drilldown: jump to Entries tab with layer-2 narrowed to errors and
    // the clicked status code, keeping other filters.
    tr.addEventListener("click", () => drilldownErrorStatus(item.code));
    const codeCell = el("td", "col-code");
    codeCell.appendChild(el("span", "status-text error", item.code));
    tr.appendChild(codeCell);
    tr.appendChild(el("td", "col-port", String(item.count)));
    tr.appendChild(el("td", "mono", state.errorExamples?.[item.code] || "—"));
    body.appendChild(tr);
  });
  table.appendChild(body);
  const summary = el("div", "muted", `Total error requests: ${state.errorStatuses}`);
  wrapper.append(summary, table);
  panel.replaceChildren(wrapper);
  state.tableWidths.errors = loadTableWidths("errors");
  applyTableWidths(table, state.tableWidths.errors);
  attachColumnResizers(table, "errors");
}

function renderPortTabs() {
  const bar = document.getElementById("port-tabs");
  if (!bar) return;
  // Counts come from the unfiltered-by-port response; keep the last known
  // per-port counts while a specific port tab is active.
  const source = state.port === "all" ? (state.facets.ports || {}) : (state.portCountsCache || {});
  const ports = Object.entries(source).sort(([a], [b]) => Number(a) - Number(b));
  const tabs = [{ value: "all", label: "All ports", count: state.port === "all" ? state.total : null }];
  for (const [port, count] of ports) {
    tabs.push({ value: port, label: port, count: Number(count) });
  }
  bar.replaceChildren(...tabs.map((tab) => {
    const btn = el("button", "port-tab");
    btn.type = "button";
    btn.role = "tab";
    btn.dataset.port = tab.value;
    btn.setAttribute("aria-selected", String(state.port === tab.value));
    btn.append(el("span", null, tab.label));
    if (tab.count != null) btn.appendChild(el("span", "count", String(tab.count)));
    btn.addEventListener("click", () => {
      if (state.port === tab.value) return;
      state.port = tab.value;
      document.getElementById("port-filter").value = tab.value;
      state.page = 1;
      renderPortTabs();
      loadRecords();
    });
    return btn;
  }));
}

const STATUS_KIND_LABELS = { success: "Success (2xx)", error: "Error (4xx/5xx)", cancelled: "Cancelled (499)", active: "In progress" };

function renderRail() {
  const stats = state.stats || {};
  if (!state.statusKinds.size) {
    state.kindCounts = {
      success: Number(stats.success_count || 0),
      error: Number(stats.error_count || 0),
      cancelled: Number(stats.cancelled_count || 0),
      active: Number(stats.active_count || 0),
    };
  }
  if (!state.providerSel.size) state.providerCounts = { ...(state.facets.providers || {}) };
  if (!state.modelSel.size) state.modelCounts = { ...(state.facets.models || {}) };
  checkboxList(document.getElementById("filter-status"),
    Object.keys(STATUS_KIND_LABELS).map((kind) => [STATUS_KIND_LABELS[kind], state.kindCounts[kind] || 0]),
    new Set([...state.statusKinds].map((kind) => STATUS_KIND_LABELS[kind])),
    (label, on) => {
      const kind = Object.keys(STATUS_KIND_LABELS).find((key) => STATUS_KIND_LABELS[key] === label);
      on ? state.statusKinds.add(kind) : state.statusKinds.delete(kind);
      state.page = 1;
      loadRecords();
    });
  checkboxList(document.getElementById("filter-provider"),
    Object.entries(state.providerCounts).sort((a, b) => b[1] - a[1]),
    state.providerSel,
    (value, on) => {
      on ? state.providerSel.add(value) : state.providerSel.delete(value);
      state.page = 1;
      loadRecords();
    });
  checkboxList(document.getElementById("filter-model"),
    Object.entries(state.modelCounts).sort((a, b) => b[1] - a[1]),
    state.modelSel,
    (value, on) => {
      on ? state.modelSel.add(value) : state.modelSel.delete(value);
      state.page = 1;
      loadRecords();
    });
  document.querySelectorAll(".filter-clear").forEach((btn) => {
    btn.onclick = () => {
      state[btn.dataset.clear].clear();
      state.page = 1;
      loadRecords();
    };
  });
}

function checkboxList(container, entries, selectedSet, onToggle) {
  if (!container) return;
  container.replaceChildren(...entries.map(([value, count]) => {
    const label = el("label", "filter-item");
    const input = el("input");
    input.type = "checkbox";
    input.checked = selectedSet.has(value);
    input.addEventListener("change", () => onToggle(value, input.checked));
    label.append(input, el("span", null, value), el("span", "n", String(count)));
    return label;
  }));
  if (!entries.length) {
    container.appendChild(el("span", "mono muted tiny", "No values available in this layer"));
  }
}

// ---------- selection & export ----------
const CSV_HEAD = ["time", "port", "status", "endpoint", "provider", "model", "key", "pool", "input", "output", "duration", "request_id", "error_detail"];
// Upper bound for a filtered export so one click cannot page the whole store.
const MAX_EXPORT_ROWS = 5000;
function selectedRows() {
  return state.exports;
}
function exportFields(row) {
  const usage = row.usage || {};
  return [
    timeText(row.started_epoch_ms),
    String(row.scope?.port ?? "—"),
    statusText(row),
    endpointLabel(row.meta?.endpoint),
    String(row.meta?.provider ?? "—"),
    String(row.meta?.model ?? "—"),
    String(row.meta?.auth_alias ?? "—"),
    String(row.meta?.pool ?? "—"),
    fmtCompact(usage.input_tokens ?? 0),
    fmtCompact(usage.output_tokens ?? 0),
    fmtMs(row.duration_ms),
    String(row.meta?.request_id || row.request_key || "—"),
    String(row.meta?.error_detail || row.meta?.error_category || "—"),
  ];
}
function toTSV(rows) {
  return [CSV_HEAD.join("\t"), ...rows.map((row) => exportFields(row).join("\t"))].join("\n");
}
function toCSV(rows) {
  const esc = (value) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [CSV_HEAD.join(","), ...rows.map((row) => exportFields(row).map(esc).join(","))].join("\n");
}
function renderSelection() {
  const bar = document.getElementById("selection-bar");
  state.exports = state.records.filter((row) => state.selection.has(row.request_key));
  // The bar reflects what a selection export would actually contain: the
  // selected rows among the currently loaded records.
  bar.classList.toggle("show", state.exports.length > 0);
  document.getElementById("sel-count").textContent = String(state.exports.length);
  // The top buttons export the whole current filter, not just this page.
  const hasFiltered = Number(state.total || 0) > 0;
  for (const id of ["export-csv-top", "copy-tsv-top"]) document.getElementById(id).disabled = !hasFiltered;
}

/** Page through the current filter (including the rail multi-selects) so an
 *  export is not limited to the visible page. */
async function fetchFilteredRows() {
  const plans = activePlans();
  if (plans.length > 12) {
    throw new Error("too many checked combinations (>12 queries) — uncheck some Layer 2-4 selections");
  }
  const rows = [];
  let total = 0;
  for (const plan of plans) {
    let collected = 0;
    let planTotal = 0;
    for (let page = 1; ; page += 1) {
      const response = await fetchPlan(buildQueryParams(page), plan);
      planTotal = Number(response.total || 0);
      const batch = response.records || [];
      rows.push(...batch);
      collected += batch.length;
      if (!batch.length || collected >= planTotal || rows.length >= MAX_EXPORT_ROWS) break;
    }
    total += planTotal;
    if (rows.length >= MAX_EXPORT_ROWS) break;
  }
  return { rows, total };
}

async function copyFilteredTSV() {
  try {
    const { rows, total } = await fetchFilteredRows();
    if (!rows.length) {
      showStatus("warn", "No rows match the current filter.");
      return;
    }
    const ok = await copyText(toTSV(rows));
    const detail = rows.length < total
      ? `Copied ${rows.length} of ${total.toLocaleString()} filtered rows (export cap ${MAX_EXPORT_ROWS}).`
      : `Copied ${rows.length} filtered rows to clipboard (TSV, includes request_id / error_detail).`;
    showStatus(ok ? (rows.length < total ? "warn" : "ok") : "err", ok ? detail : "Clipboard unavailable (browser permission denied).");
  } catch (error) {
    showStatus("err", `filtered copy failed: ${error.message}`);
  }
}

async function exportFilteredCSV() {
  try {
    const { rows, total } = await fetchFilteredRows();
    if (!rows.length) {
      showStatus("warn", "No rows match the current filter.");
      return;
    }
    downloadCSV(rows);
    showStatus(rows.length < total ? "warn" : "ok", rows.length < total
      ? `Exported ${rows.length} of ${total.toLocaleString()} filtered rows (export cap ${MAX_EXPORT_ROWS}).`
      : `Exported ${rows.length} filtered rows to CSV.`);
  } catch (error) {
    showStatus("err", `filtered export failed: ${error.message}`);
  }
}

function downloadCSV(rows) {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rcc-requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyTSV() {
  const rows = selectedRows();
  if (!rows.length) return;
  try {
    const ok = await copyText(toTSV(rows));
    showStatus(ok ? "ok" : "err", ok
      ? `Copied ${rows.length} selected rows to clipboard (TSV, includes request_id / error_detail).`
      : "Clipboard unavailable (browser permission denied).");
  } catch (error) {
    showStatus("err", "Clipboard unavailable (browser permission denied).");
  }
}
function exportCSV() {
  const rows = selectedRows();
  if (!rows.length) return;
  downloadCSV(rows);
  showStatus("ok", `Exported ${rows.length} selected rows to CSV.`);
}

function renderStatsCards() {
  const stats = state.stats || {};
  const cards = document.getElementById("summary-cards");
  cards.replaceChildren();
  const total = Number(stats.count || 0);
  const providerFails = Number(stats.provider_failure_count ?? 0);
  const values = [
    ["Requests", total],
    ["Success", Number(stats.success_count ?? 0)],
    ["Errors", Number(stats.error_count ?? 0), stats.error_count > 0 ? "bad" : ""],
    ["Provider fails", providerFails, providerFails > 0 ? "bad" : ""],
    ["Input tokens", fmtCompact(Number(stats.input_tokens || 0))],
    ["Output tokens", fmtCompact(Number(stats.output_tokens || 0))],
    ["Cached tokens", fmtCompact(Number(stats.cached_tokens || 0))],
    ["Total tokens", fmtCompact(Number(stats.total_tokens || 0))],
    ["Avg cache hit", stats.cache_hit_rate_percent != null ? `${Number(stats.cache_hit_rate_percent).toFixed(1)}%` : "—"],
    ["Avg duration", stats.avg_duration_ms != null ? `${Math.round(Number(stats.avg_duration_ms))} ms` : "—"],
  ];
  for (const item of values) {
    const [label, value, tone = ""] = item;
    const card = el("div", `card stat-${label.toLowerCase().replace(/\s+/g, "-")}${tone ? ` ${tone}` : ""}`);
    card.appendChild(el("div", "label", label));
    card.appendChild(el("div", `value${tone ? ` ${tone}` : ""}`, String(value)));
    cards.appendChild(card);
  }
  const donutHost = document.getElementById("status-donut");
  if (donutHost) {
    const entries = [
      ["success", Number(stats.success_count || 0)],
      ["error", Number(stats.error_count || 0)],
      ["cancelled", Number(stats.cancelled_count || 0)],
      ["active", Number(stats.active_count || 0)],
    ];
    renderDonut(donutHost, entries, "requests");
  }
}

function renderTimeseries() {
  const chart = document.getElementById("usage-chart");
  const metric = document.getElementById("chart-metric").value;
  renderBarChart(chart, state.timeseries || [], metric, activeRange());
}

// The pager follows the active tab: Entries and Attempts each keep their own
// page number and their own server total.
function activePagination() {
  const attempts = (state.tab || "entries") === "attempts";
  return {
    attempts,
    page: attempts ? state.attemptsPage : state.page,
    total: attempts ? state.attemptsTotal : state.total,
  };
}

function renderPagination() {
  const { attempts, page, total } = activePagination();
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const info = document.getElementById("page-info");
  if (info) info.textContent = `${attempts ? "attempts " : ""}page ${page} of ${pages} · ${total.toLocaleString()} records`;
  document.getElementById("page-prev").disabled = page <= 1;
  document.getElementById("page-next").disabled = page >= pages;
}

function renderAll() {
  renderStats(state.stats);
  renderStatsCards();
  renderTimeseries();
  renderTimeHint();
  renderTabCounts();
  renderRequests();
  renderPagination();
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
    if (state.tab === "attempts") loadAttempts().then(renderAll);
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
  document.getElementById(id).addEventListener("change", () => {
    state.page = 1;
    state.attemptsPage = 1;
    loadRecords();
  });
});
["provider-filter","model-filter","endpoint-filter","route-filter","protocol-filter","mode-filter","search-filter"].forEach((id) => {
  const input = document.getElementById(id);
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.page = 1; state.attemptsPage = 1; loadRecords(); }, 400);
  });
  if (input.tagName === "SELECT") input.addEventListener("change", () => {
    state.page = 1;
    state.attemptsPage = 1;
    loadRecords();
  });
});
document.getElementById("sort-field").addEventListener("change", () => {
  setSortMode(null);
  state.page = 1;
  loadRecords();
});
document.getElementById("sort-order").addEventListener("change", () => { state.page = 1; loadRecords(); });

// ---------- absolute time range ----------
function applyAbsoluteTime() {
  const fromValue = document.getElementById("time-from").value;
  const toValue = document.getElementById("time-to").value;
  const from = fromValue ? new Date(fromValue).getTime() : null;
  const to = toValue ? new Date(toValue).getTime() : null;
  state.timeFrom = Number.isFinite(from) ? from : null;
  state.timeTo = Number.isFinite(to) ? to : null;
  state.page = 1;
  state.attemptsPage = 1;
  loadRecords();
}
function clearAbsoluteTime() {
  document.getElementById("time-from").value = "";
  document.getElementById("time-to").value = "";
  state.timeFrom = null;
  state.timeTo = null;
  state.page = 1;
  state.attemptsPage = 1;
  loadRecords();
}
function renderTimeHint() {
  const hint = document.getElementById("time-hint");
  if (!hint) return;
  if (state.timeFrom == null && state.timeTo == null) {
    hint.textContent = "An absolute range overrides the Range selector and is sent as time_from_ms / time_to_ms.";
    return;
  }
  const from = state.timeFrom != null ? new Date(state.timeFrom).toLocaleString([], { hour12: false }) : "—";
  const to = state.timeTo != null ? new Date(state.timeTo).toLocaleString([], { hour12: false }) : "—";
  hint.textContent = `absolute range active: ${from} → ${to}`;
}
for (const id of ["time-from", "time-to"]) document.getElementById(id).addEventListener("change", applyAbsoluteTime);
document.getElementById("time-clear").addEventListener("click", clearAbsoluteTime);

document.getElementById("page-prev").addEventListener("click", () => {
  const { attempts, page } = activePagination();
  if (page <= 1) return;
  if (attempts) { state.attemptsPage = page - 1; loadAttempts().then(renderAll); }
  else { state.page = page - 1; loadRecords(); }
});
document.getElementById("page-size").addEventListener("change", (event) => {
  state.pageSize = Number(event.currentTarget.value);
  state.page = 1;
  state.attemptsPage = 1;
  loadRecords();
});
document.getElementById("page-next").addEventListener("click", () => {
  const { attempts, page, total } = activePagination();
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (page >= pages) return;
  if (attempts) { state.attemptsPage = page + 1; loadAttempts().then(renderAll); }
  else { state.page = page + 1; loadRecords(); }
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
// The bar buttons export the selection; the top buttons export the whole
// current filter, not just the loaded page.
for (const id of ["copy-tsv-bar"]) document.getElementById(id).addEventListener("click", copyTSV);
for (const id of ["export-csv-bar"]) document.getElementById(id).addEventListener("click", exportCSV);
document.getElementById("copy-tsv-top").addEventListener("click", copyFilteredTSV);
document.getElementById("export-csv-top").addEventListener("click", exportFilteredCSV);
document.getElementById("sel-clear").addEventListener("click", () => {
  state.selection.clear();
  renderSelection();
  renderRequests();
});

// ---------- error-detail modal wiring ----------
document.getElementById("error-detail-close")?.addEventListener("click", closeDetailModal);
document.getElementById("detail-backdrop")?.addEventListener("click", closeDetailModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetailModal();
});

// ---------- live mode (SSE) ----------
// GET /api/observability/stream?cursor=<seq> decides *when* to re-read the
// filtered query; the server stays the single owner of filter semantics.
// Polling remains the default and resumes whenever live mode is off.

let liveReloadTimer = null;

function setLiveState(text, tone = "") {
  const node = document.getElementById("live-state");
  if (!node) return;
  node.textContent = text;
  node.className = `live-state${tone ? ` ${tone}` : ""}`;
}

function scheduleLiveReload() {
  if (liveReloadTimer) return;
  liveReloadTimer = setTimeout(() => {
    liveReloadTimer = null;
    if (state.live) loadRecords();
  }, 400);
}

function handleSseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let payload = null;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch (_error) {
    payload = null;
  }
  if (!payload) return;
  if (typeof payload.seq === "number") state.liveCursor = payload.seq;
  state.liveLastEventAtMs = Date.now();
  if (payload.error) {
    setLiveState(`stream error: ${payload.error}`, "err");
    showStatus("err", `live stream reported: ${payload.error}`);
    return;
  }
  if (event === "row") {
    state.liveEvents += 1;
    setLiveState(`live · ${state.liveEvents} rows · seq ${state.liveCursor}`, "on");
    scheduleLiveReload();
  } else if (event === "heartbeat") {
    setLiveState(`live · waiting · seq ${state.liveCursor}`, "on");
  }
}

async function readSseStream(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleSseFrame(frame);
      index = buffer.indexOf("\n\n");
    }
  }
}

async function startLive() {
  if (state.live) return;
  state.live = true;
  state.liveLastEventAtMs = Date.now();
  const controller = new AbortController();
  state.liveAbort = controller;
  setLiveState("connecting…", "on");
  const headers = { Accept: "text/event-stream" };
  const token = getAdminToken();
  if (token) headers["x-routecodex-admin-token"] = token;
  // No cursor on the first connect: the stream tails from its current
  // high-water mark and the first heartbeat seeds the cursor for reconnects.
  const cursor = state.liveCursor > 0 ? `?cursor=${state.liveCursor}` : "";
  try {
    const response = await fetch(`/api/observability/stream${cursor}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`stream unavailable (${response.status})`);
    }
    setLiveState(`live · seq ${state.liveCursor}`, "on");
    await readSseStream(response.body.getReader());
    if (state.live) stopLive("live stream ended");
  } catch (error) {
    if (controller.signal.aborted) return;
    stopLive(`live stream failed: ${error.message}`);
  }
}

function stopLive(message) {
  state.live = false;
  if (liveReloadTimer) {
    clearTimeout(liveReloadTimer);
    liveReloadTimer = null;
  }
  if (state.liveAbort) {
    state.liveAbort.abort();
    state.liveAbort = null;
  }
  const toggle = document.getElementById("live-mode");
  if (toggle) toggle.checked = false;
  setLiveState(message ? `stream error: ${message}` : "polling", message ? "err" : "");
  if (message) showStatus("err", `${message}; reverted to polling`);
}

// The stream emits a heartbeat at least once per second while idle, so a
// silence longer than 3 s is real evidence that live mode is stale.
function tickLiveLiveness() {
  if (!state.live || !state.liveLastEventAtMs) return;
  const silentMs = Date.now() - state.liveLastEventAtMs;
  if (silentMs > 3000) {
    setLiveState(`live · stale (no heartbeat for ${Math.round(silentMs / 1000)} s)`, "err");
  }
}

document.getElementById("live-mode").addEventListener("change", (event) => {
  if (event.currentTarget.checked) startLive();
  else stopLive();
});

// The add form is static and survives the 5 s pool refresh; its port options
// are repopulated on every render while the operator keeps typing.
initCooldownAddForm();

// Polling stays the fallback path and is suppressed while the stream is live.
startAutoRefresh(() => { if (!state.live) loadRecords(); }, 5000);
setInterval(() => { if (!document.hidden) loadCooldown(); }, 5000);
setInterval(() => {
  tickCooldowns();
  tickLiveLiveness();
}, 1000);

load().catch((error) => showStatus("err", `observability failed: ${error.message}`));
