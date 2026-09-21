// RCC V3 Admin WebUI — Usage (Requests) selection and export.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/usage-export.js)
//
// Selecting rows and turning the current selection into CSV / TSV. An export
// always reflects the selected rows among the records currently loaded, never
// the whole result set the server could return.

import { fmtCompact, fmtMs, showStatus, timeText } from "../core.js";
import { state } from "./usage-state.js";
import { endpointLabel, statusText } from "./usage-panels.js";

export const CSV_HEAD = ["time", "port", "status", "endpoint", "provider", "model", "key", "pool", "input", "output", "duration", "request_id", "error_detail"];

export function selectedRows() {
  return state.exports;
}

export function exportFields(row) {
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

export function toTSV(rows) {
  return [CSV_HEAD.join("\t"), ...rows.map((row) => exportFields(row).join("\t"))].join("\n");
}

export function toCSV(rows) {
  const esc = (value) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [CSV_HEAD.join(","), ...rows.map((row) => exportFields(row).map(esc).join(","))].join("\n");
}

export function renderSelection() {
  const bar = document.getElementById("selection-bar");
  state.exports = state.records.filter((row) => state.selection.has(row.request_key));
  // The bar reflects what an export would actually contain: the selected
  // rows among the currently loaded records.
  bar.classList.toggle("show", state.exports.length > 0);
  document.getElementById("sel-count").textContent = String(state.exports.length);
  const has = state.exports.length > 0;
  for (const id of ["export-csv-top", "copy-tsv-top"]) document.getElementById(id).disabled = !has;
}

export async function copyTSV() {
  const rows = selectedRows();
  if (!rows.length) return;
  try {
    await navigator.clipboard.writeText(toTSV(rows));
    showStatus("ok", `Copied ${rows.length} rows to clipboard (TSV, includes request_id / error_detail).`);
  } catch (error) {
    showStatus("err", "Clipboard unavailable (browser permission denied).");
  }
}

export function exportCSV() {
  const rows = selectedRows();
  if (!rows.length) return;
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rcc-requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showStatus("ok", `Exported ${rows.length} rows to CSV.`);
}
