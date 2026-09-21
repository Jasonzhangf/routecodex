// RCC V3 Admin WebUI — Usage (Requests) panel rendering.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-panels.js)
//
// The three Entries / Attempts / Errors panels and the row/cell renderers they
// share. Kept out of usage.js so the view stays a thin orchestrator.

import { el, fmtMs, fmtCompact, timeText, escapeHtml } from "../core.js";
import { state, hooks } from "./usage-state.js";
import { openPanel } from "../drawer.js";
import { drilldownErrorStatus, renderRail } from "./usage-filters.js";
import {
  renderEntriesPanel, renderAttemptsPanel, renderErrorsPanel,
} from "./usage-panel-views.js";


export function endpointLabel(endpoint) {
  if (endpoint == null || endpoint === "—") return "—";
  if (endpoint === "/v1/responses") return "responses";
  if (endpoint === "/v1/chat/completions") return "chat";
  if (endpoint === "/v1/messages") return "messages";
  if (endpoint === "/v1beta/models") return "gemini";
  return endpoint;
}

export function statusText(row) {
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

export function metaValue(row, key) {
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
export function compareCodes(a, b) {
  const ra = groupRank(a), rb = groupRank(b);
  if (ra !== rb) return ra - rb;
  const na = Number(a), nb = Number(b);
  if (ra === 0) return nb - na;
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

export function groupHeadRow(code, groupRows) {
  const tr = el("tr", "group-head" + (state.collapsed.has(code) ? " collapsed" : ""));
  const td = el("td");
  td.colSpan = 8;
  const btn = el("button", "group-head-btn");
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(!state.collapsed.has(code)));
  btn.appendChild(el("span", "caret", "▾"));
  btn.appendChild(el("span", "code" + (groupRank(code) === 0 ? " error" : ""), code));
  const latest = groupRows[0] ? ` · latest ${timeText(Math.max(...groupRows.map((row) => row.started_epoch_ms || 0)))}` : "";
  btn.appendChild(el("span", "n", `${groupRows.length} rows${latest}`));
  btn.addEventListener("click", () => {
    state.collapsed.has(code) ? state.collapsed.delete(code) : state.collapsed.add(code);
    renderRequests();
  });
  td.appendChild(btn);
  tr.appendChild(td);
  return tr;
}

export function numberCell(value) {
  return el("td", "num", Number(value || 0).toLocaleString());
}

export function detailGrid(row) {
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
export function checkCell(row) {
  const td = el("td", "col-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = state.selection.has(row.request_key);
  input.setAttribute("aria-label", `Select row ${timeText(row.started_epoch_ms)} ${statusText(row)} ${metaValue(row, "model")}`);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    input.checked ? state.selection.add(row.request_key) : state.selection.delete(row.request_key);
    hooks.renderSelection();
  });
  td.appendChild(input);
  return td;
}

export function requestRow(row) {
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
  return tr;
}

export function renderPortTabs() {
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
      hooks.loadRecords();
    });
    return btn;
  }));
}


// Per-tab Excel-style column resizing with localStorage persistence so
// each tab keeps its own widths across reloads.
const TABLE_WIDTH_PREFIX = "v3-admin-webui-requests-table";
export function loadTableWidths(tab) {
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
export function applyTableWidths(table, widths) {
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
export function attachColumnResizers(table, tab) {
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
export const ENTRY_COLUMNS = [
  { key: "__check", label: "", colClass: "col-check", width: 36 },
  { key: "started_epoch_ms", label: "Time", colClass: "col-time", width: 78 },
  { key: "scope.port", label: "Port", colClass: "col-port", width: 64 },
  { key: "result", label: "Status", colClass: "col-code", width: 78 },
  { key: "meta.provider", label: "Provider · Key", colClass: "col-model", width: 220 },
  { key: "meta.pool", label: "Pool", colClass: "col-pool", width: 110 },
  { key: "usage_total_tokens", label: "Usage", colClass: "col-usage", width: 160 },
  { key: "duration_ms", label: "Duration", colClass: "col-dur", width: 84 },
];

// Request detail drawer, the tab-dispatch renderer, and the per-tab column
// width persistence these share.

export function openRequestDetail(row) {
  state.selected = row;
  renderRequestDetail();
  openPanel();
}

export function renderRequestDetail() {
  const row = state.selected;
  const body = document.getElementById("drawer-body");
  if (!row) {
    document.getElementById("drawer-title").textContent = "Details";
    body.replaceChildren();
    return;
  }
  document.getElementById("drawer-title").textContent = `Request ${row.meta?.request_id || row.request_key}`;
  body.replaceChildren(detailGrid(row));
}

export function renderRequests() {
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
  hooks.renderSelection();
}

// Persist per-tab column widths once each table is rendered.
export function wireTableResizers(panel, tab) {
  const table = panel ? panel.querySelector("table.request-table") : null;
  if (!table) return;
  const widths = state.tableWidths[tab] || loadTableWidths(tab);
  if (widths) state.tableWidths[tab] = widths;
  applyTableWidths(table, widths);
  attachColumnResizers(table, tab);
}

export function syncEntriesSubTabs() {
  const bar = document.getElementById("entries-sub-tab-bar");
  if (!bar) return;
  const active = (state.entriesGroup || "pool") === "reason" ? "reason" : "pool";
  bar.querySelectorAll(".sub-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subTab === active);
  });
}
