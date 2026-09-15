// RCC V3 Admin WebUI — Usage (Requests) Entries / Attempts / Errors panels.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-panel-views.js)
//
// The three drill-down panels. They consume the row/cell renderers and the
// column-sizing helpers from usage-panels.js, which does not import back, so the
// dependency stays one-way.

import { el, fmtMs, timeText } from "../core.js";
import { state, hooks } from "./usage-state.js";
import { renderRail, drilldownErrorStatus } from "./usage-filters.js";
import {
  requestRow, groupHeadRow, statusText, metaValue, compareCodes,
  renderPortTabs, loadTableWidths, applyTableWidths, attachColumnResizers,
  ENTRY_COLUMNS, openRequestDetail,
} from "./usage-panels.js";

export function renderEntriesPanel(panel) {
  const rows = state.records;
  const fragments = [];
  if (state.errorStatusCode) {
    const banner = el("div", "status-bar info", `Filtered by error status ${state.errorStatusCode}. `);
    const clear = el("button", "btn", "Clear filter");
    clear.addEventListener("click", () => {
      state.errorStatusCode = null;
      state.page = 1;
      hooks.loadRecords();
    });
    banner.appendChild(clear);
    fragments.push(banner);
  }
  if (!rows.length) {
    // Distinguish "the filters excluded everything" from "this range has no
    // records at all"; the second case is not a filter problem and telling the
    // user to clear filters there sends them in the wrong direction.
    const layered = state.statusInclude != null || state.providerInclude != null
      || state.modelInclude != null || state.errorCodeInclude != null;
    const filtered = layered || state.search || state.port !== "all" || state.errorStatusCode;
    const empty = el("div", "empty-state");
    empty.appendChild(el("h2", null, filtered ? "No matching requests" : "No requests recorded yet"));
    const hint = el("p", null, filtered
      ? "Adjust your search terms, or re-check the boxes you unchecked in the left rail."
      : "Nothing has been recorded for the selected range. Widen the Range control above, or send traffic through the proxy and refresh.");
    if (filtered) {
      const reset = el("button", "btn", "Clear all filters");
      reset.addEventListener("click", () => {
        state.statusInclude = null;
        state.providerInclude = null;
        state.modelInclude = null;
        state.errorCodeInclude = null;
        state.search = "";
        state.port = "all";
        state.errorStatusCode = null;
        const searchInput = document.getElementById("search-filter");
        if (searchInput) searchInput.value = "";
        const portFilter = document.getElementById("port-filter");
        if (portFilter) portFilter.value = "all";
        state.page = 1;
        renderRail();
        renderPortTabs();
        hooks.loadRecords();
      });
      hint.appendChild(document.createTextNode(" "));
      hint.appendChild(reset);
    }
    empty.appendChild(hint);
    fragments.push(empty);
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
        hooks.renderSelection();
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
      if (state.collapsed.has(code)) continue;
      for (const row of groupRows) body.appendChild(requestRow(row));
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

export function renderAttemptsPanel(panel) {
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
    body.appendChild(tr);
  });
  table.appendChild(body);
  panel.replaceChildren(table);
  state.tableWidths.attempts = loadTableWidths("attempts");
  applyTableWidths(table, state.tableWidths.attempts);
  attachColumnResizers(table, "attempts");
}

export function renderErrorsPanel(panel) {
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
