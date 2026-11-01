// RCC V3 Admin WebUI — Dashboard view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/dashboard.js)

import { api, el, badge, showStatus, startAutoRefresh, timeText } from "../core.js";
import { openPanel, wireDrawer } from "../drawer.js";
import { renderDonut } from "../charts.js";
import { initShell } from "../shell.js";

wireDrawer();
initShell("dashboard", {
  title: "Dashboard",
  subtitle: "Runtime status, ports, providers and traffic overview",
});

// `/api/overview` is the traffic/port summary; `/api/environment` carries the
// per-listener /health projection including build_version.
const state = { overview: null, environment: null, environmentError: null };

async function load() {
  await Promise.all([loadOverview(), loadEnvironment()]);
  renderDashboard();
}

async function loadOverview() {
  try {
    state.overview = await api("/api/overview");
  } catch (error) {
    showStatus("err", `overview failed: ${error.message}`);
  }
}

async function loadEnvironment() {
  try {
    state.environment = await api("/api/environment");
    state.environmentError = null;
  } catch (error) {
    state.environment = null;
    state.environmentError = error.message;
  }
}

function renderDashboard() {
  const data = state.overview;
  if (!data) return;
  renderSummary(data);
  renderPorts(data);
  renderTraffic(data);
  renderRevisions(data);
}

function listenerFor(port) {
  const listeners = Array.isArray(state.environment?.listeners) ? state.environment.listeners : [];
  return listeners.find((item) => item.port === port) || null;
}

/** build_version comes from the listener /health probe; absent is rendered as unknown, never guessed. */
function buildVersionText(port) {
  if (state.environmentError) return `unknown (environment unavailable: ${state.environmentError})`;
  if (!state.environment) return "unknown (environment not loaded)";
  const listener = listenerFor(port);
  if (!listener) return "unknown (no /health projection for this port)";
  if (!listener.reachable) {
    return `unknown (listener unreachable: ${listener.error || `http ${listener.http_status ?? "?"}`})`;
  }
  return listener.build_version || "unknown (listener /health did not report build_version)";
}

/** Install/run drift: listener build_version vs the installed binary version. */
function buildDrift(port) {
  if (state.environmentError || !state.environment) return { kind: "neutral", label: "build drift unknown" };
  const listener = listenerFor(port);
  if (!listener || !listener.reachable || !listener.build_version) {
    return { kind: "neutral", label: "build drift unknown" };
  }
  const installed = state.environment.binary?.version ?? null;
  if (!installed) return { kind: "warn", label: "installed version unknown" };
  return listener.build_version === installed
    ? { kind: "ok", label: "build matches installed binary" }
    : { kind: "bad", label: `build drift vs installed ${installed}` };
}

function renderSummary(data) {
  const cards = document.getElementById("summary-cards");
  cards.innerHTML = "";
  const runtime = data.runtime.managed_instance;
  const runtimeState = runtime && runtime.state ? runtime.state : "unknown";
  const healthyPorts = data.runtime.ports.filter((port) => port.healthy).length;
  // Color is reserved for error states only.
  const cardsData = [
    ["Runtime", runtimeState, runtime ? runtime.instance_id : "no instance", ""],
    ["Ports", `${healthyPorts} / ${data.runtime.ports.length}`, "healthy / total", ""],
    ["Providers", data.providers.total, `${data.providers.enabled} enabled · ${data.providers.disabled} disabled`, ""],
    ["Requests (total)", data.traffic.total_requests.toLocaleString(), `daily ${data.traffic.daily_requests.toLocaleString()}`, ""],
    ["Provider errors", data.traffic.persisted_provider_errors.toLocaleString(), "", data.traffic.persisted_provider_errors > 0 ? "bad" : ""],
    ["Revisions", data.revisions.length, "", ""],
  ];
  for (const [label, value, hint, kind] of cardsData) {
    const card = el("button", "card");
    card.setAttribute("aria-haspopup", "dialog");
    card.setAttribute("aria-label", `${label} details`);
    card.appendChild(el("div", "label", label));
    card.appendChild(el("div", kind ? `value ${kind}` : "value", value));
    if (hint) card.appendChild(el("div", "hint", hint));
    card.addEventListener("click", () => openDashboardDetail(label, data));
    cards.appendChild(card);
  }
}

function dashboardField(label, value) {
  const wrapper = el("div", "field");
  wrapper.appendChild(el("label", null, label));
  wrapper.appendChild(el("span", "v", String(value ?? "—")));
  return wrapper;
}

function openDashboardDetail(label, data) {
  if (label === "Provider errors") {
    openProviderErrorsDetail(data);
    return;
  }
  const body = document.getElementById("drawer-body");
  document.getElementById("drawer-title").textContent = label;
  body.innerHTML = "";
  const grid = el("div", "detail-grid");
  if (label === "Runtime") {
    const runtime = data.runtime.managed_instance;
    grid.appendChild(dashboardField("State", runtime?.state || "unknown"));
    grid.appendChild(dashboardField("Instance ID", runtime?.instance_id || "—"));
    if (runtime?.updated_at_epoch_ms) {
      grid.appendChild(dashboardField("Updated", new Date(runtime.updated_at_epoch_ms).toLocaleString([], { hour12: false })));
    }
  } else if (label === "Ports") {
    for (const port of data.runtime.ports) {
      const drift = buildDrift(port.port);
      grid.appendChild(dashboardField(
        `${port.server_id} :${port.port}`,
        `${port.healthy ? "healthy" : "down"} · http ${port.http_status || "unreachable"} · ${port.endpoints.join(", ")} · build ${buildVersionText(port.port)} · ${drift.label}`,
      ));
    }
    grid.appendChild(dashboardField("installed binary", state.environment?.binary?.version ?? "unknown"));
    if (state.environmentError) {
      grid.appendChild(dashboardField("environment projection", `unavailable: ${state.environmentError}`));
    }
  } else if (label === "Providers") {
    grid.appendChild(dashboardField("Total", data.providers.total));
    grid.appendChild(dashboardField("Enabled", data.providers.enabled));
    grid.appendChild(dashboardField("Disabled", data.providers.disabled));
  } else if (label === "Requests (total)") {
    grid.appendChild(dashboardField("Total requests", data.traffic.total_requests.toLocaleString()));
    grid.appendChild(dashboardField("Daily requests", data.traffic.daily_requests.toLocaleString()));
    if (data.traffic.last_request_at_epoch_ms) {
      grid.appendChild(dashboardField("Last request", new Date(data.traffic.last_request_at_epoch_ms).toLocaleString([], { hour12: false })));
    }
  } else if (label === "Revisions") {
    for (const rev of data.revisions.slice(0, 10)) {
      grid.appendChild(dashboardField(`#${rev.seq}`, `${rev.action} — ${rev.reason}`));
    }
  }
  body.appendChild(grid);
  openPanel();
}

// The drawer lists real provider error rows from the observability store
// (`status=retrying` is the failed-attempt projection). These are immutable
// attempt history; current cooldown is only readable from the Usage page's
// cooldown pool panel.
function openProviderErrorsDetail(data) {
  const body = document.getElementById("drawer-body");
  document.getElementById("drawer-title").textContent = "Provider errors";
  body.innerHTML = "";
  const grid = el("div", "detail-grid");
  grid.appendChild(dashboardField("Persisted provider errors", Number(data.traffic.persisted_provider_errors || 0).toLocaleString()));
  grid.appendChild(dashboardField("Routed targets (persisted)", Object.keys(data.traffic.route_targets || {}).length));
  const host = el("div");
  host.appendChild(el("div", "loading", "loading provider error rows…"));
  body.append(grid, host);
  openPanel();
  loadProviderErrorRows(host);
}

async function loadProviderErrorRows(host) {
  try {
    const params = new URLSearchParams();
    params.set("status", "retrying");
    params.set("page", "1");
    params.set("page_size", "25");
    params.set("sort_by", "updated_epoch_ms");
    params.set("sort_order", "desc");
    params.set("range", "all");
    const response = await api(`/api/observability/records?${params}`);
    renderProviderErrorRows(host, response);
  } catch (error) {
    host.replaceChildren(el("div", "error-summary", `provider error rows unavailable: ${error.message}`));
  }
}

function renderProviderErrorRows(host, response) {
  const rows = response.records || [];
  const total = Number(response.total || 0);
  if (!rows.length) {
    host.replaceChildren(el("div", "loading", "no provider error rows in the observability store"));
    return;
  }
  const table = el("table", "request-table");
  const head = el("tr");
  for (const label of ["When", "Port", "Provider · Key", "Model", "Status", "Error"]) {
    head.appendChild(el("th", null, label));
  }
  const thead = document.createElement("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "mono", timeText(row.updated_epoch_ms)));
    tr.appendChild(el("td", null, String(row.scope?.port ?? "—")));
    tr.appendChild(el("td", null, `${row.meta?.provider ?? "—"} · ${row.meta?.auth_alias ?? "—"}`));
    tr.appendChild(el("td", null, String(row.meta?.model ?? "—")));
    tr.appendChild(el("td", "mono", String(row.meta?.provider_status ?? row.meta?.error_category ?? "—")));
    tr.appendChild(el("td", "mono", String(row.meta?.error_detail ?? row.meta?.error_category ?? "—")));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.replaceChildren(
    el("div", "muted", `Showing ${rows.length} of ${total.toLocaleString()} provider attempt failures (status=retrying). Immutable attempt history — current cooldown lives in the Usage page cooldown panel.`),
    table,
  );
}

function renderPorts(data) {
  const panel = document.getElementById("ports-panel");
  panel.innerHTML = "";
  if (!data.runtime.ports.length) {
    panel.appendChild(el("div", "loading", "no ports configured"));
    return;
  }
  for (const port of data.runtime.ports) {
    const row = el("div", "row");
    const name = el("div", "name", `${port.server_id}`);
    name.appendChild(el("div", "meta", `127.0.0.1:${port.port} · ${port.endpoints.join(", ")}`));
    name.appendChild(el("div", "meta mono", `build ${buildVersionText(port.port)}`));
    row.appendChild(name);
    row.appendChild(badge(port.healthy ? "healthy" : "down"));
    const drift = buildDrift(port.port);
    row.appendChild(el("span", `badge ${drift.kind}`, drift.label));
    if (!port.healthy) row.appendChild(el("span", "meta", `http ${port.http_status || "unreachable"}`));
    panel.appendChild(row);
  }
}

function renderTraffic(data) {
  const targets = data.traffic.route_targets;
  const entries = Object.entries(targets).sort((a, b) => b[1] - a[1]);
  const panel = document.getElementById("traffic-panel");
  panel.innerHTML = "";
  if (!entries.length) {
    panel.appendChild(el("div", "loading", "no routed records in persisted store"));
    return;
  }
  const max = entries[0][1];
  for (const [target, count] of entries) {
    const row = el("div", "row");
    const name = el("div", "name", target);
    name.appendChild(el("div", "meta", `${count.toLocaleString()} requests`));
    row.appendChild(name);
    const meter = el("div", "traffic-meter");
    const fill = el("span");
    fill.style.width = `${Math.max(4, Math.round((count / max) * 100))}%`;
    meter.appendChild(fill);
    row.appendChild(meter);
    panel.appendChild(row);
  }
  const donutHost = document.getElementById("traffic-donut");
  if (donutHost) renderDonut(donutHost, entries, "routes");
}

function renderRevisions(data) {
  const panel = document.getElementById("revisions-panel");
  panel.innerHTML = "";
  if (!data.revisions.length) {
    panel.appendChild(el("div", "loading", "no revisions yet"));
    return;
  }
  const list = el("div", "rev-list");
  for (const rev of data.revisions) {
    const row = el("div", "rev");
    row.appendChild(el("span", "seq", `#${rev.seq}`));
    row.appendChild(el("span", "ts", rev.ts));
    row.appendChild(el("span", null, `${rev.action} — ${rev.reason}`));
    list.appendChild(row);
  }
  panel.appendChild(list);
}

document.getElementById("refresh-btn").addEventListener("click", load);
startAutoRefresh(load);
load();
