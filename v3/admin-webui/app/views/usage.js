// RCC V3 Admin WebUI — Usage (Requests) view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage.js)

import { api, el, fmtMs, fmtCompact, timeText, escapeHtml, showStatus, startAutoRefresh, copyText, kv, badge, getAdminToken } from "../core.js";
import { renderBarChart, renderDonut } from "../charts.js";
import { initShell } from "../shell.js";

initShell("usage", {
  title: "Usage",
  subtitle: "Inspect requests, provider usage and cooldowns",
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
  if (row.result === "error" || row.result === "failed-attempt") {
    const terminal = row.meta?.observed_error?.chain?.find((node) =>
      node?.node === "V3Error06ClientProjected" && node?.state === "projected"
    )?.code;
    const terminalCode = typeof terminal === "number" ? terminal : Number(terminal);
    if (/^\d+$/.test(String(terminal ?? "")) && terminalCode >= 400 && terminalCode <= 599) {
      return String(terminalCode);
    }

    const errorCode = compactErrorReason(row);
    const categoryCode = /^\d+$/.test(errorCode) ? Number(errorCode) : null;
    if (categoryCode != null && categoryCode >= 400 && categoryCode <= 599) {
      return String(categoryCode);
    }

    const http = row.meta?.provider_status;
    const providerCode = Number(http);
    if (http != null && Number.isInteger(providerCode) && providerCode >= 400 && providerCode <= 599) {
      return String(providerCode);
    }
    if (errorCode === "network") {
      return "network";
    }
    return "unknown";
  }

  const errorCode = compactErrorReason(row);
  if (/^\d+$/.test(errorCode)) {
    return errorCode;
  }
  // A provider failure with no upstream HTTP response renders as its transport
  // identity, never as a fabricated HTTP code.
  if (errorCode === "network") {
    return "network";
  }
  const http = row.meta?.provider_status;
  if (http != null && Number.isFinite(Number(http))) {
    return String(http);
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
    // Provider failures that received no upstream HTTP response keep their
    // transport identity instead of a fabricated HTTP status code.
    provider_transport_error: "network",
    provider_runtime_error: "network",
    provider_response_header_timeout: "network",
    provider_websocket_protocol_error: "network",
    provider_websocket_event_error: "network",
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
  view: "requests",
  tab: "entries",
  entriesGroup: "pool",
  stats: {},
  providerUsage: [],
  providerUsageSummary: {},
  providerUsageRange: null,
  providerUsageCoverage: null,
  statisticsStats: {},
  statisticsFacets: {},
  timeseries: [],
  facets: { ports: {}, providers: {}, models: {}, routes: {}, endpoints: {}, sessions: {}, response_types: {}, entry_protocols: {}, error_status_codes: {} },
  listenerPorts: [],
  errorStatusCode: null,
  // Origin narrows an error drilldown to upstream / local / unknown. It is set
  // together with errorStatusCode by the errors table and cleared with it.
  errorOrigin: null,
  tableWidths: { entries: null, attempts: null, errors: null },
  // Provider choices are ORed. Other filter dimensions intersect them.
  sortMode: "time",
  statusKinds: new Set(),
  providerSel: new Set(),
  excluded: {},
  collapsed: new Set(),
  openExclude: null,
  selection: new Set(),
  kindCounts: {},
  providerCounts: {},
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

function rowStableKey(row) {
  const attemptIndex = row?.meta?.observed_error?.attempt_index;
  const suffix = row?.result === "failed-attempt" || row?.event_type === "request.provider_attempt_failed"
    ? `|attempt-${attemptIndex ?? row?.attempts ?? "unknown"}`
    : "|request";
  return `${row?.request_key ?? "unknown"}${suffix}`;
}

function rowType(row) {
  return row?.result === "failed-attempt" || row?.event_type === "request.provider_attempt_failed"
    ? "attempt"
    : "request";
}

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

function setUsageNotice(view, message = "", retry) {
  const notice = document.getElementById(`${view}-notice`);
  notice.classList.toggle("error-summary", Boolean(retry));
  notice.textContent = message;
  if (retry) {
    const button = el("button", "btn", "Retry");
    button.addEventListener("click", retry);
    notice.appendChild(button);
  }
}

function activeRange() {
  if (state.timeFrom != null || state.timeTo != null) return "all";
  const period = document.getElementById("calendar-period").value;
  return period === "day" ? "today" : "all";
}

function applyTimeRange(params) {
  params.set("range", activeRange());
  params.set("timezone_offset_minutes", String(new Date().getTimezoneOffset()));
  const period = state.timeFrom != null || state.timeTo != null
    ? "custom"
    : document.getElementById("calendar-period").value;
  const timezone = document.getElementById("timezone").value.trim();
  const grain = document.getElementById("chart-grain").value;
  const anchor = document.getElementById("calendar-anchor").value;
  params.set("calendar_period", period);
  if (timezone) params.set("timezone", timezone);
  if (grain) params.set("grain", grain);
  if (anchor) params.set("anchor_date", anchor);
  if (state.timeFrom != null) params.set("time_from_ms", String(state.timeFrom));
  if (state.timeTo != null) params.set("time_to_ms", String(state.timeTo));
}

// Single owner of the record query parameters: the table load, the export and
// the error-example probes all build the same filtered query.
function buildQueryParams(page, includeUsage = false) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(state.pageSize));
  if (!includeUsage) params.set("include_provider_usage", "false");
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
  if (state.providerSel.size) params.set("provider_ids", JSON.stringify([...state.providerSel]));
  const [status] = state.statusKinds;
  if (status) params.set("status", status);
  if (state.errorStatusCode) params.set("error_status_code", state.errorStatusCode);
  if (state.errorOrigin) params.set("error_origin", state.errorOrigin);
  return params;
}

function applyAttemptViewParams(params) {
  params.set("status", "retrying");
  params.set("view", "attempts");
  params.set("sort_by", "updated_epoch_ms");
  params.set("sort_order", "desc");
  return params;
}

let recordsQuery;
let renderedRecordsKey;
async function loadRecords() {
  const tab = state.tab;
  const params = buildQueryParams(tab === "attempts" ? state.attemptsPage : state.page);
  if (tab === "attempts") applyAttemptViewParams(params);
  else params.set("view", "requests");
  const key = `${tab}:${params}`;
  if (recordsQuery?.key === key) return;
  recordsQuery?.controller.abort();
  const controller = new AbortController();
  const { signal } = controller;
  recordsQuery = { key, controller };
  const panel = document.getElementById("requests-panel");
  const changed = renderedRecordsKey !== key;
  if (changed) {
    panel.hidden = true;
    document.getElementById("requests-pagination").hidden = true;
    document.getElementById("selection-bar").classList.toggle("show", false);
    for (const id of ["export-csv-top", "copy-tsv-top"]) document.getElementById(id).disabled = true;
    setUsageNotice("requests", `Loading ${tab === "entries" ? "requests" : tab}…`);
  }
  renderTabCounts();
  try {
    const response = await api(`/api/observability/records?${params}`, { signal });
    if (signal.aborted) return;
    if (tab === "attempts") {
      state.attemptRecords = response.records || [];
      state.attemptsTotal = Number(response.total || 0);
    } else {
      state.records = response.records || [];
      state.total = Number(response.total || 0);
    }
    state.stats = response.stats || {};
    state.facets = response.facets || {};
    state.listenerPorts = response.listener_ports || [];
    const errors = errorOriginRows(state.facets);
    state.errorFacets = errors.sort((a, b) => b.count - a.count);
    state.errorStatuses = errors.reduce((sum, item) => sum + item.count, 0);
    if (changed) state.errorExamples = {};
    renderedRecordsKey = key;
    panel.hidden = false;
    setUsageNotice("requests");
    renderFacetFilters();
    renderAll();
    if (tab === "errors") {
      const examples = await loadErrors(params, signal);
      if (signal.aborted) return;
      state.errorExamples = examples;
      renderRequests();
    }
  } catch (error) {
    if (signal.aborted) return;
    setUsageNotice("requests", `Could not load ${tab === "entries" ? "requests" : tab}: ${error.message}`, loadRecords);
  } finally {
    if (recordsQuery?.controller === controller) recordsQuery = null;
  }
}

let statisticsQuery;
let renderedStatisticsKey;
async function loadStatistics() {
  const params = buildQueryParams(1, true);
  params.set("view", "requests");
  params.set("page_size", "1");
  const key = String(params);
  if (statisticsQuery?.key === key) return;
  statisticsQuery?.controller.abort();
  const controller = new AbortController();
  const { signal } = controller;
  statisticsQuery = { key, controller };
  const content = document.getElementById("statistics-content");
  if (renderedStatisticsKey !== key) content.hidden = true;
  setUsageNotice("statistics", "Loading statistics…");
  try {
    const response = await api(`/api/observability/records?${params}`, { signal });
    if (signal.aborted) return;
    state.statisticsStats = response.stats || {};
    state.statisticsFacets = response.facets || {};
    state.timeseries = response.provider_usage?.timeseries?.map((bucket) => ({
      ...bucket,
      count: bucket.request_count,
      total_tokens: bucket.reported_total_tokens,
      input_tokens: bucket.effective_input_tokens,
      cached_tokens: bucket.cache_read_tokens,
    })) || response.timeseries || [];
    state.providerUsage = (response.provider_usage?.by_provider || [])
      .filter((item) => item.provider_id !== "");
    state.providerUsageSummary = response.provider_usage?.summary || state.statisticsStats;
    state.providerUsageRange = response.provider_usage?.range || null;
    state.providerUsageCoverage = response.provider_usage?.coverage || null;
    renderedStatisticsKey = key;
    content.hidden = false;
    setUsageNotice("statistics");
    renderStatistics();
  } catch (error) {
    if (signal.aborted) return;
    setUsageNotice("statistics", `Could not load statistics: ${error.message}`, loadStatistics);
  } finally {
    if (statisticsQuery?.controller === controller) statisticsQuery = null;
  }
}

// ---------- error origin ----------
// `facets.error_status_origins` is the frozen contract's answer to "how many of
// these 502s were the provider's, and how many were ours". Each (status, origin)
// pair becomes its own row so the two can never be read as one number again.

// Display order inside one status: the provider's own rejections first.
const ERROR_ORIGIN_ORDER = ["upstream", "local", "unknown"];

// Colour is a hint only; the badge always carries the origin as text so the
// column still reads correctly in greyscale.
const ERROR_ORIGIN_BADGE_KIND = { upstream: "warn", local: "bad", unknown: "neutral" };

function errorOriginBadge(origin) {
  if (!origin) return el("span", "muted", "—");
  return el("span", `badge ${ERROR_ORIGIN_BADGE_KIND[origin] || "neutral"}`, origin);
}

// Stable key for the per-pair sample-detail map.
function errorPairKey(item) {
  return item.origin ? `${item.code}|${item.origin}` : String(item.code);
}

// One row per (status, origin): numeric status ascending, then upstream before
// local before unknown. The listener emits only the origins it actually
// observed, so the zero-count filter below is defensive rather than
// load-bearing: it exists so a listener that ever does seed all three keys
// cannot produce a "502 | unknown | 0" noise row.
// Fallback: an older listener that does not send `error_status_origins` keeps
// the previous single-origin rows rather than rendering an empty table.
function errorOriginRows(facets) {
  const byStatus = facets?.error_status_origins;
  if (byStatus && typeof byStatus === "object" && Object.keys(byStatus).length) {
    return Object.keys(byStatus)
      .sort((left, right) => Number(left) - Number(right))
      .flatMap((code) => ERROR_ORIGIN_ORDER
        .map((origin) => ({ code, origin, count: Number(byStatus[code]?.[origin] || 0) }))
        .filter((item) => item.count > 0));
  }
  return Object.entries(facets?.error_status_codes || {})
    .map(([code, count]) => ({ code, origin: null, count: Number(count || 0) }))
    .sort((left, right) => Number(left.code) - Number(right.code));
}

async function loadErrors(query, signal) {
  const examples = await Promise.all(state.errorFacets.map(async (item) => {
    const params = new URLSearchParams(query);
    params.set("page", "1");
    params.set("page_size", "1");
    params.set("status", item.code === "499" ? "cancelled" : "error");
    params.set("error_status_code", item.code);
    if (item.origin) params.set("error_origin", item.origin);
    try {
      const path = "/api/observability/records";
      const response = await api(`${path}?${params}`, { signal });
      let first = response.records?.[0];
      if (!first && item.code !== "499") {
        params.set("view", "attempts");
        const attempts = await api(`${path}?${params}`, { signal });
        first = attempts.records?.[0];
      }
      return [errorPairKey(item), first?.meta?.error_detail || first?.meta?.error_category || "—"];
    } catch {
      return [errorPairKey(item), "Unavailable"];
    }
  }));
  return Object.fromEntries(examples);
}

// ---------- cooldown panel ----------
// GET /api/observability/cooldown-pool is the only current provider health /
// cooldown truth. Observability rows only ever carry immutable attempt-time
// snapshots and are never read as current state.

let cooldownQuery;
async function loadCooldown({ afterAction = false } = {}) {
  if (cooldownQuery && !afterAction) return;
  cooldownQuery?.abort();
  const controller = new AbortController();
  const { signal } = controller;
  cooldownQuery = controller;
  if (!state.cooldown) setUsageNotice("cooldown", "Loading cooldowns…");
  try {
    const cooldown = await api("/api/observability/cooldown-pool", { signal });
    if (signal.aborted) return;
    state.cooldown = cooldown;
    state.cooldownError = null;
    state.cooldownFetchedAtMs = Date.now();
  } catch (error) {
    if (signal.aborted) return;
    state.cooldown = null;
    state.cooldownError = error.message;
  } finally {
    if (cooldownQuery === controller) cooldownQuery = null;
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
    body.replaceChildren();
    setUsageNotice("cooldown", `Could not load cooldowns: ${state.cooldownError}`, loadCooldown);
    syncCooldownAddState();
    return;
  }
  if (!state.cooldown) {
    return;
  }
  setUsageNotice("cooldown");
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
  const interfaceId = entry.interface_id ?? "default";
  const authAlias = entry.auth_alias || null;
  const modelId = entry.model_id || null;
  const kind = entry.kind ?? "auth_key";
  const identity = { port: Number(listener.port), provider_id: providerId, interface_id: interfaceId, auth_alias: authAlias, model_id: modelId, kind };

  const providerCell = el("td", "col-provider");
  providerCell.appendChild(el("span", "cooldown-provider mono", providerId));
  const secondary = el("span", "cooldown-secondary");
  const secondaryParts = [`interface ${interfaceId}`];
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
  const probeBtn = el("button", "btn cooldown-action", "Enable next trial");
  const diagnosticBtn = el("button", "btn cooldown-action", "Run paid diagnostic…");
  const releaseBtn = el("button", "btn cooldown-action cooldown-release", "Release");
  if (kind === "session") {
    probeBtn.disabled = true;
    probeBtn.title = "Recovery trials apply to provider cooldowns";
  }
  if (kind === "session" || !authAlias || !modelId) {
    diagnosticBtn.disabled = true;
    diagnosticBtn.title = "Diagnostics require a provider, interface, key and model";
  }
  const buttons = [probeBtn, diagnosticBtn, releaseBtn];
  probeBtn.addEventListener("click", () => manualCooldownProbe(identity, buttons));
  diagnosticBtn.addEventListener("click", () => manualCooldownDiagnostic(identity, buttons));
  releaseBtn.addEventListener("click", () => manualCooldownRelease(identity, buttons));
  actionsCell.append(probeBtn, diagnosticBtn, releaseBtn);
  tr.appendChild(actionsCell);
  return tr;
}

function cooldownBadge(state) {
  const node = badge(COOLDOWN_STATE_BADGE[state] || "neutral");
  node.textContent = state || "unknown";
  return node;
}

function cooldownIdentityText({ provider_id, interface_id, auth_alias, model_id }) {
  const parts = [provider_id ?? "unknown"];
  if (interface_id) parts.push(`interface ${interface_id}`);
  if (auth_alias) parts.push(`key ${auth_alias}`);
  if (model_id) parts.push(`model ${model_id}`);
  return parts.join(" · ");
}

// Every action disables its own buttons while in flight, reports the outcome
// through showStatus, and re-reads GET /api/observability/cooldown-pool. No
// optimistic mutation of state.cooldown: the pool stays the only truth.
async function runCooldownAction(buttons, run, errorPrefix) {
  const disabled = buttons.map((button) => button?.disabled);
  for (const button of buttons) if (button) button.disabled = true;
  try {
    try {
      await run();
    } catch (error) {
      showStatus("err", `${errorPrefix}: ${error.message}`);
    }
    await loadCooldown({ afterAction: true });
  } finally {
    buttons.forEach((button, index) => { if (button) button.disabled = disabled[index]; });
  }
}

// Release is a direct POST: the row already names the exact identity and kind
// being cleared, and the entry stays visible until the pool re-read confirms it
// is gone, so a second modal step would only add a failure mode.
async function manualCooldownRelease(identity, buttons) {
  const label = cooldownIdentityText(identity);
  await runCooldownAction(buttons, async () => {
    const body = { port: identity.port, provider_id: identity.provider_id, interface_id: identity.interface_id || "default", kind: identity.kind };
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
    const body = { port: identity.port, provider_id: identity.provider_id, interface_id: identity.interface_id || "default" };
    if (identity.auth_alias) body.auth_alias = identity.auth_alias;
    if (identity.model_id) body.model_id = identity.model_id;
    const result = await api("/api/observability/cooldown-pool/probe", { method: "POST", body: JSON.stringify(body) });
    if (result?.scheduled === false) {
      showStatus("warn", `No pending recovery trial for ${label}.`);
    } else {
      showStatus("ok", `The next eligible request can try ${label} once the cooldown ends.`);
    }
  }, `Could not enable the next trial for ${label}`);
}

async function manualCooldownDiagnostic(identity, buttons) {
  const label = cooldownIdentityText(identity);
  if (!window.confirm(`Send one upstream diagnostic request for ${label} on port ${identity.port}? The provider may charge for this request. This only observes the result and does not change cooldown or recovery timing.`)) return;
  await runCooldownAction(buttons, async () => {
    const body = {
      port: identity.port,
      provider_id: identity.provider_id,
      interface_id: identity.interface_id || "default",
      auth_alias: identity.auth_alias,
      model_id: identity.model_id,
      allow_paid_diagnostic: true,
    };
    const result = await api("/api/observability/cooldown-pool/probe", { method: "POST", body: JSON.stringify(body) });
    const outcome = result?.diagnostic;
    const messages = {
      succeeded: "The upstream diagnostic succeeded.",
      failed: outcome?.http_status != null ? `The upstream diagnostic failed with HTTP ${outcome.http_status}.` : "The upstream diagnostic failed without an HTTP response.",
      timed_out: "The upstream diagnostic timed out.",
      already_owned: "A diagnostic is already running for this identity. No new request was sent.",
      capacity_unavailable: "Diagnostic capacity is unavailable. No request was sent.",
      owner_unavailable: "The listener could not complete the diagnostic.",
    };
    const message = messages[outcome?.status];
    if (!message) throw new Error("The listener returned no recognized diagnostic outcome");
    showStatus(outcome.status === "succeeded" ? "ok" : "warn", `${label}: ${message} Cooldown and recovery timing are unchanged.`);
  }, `Diagnostic failed for ${label}`);
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
  const interfaceId = (document.getElementById("cooldown-add-interface")?.value || "").trim();
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
  else if (!interfaceId) invalid = "interface id is required";
  else if (!COOLDOWN_ADD_KINDS.includes(kind)) invalid = "kind must be auth_key or probe";
  else if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > COOLDOWN_MANUAL_MAX_MS) {
    invalid = `duration must be a whole number of 1..${COOLDOWN_MANUAL_MAX_MS} ms (24 h)`;
  }
  if (invalid) {
    errorHost.textContent = invalid;
    showStatus("err", `add cooldown: ${invalid}`);
    return;
  }

  const body = { port, provider_id: provider, interface_id: interfaceId, kind, duration_ms: durationMs };
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

function renderStats(stats, facets) {
  const portBody = document.querySelector("#ports-table tbody");
  const ports = [...(stats.by_port ? Object.entries(stats.by_port) : [])].sort(([a], [b]) => Number(a) - Number(b));
  portBody.replaceChildren(...ports.map(([port, item]) => {
    const failed = Number(item.provider_failures || 0);
    const cls = item.error || failed > 0 ? "status-error" : item.active ? "status-active" : "status-success";
    const row = el("tr", cls);
    row.append(
      selectionCell(String(port), null, () => selectPort(port), "port", document.getElementById("port-filter").value === port),
      numberCell(item.total), numberCell(item.active), numberCell(item.success), numberCell(item.error), numberCell(failed), numberCell(item.cancelled)
    );
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
  // One row per (status, origin): the single "502 | 1699" row is exactly what
  // made operators read our own transport failures as provider rejections.
  // Semantic error details stay in the drawer.
  const errorRows = errorOriginRows(facets);
  errorBody.replaceChildren(...errorRows.map((item) => {
    const row = el("tr", "status-error");
    row.style.cursor = "pointer";
    row.title = item.origin
      ? `Filter requests by status code "${item.code}" from the ${item.origin} origin`
      : `Filter requests by status code "${item.code}"`;
    wireRowAction(row, () => drilldownErrorStatus(item.code, item.origin));
    const originCell = document.createElement("td");
    originCell.appendChild(errorOriginBadge(item.origin));
    row.append(el("td", null, item.code), originCell, numberCell(item.count));
    return row;
  }));
  if (!errorRows.length) {
    const cell = document.createElement("td");
    cell.colSpan = 3;
    const emptyRow = document.createElement("tr");
    emptyRow.appendChild(cell);
    errorBody.replaceChildren(emptyRow);
  }
}

function renderFacetFilters() {
  renderPortOptions(document.getElementById("port-filter"));
  populateFacetSelect("protocol-filter", state.facets.entry_protocols || {});
  populateFacetSelect("model-filter", state.facets.models || {}, "all models");
  populateFacetSelect("endpoint-filter", state.facets.endpoints || {}, "all endpoints");
}

function renderProviderUsage() {
  const body = document.querySelector("#provider-usage-table tbody");
  const coverage = document.getElementById("provider-usage-coverage");
  if (!body || !coverage) return;
  const rows = state.providerUsage || [];
  if (!rows.length) {
    const cell = el("td", "empty-state", "No matching provider usage in the selected range.");
    cell.colSpan = 10;
    body.replaceChildren(el("tr", null, cell));
  } else {
    body.replaceChildren(...rows.map((item) => {
      const providerId = item.provider_id ?? null;
      const label = providerId ?? "unattributed";
      const selected = providerId != null && state.providerSel.has(providerId);
      const row = el("tr", "provider-usage-row");
      row.append(
        selectionCell(label, null, () => selectProvider(providerId), "provider", selected),
        numberCell(item.request_count),
        numberCell(item.failed_attempt_count),
        usageNumberCell(item.reported_effective_input_tokens),
        usageNumberCell(item.output_tokens),
        usageNumberCell(item.reported_total_tokens),
        usageNumberCell(item.cache_read_tokens),
        usageNumberCell(item.cache_write_tokens),
        el("td", "num", item.cache_hit_rate_percent == null ? "—" : `${Number(item.cache_hit_rate_percent).toFixed(1)}%`)
      );
      const actions = el("td", null);
      actions.appendChild(selectionButton(selected ? "Clear" : "Filter", () => selectProvider(providerId), "provider", selected));
      row.appendChild(actions);
      return row;
    }));
  }
  const range = state.providerUsageRange || {};
  const scope = state.providerUsageCoverage || {};
  const timezone = range.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatTime = (value) => value == null ? null : new Date(Number(value)).toLocaleString(undefined, { timeZone: timezone });
  const from = formatTime(range.resolved_from_ms) ?? "open start";
  const to = formatTime(range.resolved_to_ms) ?? "open end";
  const detailStart = formatTime(scope.detail_started_epoch_ms ?? scope.retained_from_ms) ?? "unknown";
  const statsStart = formatTime(scope.statistics_started_epoch_ms) ?? "unknown";
  const source = scope.source === "durable_facts" ? "Recorded statistics" : "Retained statistics";
  const partial = scope.partial ? " · partial coverage" : "";
  coverage.textContent = `${timezone} · ${from} to ${to} · ${source} from ${statsStart} · request details from ${detailStart}${partial}`;
}

function usageNumberCell(value) {
  return value == null ? el("td", "num", "—") : numberCell(value);
}
function populateFacetSelect(id, facet, allLabel = "all") {
  const select = document.getElementById(id);
  const selected = select.value;
  const options = { ...facet };
  if (selected !== "all") options[selected] ??= 0;
  const all = el("option", null, allLabel); all.value = "all";
  select.replaceChildren(all, ...Object.entries(options).sort(([,a],[,b])=>b-a).map(([value]) => {
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
  const stableKey = rowStableKey(row);
  input.checked = state.selection.has(stableKey);
  input.setAttribute("aria-label", `Select row ${timeText(row.started_epoch_ms)} ${statusText(row)} ${metaValue(row, "model")}`);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    input.checked ? state.selection.add(stableKey) : state.selection.delete(stableKey);
    renderSelection();
  });
  td.appendChild(input);
  return td;
}

function providerIdOf(row) {
  const explicit = row?.meta?.provider_id;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return null;
}

function renderPortOptions(select, selected = select.value) {
  const ports = new Set(state.listenerPorts.map(String));
  if (selected !== "all") ports.add(selected);
  const allPorts = el("option", null, "All ports");
  allPorts.value = "all";
  select.replaceChildren(allPorts, ...[...ports]
    .sort((a, b) => Number(a) - Number(b))
    .map((port) => {
      const option = el("option", null, String(port));
      option.value = String(port);
      return option;
    }));
  select.value = selected;
}

function selectionButton(label, onClick, subject, pressed = false) {
  const button = el("button", `selection-link${pressed ? " active" : ""}`, String(label ?? "—"));
  button.type = "button";
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute("aria-label", `${pressed ? "Clear" : "Filter by"} ${subject} ${label ?? "unknown"}`);
  button.disabled = typeof onClick !== "function";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (typeof onClick === "function") onClick();
  });
  return button;
}

function selectionCell(label, className, onClick, subject, pressed = false) {
  const td = el("td", className);
  td.appendChild(selectionButton(label, onClick, subject, pressed));
  return td;
}

function selectPort(port) {
  renderPortOptions(document.getElementById("port-filter"), String(port));
  resetSelectionAndPage();
  openUsageView("requests");
}

function selectProvider(providerId) {
  if (providerId == null || providerId === "") return;
  if (state.providerSel.has(providerId)) state.providerSel.delete(providerId);
  else state.providerSel.add(providerId);
  resetSelectionAndPage();
  renderSelectionSummary();
  openUsageView("requests");
}

function clearSelectedProvider() {
  state.providerSel.clear();
  resetSelectionAndPage();
  renderSelectionSummary();
  load();
}

function resetSelectionAndPage() {
  state.page = 1;
  state.attemptsPage = 1;
  state.selection.clear();
}

function renderSelectionSummary() {
  const providers = [...state.providerSel];
  document.getElementById("selection-summary").hidden = !providers.length;
  document.getElementById("selected-provider-label").textContent = `Provider: ${providers.join(", ")}`;
  document.getElementById("provider-usage-clear").hidden = !providers.length;
}

function wireRowAction(row, activate) {
  row.tabIndex = 0;
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (event) => {
    if (event.target !== row || event.key !== "Enter") return;
    event.preventDefault();
    activate();
  });
}

function requestRow(row) {
  const tr = el("tr");
  tr.dataset.requestKey = row.request_key;
  tr.dataset.rowKey = rowStableKey(row);
  tr.style.cursor = "pointer";
  wireRowAction(tr, () => openRequestDetail(row));
  tr.appendChild(checkCell(row));
  tr.appendChild(el("td", "mono", timeText(row.started_epoch_ms)));
  const port = row.scope?.port;
  tr.appendChild(selectionCell(String(port ?? "—"), "col-port", () => selectPort(port), "port"));
  const code = statusText(row);
  const kind = statusOf(row);
  const codeCell = el("td", "col-code");
  codeCell.appendChild(el("span", kind === "error" ? "status-text error" : "mono", code));
  codeCell.title = row.meta?.error_category ? `${row.meta.error_category}: ${row.meta.error_detail || ""}`.trim() : kind;
  tr.appendChild(codeCell);
  const modelCell = el("td", "col-model");
  const providerId = providerIdOf(row);
  const providerButton = selectionButton(metaValue(row, "provider"), () => selectProvider(providerId), "provider");
  providerButton.disabled = providerId == null;
  providerButton.title = providerId ? `Filter by provider ${providerId}` : "Provider id unavailable for this row";
  const model = el("span", null, `/${metaValue(row, "model")}`);
  const key = el("span", "key", ` · ${metaValue(row, "auth_alias")}`);
  modelCell.append(providerButton, model, key);
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

function drilldownErrorStatus(code, origin = null) {
  // Drill into Entries with the clicked (status, origin) pair, layer-2 narrowed
  // to errors, keeping the rest of the filter rail. The origin travels with the
  // status so "502 upstream" never lands on the local 502 rows.
  state.page = 1;
  state.statusKinds = new Set([code === "499" ? "cancelled" : "error"]);
  state.errorStatusCode = code;
  state.errorOrigin = origin;
  state.tab = "entries";
  openUsageView("requests");
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
  loadCooldown();
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
      : "Loading current cooldown…"));
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
  renderRail();
  if (tab === "attempts") {
    renderAttemptsPanel(panel);
    wireTableResizers(panel, "attempts");
    renderSelection();
    return;
  }
  if (tab === "errors") {
    renderErrorsPanel(panel);
    wireTableResizers(panel, "errors");
    renderSelection();
    return;
  }
  renderEntriesPanel(panel);
  wireTableResizers(panel, "entries");
  syncEntriesSubTabs();
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
    const originLabel = state.errorOrigin ? ` (${state.errorOrigin})` : "";
    const banner = el("div", "status-bar info", `Filtered by error status ${state.errorStatusCode}${originLabel}. `);
    const clear = el("button", "btn", "Clear filter");
    clear.addEventListener("click", () => {
      state.errorStatusCode = null;
      state.errorOrigin = null;
      state.statusKinds.clear();
      state.page = 1;
      loadRecords();
    });
    banner.appendChild(clear);
    fragments.push(banner);
  }
  if (!rows.length) {
    fragments.push(el("div", "empty-state", "No requests match these filters."));
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
          const key = input.closest("tr").dataset.rowKey;
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
    panel.replaceChildren(el("div", "empty-state", "No failed attempts match these filters."));
    return;
  }
  const table = el("table", "request-table");
  const head = el("tr");
  const columns = [
    { key: "__check", label: "", colClass: "col-check" },
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
  const checkAll = el("input");
  checkAll.type = "checkbox";
  checkAll.id = "check-all";
  checkAll.setAttribute("aria-label", "Select all visible attempts");
  checkAll.addEventListener("change", () => {
    const inputs = [...panel.querySelectorAll("td.col-check input")];
    inputs.forEach((input) => {
      input.checked = checkAll.checked;
      const key = input.closest("tr").dataset.rowKey;
      checkAll.checked ? state.selection.add(key) : state.selection.delete(key);
    });
    renderSelection();
  });
  trh.children[0].textContent = "";
  trh.children[0].appendChild(checkAll);
  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = el("tr");
    tr.dataset.requestKey = row.request_key;
    tr.dataset.rowKey = rowStableKey(row);
    tr.style.cursor = "pointer";
    wireRowAction(tr, () => openRequestDetail(row));
    const detail = row.meta?.error_category
      ? `${row.meta.error_category}: ${row.meta.error_detail || ""}`.trim()
      : "—";
    const codeCell = el("td", "col-code");
    codeCell.appendChild(el("span", "status-text error", statusText(row)));
    codeCell.title = detail;
    tr.appendChild(checkCell(row));
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
  const inputs = [...panel.querySelectorAll("td.col-check input")];
  checkAll.checked = inputs.length > 0 && inputs.every((input) => input.checked);
  checkAll.indeterminate = inputs.some((input) => input.checked) && !inputs.every((input) => input.checked);
}

function renderErrorsPanel(panel) {
  const codes = state.errorFacets || [];
  if (!codes.length) {
    panel.replaceChildren(el("div", "empty-state", "No errors match these filters."));
    return;
  }
  const wrapper = el("div");
  const table = el("table", "request-table");
  const columns = [
    { key: "code", label: "Status", colClass: "col-code" },
    { key: "origin", label: "Origin", colClass: "col-origin" },
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
    tr.title = item.origin
      ? `View Requests filtered by status ${item.code} from the ${item.origin} origin`
      : `View Requests filtered by status ${item.code}`;
    // Drilldown: jump to Entries tab with layer-2 narrowed to errors and
    // the clicked (status, origin) pair, keeping other filters.
    wireRowAction(tr, () => drilldownErrorStatus(item.code, item.origin));
    const codeCell = el("td", "col-code");
    codeCell.appendChild(el("span", "status-text error", item.code));
    tr.appendChild(codeCell);
    const originCell = el("td", "col-origin");
    originCell.appendChild(errorOriginBadge(item.origin));
    tr.appendChild(originCell);
    tr.appendChild(el("td", "col-port", String(item.count)));
    tr.appendChild(el("td", "mono", state.errorExamples?.[errorPairKey(item)] || "—"));
    body.appendChild(tr);
  });
  table.appendChild(body);
  wrapper.appendChild(table);
  panel.replaceChildren(wrapper);
  state.tableWidths.errors = loadTableWidths("errors");
  applyTableWidths(table, state.tableWidths.errors);
  attachColumnResizers(table, "errors");
}

const STATUS_KIND_LABELS = { success: "Success (2xx)", error: "Error (4xx/5xx)", cancelled: "Cancelled (499)", active: "In progress" };

function renderRail() {
  const stats = state.stats || {};
  if (state.tab !== "attempts" && !state.statusKinds.size) {
    state.kindCounts = {
      success: Number(stats.success_count || 0),
      error: Number(stats.error_count || 0),
      cancelled: Number(stats.cancelled_count || 0),
      active: Number(stats.active_count || 0),
    };
  }
  if (!state.providerSel.size) state.providerCounts = { ...(state.facets.provider_ids || {}) };
  const statuses = document.getElementById("filter-status");
  statuses.parentElement.hidden = state.tab === "attempts";
  checkboxList(statuses,
    Object.keys(STATUS_KIND_LABELS).map((kind) => [STATUS_KIND_LABELS[kind], state.kindCounts[kind] || 0]),
    new Set([...state.statusKinds].map((kind) => STATUS_KIND_LABELS[kind])),
    (label, on) => {
      const kind = Object.keys(STATUS_KIND_LABELS).find((key) => STATUS_KIND_LABELS[key] === label);
      state.statusKinds = new Set(on ? [kind] : []);
      state.errorStatusCode = null;
      state.errorOrigin = null;
      resetSelectionAndPage();
      loadRecords();
    });
  checkboxList(document.getElementById("filter-provider"),
    Object.entries(state.providerCounts).sort((a, b) => b[1] - a[1]),
    state.providerSel,
    (value, on) => {
      on ? state.providerSel.add(value) : state.providerSel.delete(value);
      resetSelectionAndPage();
      renderSelectionSummary();
      loadRecords();
    });
  document.querySelectorAll(".filter-clear[data-clear]").forEach((btn) => {
    btn.onclick = () => {
      state[btn.dataset.clear].clear();
      resetSelectionAndPage();
      renderSelectionSummary();
      loadRecords();
    };
  });
  renderSelectionSummary();
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
const CSV_HEAD = [
  "row_type", "row_key", "time", "port", "status", "endpoint", "provider", "provider_id", "model", "key", "pool",
  "input", "output", "total", "cache_read", "cache_write", "cache_hit_rate", "duration", "request_id", "error_detail",
];
// Upper bound for a filtered export so one click cannot page the whole store.
const MAX_EXPORT_ROWS = 5000;
function selectedRows() {
  return state.exports;
}
function exportFields(row) {
  const usage = row.usage || {};
  const normalized = row.usage_normalized || {};
  return [
    rowType(row),
    rowStableKey(row),
    timeText(row.started_epoch_ms),
    String(row.scope?.port ?? "—"),
    statusText(row),
    endpointLabel(row.meta?.endpoint),
    String(row.meta?.provider ?? "—"),
    String(providerIdOf(row) ?? "—"),
    String(row.meta?.model ?? "—"),
    String(row.meta?.auth_alias ?? "—"),
    String(row.meta?.pool ?? "—"),
    fmtCompact(normalized.effective_input_tokens ?? usage.input_tokens ?? 0),
    fmtCompact(normalized.output_tokens ?? usage.output_tokens ?? 0),
    fmtCompact(normalized.reported_total_tokens ?? usage.total_tokens ?? 0),
    fmtCompact(normalized.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0),
    fmtCompact(normalized.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0),
    normalized.cache_hit_rate_percent != null ? Number(normalized.cache_hit_rate_percent).toFixed(1) : "—",
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
  const { attempts, total } = activePagination();
  const visibleRows = attempts ? state.attemptRecords : state.records;
  state.exports = visibleRows.filter((row) => state.selection.has(rowStableKey(row)));
  // The bar reflects what a selection export would actually contain: the
  // selected rows among the currently loaded records.
  bar.classList.toggle("show", state.exports.length > 0);
  document.getElementById("sel-count").textContent = String(state.exports.length);
  // The top buttons export the whole current filter, not just this page.
  const hasFiltered = total > 0;
  for (const id of ["export-csv-top", "copy-tsv-top"]) document.getElementById(id).disabled = !hasFiltered;
}

/** Page through the current filter (including the rail multi-selects) so an
 *  export is not limited to the visible page. */
async function fetchFilteredRows() {
  const rows = [];
  let total = 0;
  const attempts = (state.tab || "entries") === "attempts";
  for (let page = 1; ; page += 1) {
    const params = attempts
      ? applyAttemptViewParams(buildQueryParams(page))
      : buildQueryParams(page);
    if (!attempts) params.set("view", "requests");
    const response = await api(`/api/observability/records?${params}`);
    total = Number(response.total || 0);
    const batch = response.records || [];
    rows.push(...batch);
    if (!batch.length || rows.length >= total || rows.length >= MAX_EXPORT_ROWS) break;
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
    downloadCSV(rows, (state.tab || "entries") === "attempts" ? "attempts" : "requests");
    showStatus(rows.length < total ? "warn" : "ok", rows.length < total
      ? `Exported ${rows.length} of ${total.toLocaleString()} filtered rows (export cap ${MAX_EXPORT_ROWS}).`
      : `Exported ${rows.length} filtered rows to CSV.`);
  } catch (error) {
    showStatus("err", `filtered export failed: ${error.message}`);
  }
}

function downloadCSV(rows, view = "requests") {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rcc-${view}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
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
  downloadCSV(rows, (state.tab || "entries") === "attempts" ? "attempts" : "requests");
  showStatus("ok", `Exported ${rows.length} selected rows to CSV.`);
}

function renderStatsCards() {
  const stats = state.providerUsageSummary;
  const cards = document.getElementById("summary-cards");
  cards.replaceChildren();
  const total = Number(stats.request_count ?? stats.count ?? 0);
  const providerFails = Number(stats.failed_attempt_count ?? stats.provider_failure_count ?? 0);
  const values = [
    ["Requests", total],
    ["Success", Number(stats.success_count ?? 0)],
    ["Errors", Number(stats.error_count ?? 0), stats.error_count > 0 ? "bad" : ""],
    ["Provider fails", providerFails, providerFails > 0 ? "bad" : ""],
    ["Input tokens", fmtCompact(Number(stats.effective_input_tokens ?? stats.input_tokens ?? 0))],
    ["Output tokens", fmtCompact(Number(stats.output_tokens || 0))],
    ["Cached tokens", fmtCompact(Number(stats.cache_read_tokens ?? stats.cached_tokens ?? 0))],
    ["Total tokens", fmtCompact(Number(stats.reported_total_tokens ?? stats.total_tokens ?? 0))],
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
  document.getElementById("requests-pagination").hidden = state.tab === "errors";
  const { attempts, page, total } = activePagination();
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const info = document.getElementById("page-info");
  if (info) info.textContent = `${attempts ? "attempts " : ""}page ${page} of ${pages} · ${total.toLocaleString()} records`;
  document.getElementById("page-prev").disabled = page <= 1;
  document.getElementById("page-next").disabled = page >= pages;
}

function renderAll() {
  renderTimeHint();
  renderTabCounts();
  renderRequests();
  renderPagination();
  renderSelectionSummary();
}

function renderStatistics() {
  renderStats(state.statisticsStats, state.statisticsFacets);
  renderProviderUsage();
  renderStatsCards();
  renderTimeseries();
}

function load() {
  if (state.view === "statistics") return loadStatistics();
  if (state.view === "cooldown") return loadCooldown();
  return loadRecords();
}

function openUsageView(view) {
  state.view = view;
  for (const button of document.querySelectorAll("[data-usage-view]")) {
    const active = button.dataset.usageView === view;
    button.setAttribute("aria-pressed", String(active));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !active;
  }
  document.getElementById("usage-period").hidden = view === "cooldown";
  document.getElementById("usage-request-filters").hidden = view !== "requests";
  load();
}

function renderTabCounts() {
  const counts = { entries: state.total, attempts: state.attemptsTotal, errors: state.errorStatuses };
  const pending = document.getElementById("requests-panel").hidden;
  document.querySelectorAll("#requests-tab-bar .tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab;
    const active = tab === state.tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    const count = document.getElementById(`tab-count-${tab}`);
    count.hidden = !active || pending;
    count.textContent = counts[tab].toLocaleString();
  });
}

document.getElementById("usage-refresh").addEventListener("click", () => load());
document.querySelectorAll("[data-usage-view]").forEach((button) => {
  button.addEventListener("click", () => openUsageView(button.dataset.usageView));
});
document.querySelectorAll("#requests-tab-bar .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    state.selection.clear();
    loadRecords();
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
document.getElementById("calendar-period").addEventListener("change", () => {
  if (document.getElementById("calendar-period").value === "custom") {
    document.getElementById("usage-calendar").open = true;
  }
  resetSelectionAndPage();
  load();
});
document.getElementById("chart-grain").addEventListener("change", loadStatistics);
document.getElementById("chart-metric").addEventListener("change", renderTimeseries);
["model-filter","endpoint-filter","route-filter","protocol-filter","mode-filter","search-filter"].forEach((id) => {
  const input = document.getElementById(id);
  let timer = null;
  const isSelect = input.tagName === "SELECT";
  input.addEventListener(isSelect ? "change" : "input", () => {
    clearTimeout(timer);
    const apply = () => {
      resetSelectionAndPage();
      loadRecords();
    };
    if (isSelect) apply();
    else timer = setTimeout(apply, 400);
  });
});
document.getElementById("port-filter").addEventListener("change", () => {
  resetSelectionAndPage();
  loadRecords();
});
document.getElementById("timezone").addEventListener("change", (event) => {
  const timezone = event.currentTarget.value.trim();
  if (!timezone) event.currentTarget.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  resetSelectionAndPage();
  load();
});
document.getElementById("calendar-anchor").addEventListener("change", () => {
  resetSelectionAndPage();
  load();
});
document.getElementById("clear-selected-provider").addEventListener("click", clearSelectedProvider);
document.getElementById("provider-usage-clear").addEventListener("click", clearSelectedProvider);
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
  resetSelectionAndPage();
  renderTimeHint();
  load();
}
function clearAbsoluteTime() {
  document.getElementById("time-from").value = "";
  document.getElementById("time-to").value = "";
  state.timeFrom = null;
  state.timeTo = null;
  resetSelectionAndPage();
  renderTimeHint();
  load();
}
function renderTimeHint() {
  const hint = document.getElementById("time-hint");
  if (!hint) return;
  hint.hidden = state.timeFrom == null && state.timeTo == null;
  if (hint.hidden) return;
  const from = state.timeFrom != null ? new Date(state.timeFrom).toLocaleString([], { hour12: false }) : "—";
  const to = state.timeTo != null ? new Date(state.timeTo).toLocaleString([], { hour12: false }) : "—";
  hint.textContent = `Absolute range: ${from} → ${to}. This overrides the selected period.`;
}
for (const id of ["time-from", "time-to"]) document.getElementById(id).addEventListener("change", applyAbsoluteTime);
document.getElementById("time-clear").addEventListener("click", clearAbsoluteTime);

document.getElementById("page-prev").addEventListener("click", () => {
  const { attempts, page } = activePagination();
  if (page <= 1) return;
  if (attempts) state.attemptsPage = page - 1;
  else state.page = page - 1;
  loadRecords();
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
  if (attempts) state.attemptsPage = page + 1;
  else state.page = page + 1;
  loadRecords();
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
    if (state.live && state.view === "requests") loadRecords();
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
document.getElementById("timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
document.getElementById("usage-filters").open = !window.matchMedia("(max-width: 1000px)").matches;
renderSelectionSummary();

// Polling stays the fallback path and is suppressed while the stream is live.
startAutoRefresh(() => {
  if (!state.live && state.view === "requests") loadRecords();
  if (state.view === "cooldown" || state.detailKey) loadCooldown();
}, 5000);
setInterval(() => {
  tickCooldowns();
  tickLiveLiveness();
}, 1000);

load();
