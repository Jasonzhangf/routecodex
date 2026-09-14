// RCC V3 Admin WebUI — Providers view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/providers.js)

import { api, el, badge, fmtMs, showStatus, startAutoRefresh } from "../core.js";
import { openPanel, wireDrawer } from "../drawer.js";
import { renderDonut } from "../charts.js";
import { initShell } from "../shell.js";

wireDrawer();
initShell("providers", {
  title: "Providers",
  subtitle: "Provider inventory, health and route references",
});

async function load() {
  try {
    const [providers, overview] = await Promise.all([api("/api/providers"), api("/api/overview")]);
    renderSummary(providers, overview);
    renderList(providers);
  } catch (error) {
    showStatus("err", `providers failed: ${error.message}`);
  }
}

function renderSummary(providers, overview) {
  const cards = document.getElementById("summary-cards");
  cards.innerHTML = "";
  const healthy = providers.filter((provider) => provider.health && provider.health.ok).length;
  const warning = providers.filter((provider) => provider.health && !provider.health.ok).length;
  const untested = providers.length - healthy - warning;
  const cardsData = [
    ["Total", providers.length, `${overview.providers.enabled} enabled`, "ok"],
    ["Healthy", healthy, "health-tested ok", healthy === providers.length && providers.length > 0 ? "ok" : "warn"],
    ["Warning", warning, "failed health test", warning > 0 ? "bad" : "ok"],
    ["Untested", untested, "run health test per provider", "neutral"],
    ["Requests (total)", overview.traffic.total_requests.toLocaleString(), `daily ${overview.traffic.daily_requests.toLocaleString()}`, "ok"],
  ];
  for (const [label, value, hint, kind] of cardsData) {
    const card = el("div", "card");
    card.appendChild(el("div", "label", label));
    card.appendChild(el("div", `value ${kind}`, value));
    card.appendChild(el("div", "hint", hint));
    cards.appendChild(card);
  }
  const donutHost = document.getElementById("health-donut");
  if (donutHost) {
    renderDonut(donutHost, [
      ["healthy", healthy],
      ["warning", warning],
      ["untested", untested],
    ], "health");
  }
}

function renderList(providers) {
  const panel = document.getElementById("providers-panel");
  panel.innerHTML = "";
  if (!providers.length) {
    panel.appendChild(el("div", "loading", "no providers configured — run `rccv3 init`"));
    return;
  }
  const table = el("table");
  const head = el("thead");
  const headRow = el("tr");
  for (const label of ["Provider", "Type", "Endpoint", "Status", "Latency", "Models", "Action"]) {
    headRow.appendChild(el("th", null, label));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  for (const provider of providers) {
    const row = el("tr");
    row.appendChild(el("td", null, provider.id));
    row.appendChild(el("td", "mono", provider.provider_type));
    row.appendChild(el("td", "mono", provider.base_url));
    const statusCell = el("td");
    statusCell.appendChild(badge(provider.health ? (provider.health.ok ? "healthy" : "failed") : "disabled"));
    row.appendChild(statusCell);
    row.appendChild(el("td", "num", provider.health ? fmtMs(provider.health.latency_ms) : "—"));
    row.appendChild(el("td", "num", String(provider.models_count)));
    const actionCell = el("td");
    const testBtn = el("button", "btn", "Health test");
    testBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      testBtn.disabled = true;
      try {
        const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/health-test`, { method: "POST" });
        showStatus(result.ok ? "ok" : "err", `${provider.id}: ${result.ok ? `ok in ${fmtMs(result.latency_ms)}` : `failed (${result.error})`}`);
        load();
      } catch (error) {
        showStatus("err", error.message);
      } finally {
        testBtn.disabled = false;
      }
    });
    const detailBtn = el("button", "btn", "Detail");
    detailBtn.addEventListener("click", () => openDetail(provider.id));
    actionCell.appendChild(testBtn);
    actionCell.appendChild(detailBtn);
    row.appendChild(actionCell);
    body.appendChild(row);
  }
  table.appendChild(body);
  panel.appendChild(table);
}

function detailField(label, value) {
  const wrapper = el("div", "field");
  wrapper.appendChild(el("label", null, label));
  wrapper.appendChild(el("span", "v", value));
  return wrapper;
}

async function openDetail(id) {
  try {
    const detail = await api(`/api/providers/${encodeURIComponent(id)}`);
    document.getElementById("drawer-title").textContent = `Provider ${id}`;
    const body = document.getElementById("drawer-body");
    body.innerHTML = "";
    const config = detail.config;
    const grid = el("div", "detail-grid");
    grid.appendChild(detailField("Name", config.provider_id || config.provider.id));
    grid.appendChild(detailField("Type", config.provider.provider_type));
    grid.appendChild(detailField("Endpoint", config.provider.base_url));
    grid.appendChild(detailField("Default model", config.provider.default_model));
    grid.appendChild(detailField("Enabled", String(config.provider.enabled !== false)));
    grid.appendChild(detailField("Timeout (ms)", config.provider.timeout === null || config.provider.timeout === undefined ? "default 300000" : String(config.provider.timeout)));
    body.appendChild(grid);
    body.appendChild(el("div", "section"));
    body.appendChild(el("h2", null, "Health"));
    const healthPanel = el("div", "panel");
    const healthRow = el("div", "row");
    healthRow.appendChild(el("span", "name", "Last test"));
    if (detail.health) {
      healthRow.appendChild(badge(detail.health.ok ? "healthy" : "failed"));
      healthRow.appendChild(el("span", "meta", `${fmtMs(detail.health.latency_ms)} · ${detail.health.error || "ok"}`));
    } else {
      healthRow.appendChild(badge("disabled"));
      healthRow.appendChild(el("span", "meta", "not tested yet"));
    }
    const testBtn = el("button", "btn", "Run health test");
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      try {
        const result = await api(`/api/providers/${encodeURIComponent(id)}/health-test`, { method: "POST" });
        showStatus(result.ok ? "ok" : "err", `${id}: ${result.ok ? `ok in ${fmtMs(result.latency_ms)}` : `failed (${result.error})`}`);
        openDetail(id);
      } catch (error) {
        showStatus("err", error.message);
        testBtn.disabled = false;
      }
    });
    healthPanel.appendChild(healthRow);
    healthPanel.appendChild(testBtn);
    body.appendChild(healthPanel);
    body.appendChild(el("div", "section"));
    body.appendChild(el("h2", null, "Reference"));
    const refPanel = el("div", "panel");
    if (detail.references.length === 0 && detail.forwarder_references.length === 0) {
      refPanel.appendChild(el("div", "loading", "not referenced by any route"));
    }
    for (const ref of detail.references) {
      const row = el("div", "row");
      row.appendChild(el("span", "name", `${ref.group} / ${ref.pool}`));
      row.appendChild(el("span", "meta", `port ${ref.port} · tier ${ref.priority} · ${ref.model || ""}`));
      refPanel.appendChild(row);
    }
    for (const name of detail.forwarder_references) {
      const row = el("div", "row");
      row.appendChild(el("span", "name", `forwarder ${name}`));
      row.appendChild(el("span", "meta", "forwarder target"));
      refPanel.appendChild(row);
    }
    body.appendChild(refPanel);
    body.appendChild(el("div", "section"));
    body.appendChild(el("h2", null, "Models"));
    const modelsPanel = el("div", "panel");
    for (const [modelName, model] of Object.entries(config.provider.models)) {
      const row = el("div", "row");
      row.appendChild(el("span", "name mono", modelName));
      row.appendChild(el("span", "meta", (model.capabilities || []).join(", ")));
      modelsPanel.appendChild(row);
    }
    body.appendChild(modelsPanel);
    openPanel();
  } catch (error) {
    showStatus("err", error.message);
  }
}

document.getElementById("refresh-btn")?.addEventListener("click", load);
startAutoRefresh(load);
load();
