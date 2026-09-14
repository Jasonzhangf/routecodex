// RCC V3 Admin WebUI — Dashboard view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/dashboard.js)

import { api, el, badge, showStatus, startAutoRefresh } from "../core.js";
import { openPanel, wireDrawer } from "../drawer.js";
import { renderDonut } from "../charts.js";
import { initShell } from "../shell.js";

wireDrawer();
initShell("dashboard", {
  title: "Dashboard",
  subtitle: "Runtime status, ports, providers and traffic overview",
});

async function load() {
  try {
    const data = await api("/api/overview");
    renderSummary(data);
    renderPorts(data);
    renderTraffic(data);
    renderRevisions(data);
  } catch (error) {
    showStatus("err", `overview failed: ${error.message}`);
  }
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
      grid.appendChild(dashboardField(`${port.server_id} :${port.port}`, `${port.healthy ? "healthy" : "down"} · http ${port.http_status || "unreachable"} · ${port.endpoints.join(", ")}`));
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
  } else if (label === "Provider errors") {
    grid.appendChild(dashboardField("Errors", data.traffic.persisted_provider_errors.toLocaleString()));
    for (const [target, count] of Object.entries(data.traffic.route_targets || {}).sort(([, a], [, b]) => b - a)) {
      grid.appendChild(dashboardField(target, count.toLocaleString()));
    }
  } else if (label === "Revisions") {
    for (const rev of data.revisions.slice(0, 10)) {
      grid.appendChild(dashboardField(`#${rev.seq}`, `${rev.action} — ${rev.reason}`));
    }
  }
  body.appendChild(grid);
  openPanel();
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
    row.appendChild(name);
    row.appendChild(badge(port.healthy ? "healthy" : "down"));
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
