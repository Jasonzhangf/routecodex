// RCC V3 Admin WebUI — Usage (Requests) summary rendering.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-summary.js)
//
// The per-port and per-status tables, the facet selects, and the summary cards
// with the status donut.

import { el, fmtCompact } from "../core.js";
import { renderDonut } from "../charts.js";
import { state } from "./usage-state.js";
import { drilldownErrorStatus } from "./usage-filters.js";
import { numberCell } from "./usage-panels.js";

export function populateFacetSelect(id, facet, allLabel = "all") {
  const select = document.getElementById(id);
  if (!select) return;
  const selected = select.value;
  const all = el("option", null, allLabel);
  all.value = "all";
  select.replaceChildren(all, ...Object.entries(facet || {}).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([value]) => {
    const option = el("option", null, String(value));
    option.value = String(value);
    return option;
  }));
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "all";
}

export function renderStats(stats) {
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
  portSelect.replaceChildren(allPorts, ...Object.entries(state.facets.ports || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([port]) => {
    const option = el("option", null, String(port)); option.value = String(port); return option;
  }));
  portSelect.value = [...portSelect.options].some((option) => option.value === selectedPort) ? selectedPort : "all";
  populateFacetSelect("protocol-filter", state.facets.response_types || {});
  populateFacetSelect("provider-filter", state.facets.providers || {}, "all providers");
  populateFacetSelect("model-filter", state.facets.models || {}, "all models");
  populateFacetSelect("endpoint-filter", state.facets.endpoints || {}, "all endpoints");
}

export function renderStatsCards() {
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
