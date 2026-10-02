// RCC V3 Admin WebUI — Providers view.
// Provider inventory, onboarding wizard (credentials → discover → validate → probe →
// commit → optional route wiring), streaming probe terminal, patrol plan editor and
// bulk import with partial success. Zero-build ES module: no bundler, no npm deps.
// feature_id: v3.admin_provider_onboarding (v3/admin-webui/app/views/providers.js)

import { api, badge, el, fmtMs, showStatus, startAutoRefresh } from "../core.js";
import { openPanel, wireDrawer } from "../drawer.js";
import { renderDonut } from "../charts.js";
import { initShell, requireAdminSession } from "../shell.js";
import { confirmDialog, createDirtyGuard, createField, createForm, validators } from "../form.js";
import { PROBE_STAGES, createProbeTerminal, probeStageLabel } from "../probe.js";
import { describeApiError, renderModelsSection } from "./provider-models.js";

wireDrawer();
initShell("providers", {
  title: "Providers",
  subtitle: "Provider inventory, onboarding, probes and patrol",
});

const WIZARD_STEPS = [
  { id: "credentials", label: "1 Credentials" },
  { id: "discover", label: "2 Discover models" },
  { id: "validate", label: "3 Validate" },
  { id: "probe", label: "4 Probe" },
  { id: "commit", label: "5 Commit" },
  { id: "route", label: "6 Wire route (optional)" },
];

const PROVIDER_TYPES = [
  { value: "openai_chat", label: "openai_chat (OpenAI-compatible chat)" },
  { value: "responses", label: "responses (OpenAI Responses API)" },
  { value: "anthropic", label: "anthropic (Messages API)" },
  { value: "gemini", label: "gemini (generateContent)" },
];

const state = {
  providers: [],
  overview: null,
  routes: null,
  wizardStep: 0,
  patrolProvider: null,
  importText: "",
  // Bulk-action selection over the provider list. Kept here so it survives the
  // auto-refresh re-render; pruned whenever a provider disappears from the list.
  selectedProviders: new Set(),
};

/** Raw request helper for endpoints whose error bodies carry structured detail. */
async function apiRaw(path, options = {}) {
  const token = await requireAdminSession();
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-routecodex-admin-token": token,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

async function load() {
  try {
    const [providers, overview] = await Promise.all([api("/api/providers"), api("/api/overview")]);
    state.providers = providers;
    state.overview = overview;
    renderSummary(providers, overview);
    renderList(providers);
    renderPatrolProviderOptions();
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
    ["Untested", untested, "run an ad-hoc diagnostic per provider", "neutral"],
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
  // A provider that vanished from the list (deleted here or elsewhere) cannot
  // stay selected, or a later bulk action would target a stale id.
  for (const id of [...state.selectedProviders]) {
    if (!providers.some((provider) => provider.id === id)) state.selectedProviders.delete(id);
  }
  if (!providers.length) {
    panel.appendChild(el("div", "loading", "no providers configured — add one or run `rccv3 init`"));
    renderProviderBulkBar();
    return;
  }
  const table = el("table");
  const head = el("thead");
  const headRow = el("tr");
  const checkHead = el("th", "col-check");
  const selectAll = el("input");
  selectAll.type = "checkbox";
  selectAll.id = "providers-select-all";
  selectAll.setAttribute("aria-label", "Select all providers");
  checkHead.appendChild(selectAll);
  headRow.appendChild(checkHead);
  for (const label of ["Provider", "Type", "Endpoint", "Status", "Latency", "Models", "Actions"]) {
    headRow.appendChild(el("th", null, label));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  for (const provider of providers) {
    const row = el("tr");
    const checkCell = el("td", "col-check");
    const box = el("input");
    box.type = "checkbox";
    box.dataset.providerId = provider.id;
    box.checked = state.selectedProviders.has(provider.id);
    box.setAttribute("aria-label", `Select provider ${provider.id}`);
    checkCell.appendChild(box);
    row.appendChild(checkCell);
    box.addEventListener("change", () => {
      if (box.checked) state.selectedProviders.add(provider.id);
      else state.selectedProviders.delete(provider.id);
      renderProviderBulkBar();
    });
    row.appendChild(el("td", null, provider.id));
    row.appendChild(el("td", "mono", provider.provider_type));
    row.appendChild(el("td", "mono", provider.base_url));
    const statusCell = el("td");
    statusCell.appendChild(badge(provider.health ? (provider.health.ok ? "healthy" : "failed") : "disabled"));
    row.appendChild(statusCell);
    row.appendChild(el("td", "num", provider.health ? fmtMs(provider.health.latency_ms) : "—"));
    row.appendChild(el("td", "num", String(provider.models_count)));
    const actionCell = el("td");
    actionCell.appendChild(actionButton("Detail", () => openDetail(provider.id)));
    actionCell.appendChild(actionButton("Probe", () => openProbeFor(provider.id)));
    actionCell.appendChild(actionButton("Patrol", () => selectPatrolProvider(provider.id)));
    actionCell.appendChild(actionButton("Delete", () => deleteProvider(provider.id)));
    row.appendChild(actionCell);
    body.appendChild(row);
  }
  table.appendChild(body);
  panel.appendChild(table);

  const visibleIds = providers.map((provider) => provider.id);
  selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selectedProviders.has(id));
  selectAll.addEventListener("change", () => {
    for (const id of visibleIds) {
      if (selectAll.checked) state.selectedProviders.add(id);
      else state.selectedProviders.delete(id);
    }
    renderList(state.providers);
  });

  renderProviderBulkBar();
}

// ---------------------------------------------------------------------------
// provider list bulk actions (E7) and bulk route binding (E8)
// ---------------------------------------------------------------------------

function bulkButton(label, handler) {
  const button = el("button", "btn", label);
  button.addEventListener("click", handler);
  return button;
}

function selectedProviderIds() {
  return state.providers.filter((provider) => state.selectedProviders.has(provider.id)).map((provider) => provider.id);
}

/** Route targets come from the same `GET /api/routes` truth the routes view edits. */
function routeTargets() {
  const targets = [];
  for (const server of state.routes?.servers || []) {
    (server.pools || []).forEach((pool, poolIndex) => {
      const poolLabel = pool.id || pool.name || `pool ${poolIndex + 1}`;
      (pool.tiers || []).forEach((tier, tierIndex) => {
        targets.push({
          value: `${server.server_id}\u0000${poolIndex}\u0000${tierIndex}`,
          label: `${server.server_id || "server"} · ${poolLabel} · tier ${tierIndex + 1}`,
        });
      });
    });
  }
  return targets;
}

function renderProviderBulkBar() {
  const bar = document.getElementById("providers-bulk-bar");
  if (!bar) return;
  const ids = selectedProviderIds();
  bar.textContent = "";
  bar.hidden = ids.length === 0;
  if (!ids.length) return;

  bar.appendChild(el("span", "bulk-count", `${ids.length} selected`));
  bar.appendChild(bulkButton("Enable", () => setProvidersEnabled(ids, true)));
  bar.appendChild(bulkButton("Disable", () => setProvidersEnabled(ids, false)));
  bar.appendChild(bulkButton("Probe", () => probeProviders(ids)));
  bar.appendChild(bulkButton(`Delete ${ids.length}`, () => deleteProviders(ids)));

  const select = el("select", "bulk-route-target");
  select.id = "bulk-route-target";
  select.setAttribute("aria-label", "Route pool tier for bulk binding");
  const placeholder = el("option", null, "Route target…");
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const target of routeTargets()) {
    const option = el("option", null, target.label);
    option.value = target.value;
    select.appendChild(option);
  }
  bar.appendChild(select);

  const bindBtn = bulkButton("Bind to route", () => bindProvidersToRoute(ids, select.value));
  // Binding must not guess a target, so the action stays disabled until one is chosen.
  bindBtn.disabled = true;
  select.addEventListener("change", () => {
    bindBtn.disabled = !select.value;
  });
  bar.appendChild(bindBtn);

  const status = el("span", "hint bulk-status");
  status.id = "bulk-status";
  bar.appendChild(status);
}

async function setProvidersEnabled(ids, enabled) {
  const status = document.getElementById("bulk-status");
  const failures = [];
  let applied = 0;
  for (const id of ids) {
    try {
      const detail = await api(`/api/providers/${encodeURIComponent(id)}`);
      const config = detail.config;
      config.provider.enabled = enabled;
      await api(`/api/providers/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ config, reason: `webui bulk ${enabled ? "enable" : "disable"}` }),
      });
      applied += 1;
    } catch (error) {
      failures.push(`${id}: ${describeApiError(error)}`);
    }
  }
  const message = `${applied}/${ids.length} ${enabled ? "enabled" : "disabled"}${failures.length ? ` · ${failures.join(" · ")}` : ""}`;
  if (status) status.textContent = message;
  showStatus(failures.length ? "warn" : "ok", `bulk ${enabled ? "enable" : "disable"}: ${message}`);
  load();
}

/** Bulk probe runs the single existing probe ladder, one provider at a time. */
async function probeProviders(ids) {
  const panel = document.getElementById("probe-panel");
  if (!panel) return;
  panel.hidden = false;
  const host = document.getElementById("probe-host");
  const target = document.getElementById("probe-target");
  host.textContent = "";
  for (const [index, id] of ids.entries()) {
    if (target) target.textContent = `bulk probe ${index + 1}/${ids.length} · provider ${id}`;
    const terminal = createProbeTerminal();
    host.appendChild(terminal.element);
    await terminal.run({ id, model: null, stages: PROBE_STAGES });
  }
  if (target) target.textContent = `bulk probe complete for ${ids.length} provider(s)`;
}

/**
 * E7: bulk delete is destructive, so it is confirmed first and the confirmation
 * names the count. It reuses the shared `confirmDialog` primitive and the
 * existing per-provider DELETE endpoint (which already refuses referenced
 * providers with 409 and reports the references).
 */
async function deleteProviders(ids) {
  const confirmed = await confirmDialog({
    title: `Delete ${ids.length} provider(s)`,
    message: `This removes ${ids.length} provider director${ids.length === 1 ? "y" : "ies"}: ${ids.join(", ")}. Configs are backed up under state/provider-backups. Providers still referenced by a route are refused.`,
    confirmLabel: `Delete ${ids.length}`,
    danger: true,
  });
  if (!confirmed) {
    showStatus("info", "bulk delete cancelled");
    return;
  }
  await runBulkDelete(ids);
}

async function runBulkDelete(ids) {
  const failures = [];
  let deleted = 0;
  for (const id of ids) {
    const result = await apiRaw(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (result.ok) {
      deleted += 1;
      state.selectedProviders.delete(id);
      continue;
    }
    if (result.status === 409) {
      const references = (result.body?.references || []).map((ref) => `${ref.group}/${ref.pool} (port ${ref.port})`);
      const forwarders = (result.body?.forwarder_references || []).map((name) => `forwarder ${name}`);
      const all = [...references, ...forwarders];
      failures.push(`${id}: still referenced by ${all.length ? all.join(", ") : "route configuration"}`);
      continue;
    }
    failures.push(`${id}: ${result.body?.error_code || "delete failed"} ${result.body?.error || `HTTP ${result.status}`}`);
  }
  showStatus(
    failures.length ? "warn" : "ok",
    `bulk delete: ${deleted}/${ids.length} deleted${failures.length ? ` · ${failures.join(" · ")}` : ""}`,
  );
  load();
}

/**
 * E8: bind the checked providers into an existing route pool tier through
 * `PUT /api/routes`. This writes the same route truth the routes view owns; it
 * never introduces a second routing source. One member per provider, using the
 * provider's default model (falling back to its first authored model).
 */
async function bindProvidersToRoute(ids, target) {
  const status = document.getElementById("bulk-status");
  const [serverId, poolIndexRaw, tierIndexRaw] = String(target || "").split("\u0000");
  let routes;
  try {
    // Route truth is read at action time. The bulk bar's snapshot may be stale,
    // and binding must never write a second, drifting copy of the route config.
    routes = await api("/api/routes");
  } catch (error) {
    showStatus("err", `route config unavailable: ${describeApiError(error)}`);
    return;
  }
  state.routes = routes;
  const server = (routes.servers || []).find((item) => item.server_id === serverId);
  const tier = server?.pools?.[Number(poolIndexRaw)]?.tiers?.[Number(tierIndexRaw)];
  if (!tier) {
    showStatus("err", "route target is no longer available — pick a target again");
    renderProviderBulkBar();
    return;
  }
  const added = [];
  const skipped = [];
  for (const id of ids) {
    try {
      const detail = await api(`/api/providers/${encodeURIComponent(id)}`);
      const models = Object.keys(detail.config?.provider?.models || {});
      const model = detail.config?.provider?.defaultModel || models[0];
      if (!model) {
        skipped.push(`${id} (no model authored)`);
        continue;
      }
      const use = `${id}/${model}`;
      if ((tier.members || []).some((member) => member.use === use)) {
        skipped.push(`${use} (already in tier)`);
        continue;
      }
      tier.members = tier.members || [];
      tier.members.push({ use, weight: null });
      added.push(use);
    } catch (error) {
      skipped.push(`${id} (${describeApiError(error)})`);
    }
  }
  if (!added.length) {
    const message = `nothing bound · ${skipped.join(" · ") || "no providers selected"}`;
    if (status) status.textContent = message;
    showStatus("warn", message);
    return;
  }
  try {
    const result = await api("/api/routes", {
      method: "PUT",
      body: JSON.stringify({
        servers: routes.servers,
        reason: `webui bulk bind ${added.length} provider(s)`,
      }),
    });
    state.routes = { ...routes, servers: result.servers || routes.servers };
    const message = `bound ${added.join(", ")}${skipped.length ? ` · skipped ${skipped.join(" · ")}` : ""}`;
    if (status) status.textContent = message;
    showStatus("ok", `route revision ${result.revision_seq} · ${message}`);
  } catch (error) {
    // The local tier edit was never committed; re-read route truth instead of
    // keeping a mutation the server rejected.
    showStatus("err", `route bind failed: ${describeApiError(error)}`);
    loadRoutes();
  }
}

function actionButton(label, handler) {
  const button = el("button", "btn", label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

// ---------------------------------------------------------------------------
// detail drawer
// ---------------------------------------------------------------------------

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
    // The detail payload carries the provider file as serde serializes it
    // (`type`, `baseURL`, `defaultModel`), unlike the list DTO's snake_case.
    grid.appendChild(detailField("Type", config.provider.type));
    grid.appendChild(detailField("Endpoint", config.provider.baseURL));
    grid.appendChild(detailField("Default model", config.provider.defaultModel));
    grid.appendChild(detailField("Enabled", String(config.provider.enabled !== false)));
    grid.appendChild(detailField("Timeout (ms)", config.provider.timeout === null || config.provider.timeout === undefined ? "default 300000" : String(config.provider.timeout)));
    body.appendChild(grid);

    body.appendChild(el("div", "section"));
    body.appendChild(el("h2", null, "Runtime health (cooldown truth)"));
    const healthPanel = el("div", "panel");
    healthPanel.appendChild(el("div", "loading", "reading runtime cooldown projection…"));
    body.appendChild(healthPanel);
    renderRuntimeHealth(healthPanel, id);

    body.appendChild(el("div", "section"));
    body.appendChild(el("h2", null, "Ad-hoc diagnostic (not provider health)"));
    const diagnosticPanel = el("div", "panel");
    diagnosticPanel.appendChild(el("div", "hint", "One unauthenticated GET {baseURL}/models. It carries no credential, so an authenticated provider is expected to answer 401/403. This result never becomes provider health."));
    const testBtn = el("button", "btn", "Run ad-hoc diagnostic");
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      try {
        const result = await api(`/api/providers/${encodeURIComponent(id)}/health-test`, { method: "POST" });
        showStatus(result.ok ? "ok" : "warn", `${id}: ${result.ok ? `reachable in ${fmtMs(result.latency_ms)}` : `${result.status || "no status"} · ${result.error || "unreachable"}`}`);
      } catch (error) {
        showStatus("err", error.message);
      } finally {
        testBtn.disabled = false;
      }
    });
    diagnosticPanel.appendChild(testBtn);
    body.appendChild(diagnosticPanel);

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
    body.appendChild(modelsPanel);
    // Editable model authoring lives in app/views/provider-models.js (E4/E5/E6).
    renderModelsSection(modelsPanel, {
      providerId: id,
      config,
      // No optimistic state: a write is followed by a fresh provider read.
      onChanged: () => openDetail(id),
    });

    const actions = el("div", "actions");
    actions.appendChild(actionButton("Probe this provider", () => {
      openProbeFor(id);
      openPanel();
    }));
    actions.appendChild(actionButton("Patrol plan", () => {
      selectPatrolProvider(id);
      openPanel();
    }));
    body.appendChild(actions);
    openPanel();
  } catch (error) {
    showStatus("err", error.message);
  }
}

async function renderRuntimeHealth(host, id) {
  try {
    const health = await api(`/api/providers/${encodeURIComponent(id)}/health`);
    host.innerHTML = "";
    const header = el("div", "row");
    header.appendChild(el("span", "name", health.source));
    header.appendChild(badge(health.cooled ? "warning" : "healthy"));
    header.appendChild(el("span", "meta", health.cooled ? "cooled identities present" : "no cooled identity"));
    host.appendChild(header);
    for (const listener of health.listeners) {
      const row = el("div", "row");
      row.appendChild(el("span", "name", `listener ${listener.port}`));
      row.appendChild(el("span", "meta", listener.reachable ? `${listener.entries.length} cooled entr${listener.entries.length === 1 ? "y" : "ies"}` : `unreachable: ${listener.error}`));
      host.appendChild(row);
      for (const entry of listener.entries) {
        const entryRow = el("div", "row");
        entryRow.appendChild(el("span", "name mono", entry.model_id || entry.key || "identity"));
        entryRow.appendChild(el("span", "meta", JSON.stringify(entry)));
        host.appendChild(entryRow);
      }
    }
  } catch (error) {
    host.innerHTML = "";
    host.appendChild(el("div", "loading", `runtime cooldown unavailable: ${error.message}`));
  }
}

async function deleteProvider(id) {
  const confirmed = await confirmDialog({
    title: `Delete provider ${id}`,
    message: "The provider directory is removed and its config is backed up under state/provider-backups. Referenced providers are refused.",
    confirmLabel: "Delete provider",
    danger: true,
  });
  if (!confirmed) return;
  const result = await apiRaw(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result.ok) {
    showStatus("ok", `${id} deleted · backup ${result.body?.backup || "n/a"} · revision ${result.body?.revision_seq}`);
    load();
    return;
  }
  if (result.status === 409) {
    const references = (result.body?.references || []).map((ref) => `${ref.group}/${ref.pool} (port ${ref.port}, tier ${ref.priority})`);
    const forwarders = (result.body?.forwarder_references || []).map((name) => `forwarder ${name}`);
    const all = [...references, ...forwarders];
    showStatus("err", `delete refused: ${id} is still referenced by ${all.length ? all.join(", ") : "route configuration"}`);
    return;
  }
  showStatus("err", `delete failed: ${result.body?.error || result.status}`);
}

// ---------------------------------------------------------------------------
// onboarding wizard
// ---------------------------------------------------------------------------

function splitList(text) {
  return String(text || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHeaderLines(text) {
  const headers = {};
  const invalid = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) {
      invalid.push(trimmed);
      continue;
    }
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return { headers, invalid };
}

/** Suggest a provider protocol from the endpoint/model text. The user confirms it; the
 *  backend compile chain remains the authority. */
function inferProviderType(baseUrl, model) {
  const text = `${baseUrl} ${model}`.toLowerCase();
  if (text.includes("anthropic") || text.includes("claude")) return "anthropic";
  if (text.includes("generativelanguage") || text.includes("gemini")) return "gemini";
  if (text.includes("/responses")) return "responses";
  return "openai_chat";
}

function candidateFromValues(values) {
  const id = String(values.provider_id || "").trim();
  const defaultModel = String(values.default_model || "").trim();
  const models = splitList(values.models);
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  const { headers, invalid } = parseHeaderLines(values.headers);
  const modelMap = {};
  for (const model of models) modelMap[model] = { supportsStreaming: true };
  return {
    invalidHeaders: invalid,
    config: {
      version: "2.0.0",
      providerId: id,
      provider: {
        id,
        enabled: true,
        type: values.provider_type,
        baseURL: String(values.base_url || "").trim(),
        defaultModel,
        auth: { apiKey: values.api_key || "" },
        headers,
        models: modelMap,
      },
    },
  };
}

function buildWizard() {
  const stepsHost = document.getElementById("wizard-steps");
  const bodyHost = document.getElementById("wizard-body");
  const summaryHost = document.getElementById("wizard-summary");
  const actionsHost = document.getElementById("wizard-actions");
  if (!stepsHost || !bodyHost) return null;

  const fields = [
    createField({
      name: "provider_id",
      label: "Provider id",
      required: true,
      hint: "Directory name under provider/ and the route `use` prefix.",
      validate: validators.pattern(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash or underscore"),
    }),
    createField({
      name: "provider_type",
      label: "Protocol",
      required: true,
      options: PROVIDER_TYPES,
      value: "openai_chat",
      hint: "Confirm the suggestion from the endpoint; the backend compile chain normalizes it.",
    }),
    createField({
      name: "base_url",
      label: "Base URL",
      required: true,
      placeholder: "https://api.example.com/v1",
      validate: validators.url(),
    }),
    createField({
      name: "api_key",
      label: "API key",
      required: true,
      type: "password",
      autocomplete: "off",
      hint: "Stored in the provider config file. It never appears in probe evidence.",
    }),
    createField({
      name: "default_model",
      label: "Default model",
      required: true,
      placeholder: "gpt-5.1",
    }),
    createField({
      name: "models",
      label: "Models",
      type: "textarea",
      rows: 3,
      mono: true,
      hint: "One canonical model id per line (or comma separated). The default model is always included.",
    }),
    createField({
      name: "headers",
      label: "Extra provider headers",
      type: "textarea",
      rows: 2,
      mono: true,
      hint: "Optional `name: value` per line. Values are redacted in probe evidence.",
    }),
  ];
  const form = createForm({ fields });
  summaryHost.innerHTML = "";
  summaryHost.appendChild(form.summary.element);

  const stepHost = el("div");
  const probeTerminal = createProbeTerminal({
    onComplete: (payload) => {
      showStatus(payload.ok ? "ok" : "err", `probe ${payload.ok ? "passed" : "failed"} in ${fmtMs(payload.duration_ms)}`);
    },
  });
  const resultHost = el("div", "panel");

  const dirty = createDirtyGuard({
    snapshot: () => JSON.stringify(form.values()),
    message: "The onboarding wizard has unsaved values. Discard them?",
  });

  function renderSteps() {
    stepsHost.innerHTML = "";
    WIZARD_STEPS.forEach((step, index) => {
      const chip = el("span", `wizard-step${index === state.wizardStep ? " active" : ""}${index < state.wizardStep ? " done" : ""}`, step.label);
      stepsHost.appendChild(chip);
    });
  }

  function renderActions() {
    actionsHost.innerHTML = "";
    if (state.wizardStep > 0) {
      actionsHost.appendChild(actionButton("Back", () => go(state.wizardStep - 1)));
    }
    if (state.wizardStep < WIZARD_STEPS.length - 1) {
      actionsHost.appendChild(actionButton("Next", () => go(state.wizardStep + 1)));
    }
    actionsHost.appendChild(actionButton("Close", async () => {
      if (await dirty.confirmDiscard()) closeWizard();
    }));
  }

  function renderStep() {
    renderSteps();
    renderActions();
    const step = WIZARD_STEPS[state.wizardStep].id;
    bodyHost.innerHTML = "";
    bodyHost.appendChild(stepHost);
    stepHost.innerHTML = "";
    if (step === "credentials") {
      const grid = el("div", "wizard-fields");
      for (const field of fields) grid.appendChild(field.element);
      stepHost.appendChild(grid);
      const infer = el("button", "btn", "Suggest protocol from endpoint");
      infer.type = "button";
      infer.addEventListener("click", () => {
        const suggested = inferProviderType(form.values().base_url, form.values().default_model);
        fields.find((field) => field.name === "provider_type").setValue(suggested);
        showStatus("ok", `suggested protocol: ${suggested} (confirm before validating)`);
      });
      stepHost.appendChild(infer);
      stepHost.appendChild(el("div", "hint", "Values are only written to disk in step 5 (Commit). Steps 2-4 never write."));
      return;
    }
    if (step === "discover") {
      stepHost.appendChild(el("p", "hint", "Model discovery sends one authenticated GET to the provider ({base_url}/models, anthropic /v1/models, gemini /v1beta/models). A failure is reported as-is; no list is guessed."));
      const run = el("button", "btn primary", "Discover models");
      run.addEventListener("click", async () => {
        run.disabled = true;
        resultHost.innerHTML = "";
        try {
          const candidate = wizardCandidate();
          if (!candidate) return;
          const result = await api("/api/providers/discover", { method: "POST", body: JSON.stringify({ config: candidate }) });
          resultHost.appendChild(el("div", "hint", `${result.count} model(s) from ${result.provider_type} at ${result.base_url} (auth alias ${result.auth_alias})`));
          for (const model of result.models) {
            const row = el("div", "row");
            row.appendChild(el("span", "name mono", model));
            const use = actionButton("Use", () => {
              const field = fields.find((item) => item.name === "models");
              const existing = splitList(field.value());
              if (!existing.includes(model)) existing.push(model);
              field.setValue(existing.join("\n"));
              showStatus("ok", `added ${model} to the model list`);
            });
            row.appendChild(use);
            resultHost.appendChild(row);
          }
          const useAll = actionButton("Use all discovered models", () => {
            fields.find((item) => item.name === "models").setValue(result.models.join("\n"));
            showStatus("ok", `model list set from discovery (${result.models.length})`);
          });
          resultHost.appendChild(useAll);
        } catch (error) {
          resultHost.appendChild(el("div", "loading", `discovery failed: ${error.message}`));
          showStatus("err", `discovery failed: ${error.message}`);
        } finally {
          run.disabled = false;
        }
      });
      stepHost.appendChild(run);
      stepHost.appendChild(resultHost);
      return;
    }
    if (step === "validate") {
      stepHost.appendChild(el("p", "hint", "Validation runs the real compile chain in a temporary directory. Nothing is written to the config directory."));
      const run = el("button", "btn primary", "Validate candidate");
      run.addEventListener("click", async () => {
        run.disabled = true;
        resultHost.innerHTML = "";
        try {
          const candidate = wizardCandidate();
          if (!candidate) return;
          const result = await api("/api/providers/validate", { method: "POST", body: JSON.stringify({ config: candidate }) });
          resultHost.appendChild(resultRow("ok", String(result.ok)));
          resultHost.appendChild(resultRow("normalized_type", result.normalized_type || "—"));
          resultHost.appendChild(resultRow("base_url", result.base_url));
          resultHost.appendChild(resultRow("default_model", result.default_model));
          resultHost.appendChild(resultRow("models", (result.models || []).join(", ") || "—"));
          for (const error of result.errors || []) {
            resultHost.appendChild(resultRow(`${error.field} (${error.source})`, error.message));
          }
          if (result.compile_error) resultHost.appendChild(resultRow("compile_error", result.compile_error));
          showStatus(result.ok ? "ok" : "err", result.ok ? "candidate valid" : "candidate rejected — see field errors");
        } catch (error) {
          resultHost.appendChild(el("div", "loading", `validation failed: ${error.message}`));
          showStatus("err", `validation failed: ${error.message}`);
        } finally {
          run.disabled = false;
        }
      });
      stepHost.appendChild(run);
      stepHost.appendChild(resultHost);
      return;
    }
    if (step === "probe") {
      stepHost.appendChild(el("p", "hint", "The probe streams the L1/L2/L3 ladder through the runtime's own builder. Every secret is redacted in the evidence."));
      const stageRow = el("div", "actions");
      for (const stage of PROBE_STAGES) {
        const label = el("label", "hint");
        const box = el("input");
        box.type = "checkbox";
        box.checked = true;
        box.value = stage;
        label.appendChild(box);
        label.appendChild(document.createTextNode(` ${probeStageLabel(stage)}`));
        stageRow.appendChild(label);
      }
      stepHost.appendChild(stageRow);
      const run = el("button", "btn primary", "Run probe ladder");
      run.addEventListener("click", async () => {
        const stages = [...stageRow.querySelectorAll("input:checked")].map((box) => box.value);
        const candidate = wizardCandidate();
        if (!candidate) return;
        await probeTerminal.run({ config: candidate, stages });
      });
      stepHost.appendChild(run);
      stepHost.appendChild(probeTerminal.element);
      return;
    }
    if (step === "commit") {
      const candidate = wizardCandidate({ silent: true });
      stepHost.appendChild(el("p", "hint", "Commit validates again, then writes provider/<id>/config.v2.toml atomically with a backup and a revision entry."));
      const preview = el("pre", "terminal");
      preview.textContent = JSON.stringify(redactCandidate(candidate), null, 2);
      stepHost.appendChild(preview);
      const reason = createField({ name: "reason", label: "Revision reason", value: "webui provider create" });
      stepHost.appendChild(reason.element);
      const run = el("button", "btn primary", "Commit provider");
      run.addEventListener("click", async () => {
        run.disabled = true;
        resultHost.innerHTML = "";
        try {
          const payload = candidateFromValues(form.values());
          if (payload.invalidHeaders.length) {
            showStatus("err", `invalid header line(s): ${payload.invalidHeaders.join(", ")}`);
            return;
          }
          const exists = state.providers.some((provider) => provider.id === payload.config.provider.id);
          if (exists) {
            const confirmed = await confirmDialog({
              title: `Overwrite provider ${payload.config.provider.id}`,
              message: "This provider already exists. Committing replaces its config file (a backup is written first).",
              confirmLabel: "Overwrite",
              danger: true,
            });
            if (!confirmed) return;
          }
          const path = exists
            ? `/api/providers/${encodeURIComponent(payload.config.provider.id)}`
            : "/api/providers";
          const result = await apiRaw(path, {
            method: exists ? "PUT" : "POST",
            body: JSON.stringify({ config: payload.config, reason: reason.value() }),
          });
          if (!result.ok) {
            resultHost.appendChild(el("div", "loading", `commit failed (${result.status}): ${result.body?.error || JSON.stringify(result.body)}`));
            for (const error of result.body?.errors || []) {
              resultHost.appendChild(resultRow(`${error.field} (${error.source})`, error.message));
            }
            if (result.body?.compile_error) resultHost.appendChild(resultRow("compile_error", result.body.compile_error));
            showStatus("err", `commit failed: ${result.body?.error || result.status}`);
            return;
          }
          resultHost.appendChild(resultRow("provider_id", result.body.provider_id));
          resultHost.appendChild(resultRow("created", String(result.body.created)));
          resultHost.appendChild(resultRow("normalized_type", result.body.normalized_type || "—"));
          resultHost.appendChild(resultRow("path", result.body.path));
          resultHost.appendChild(resultRow("backup", result.body.backup || "none (new file)"));
          resultHost.appendChild(resultRow("source_sha256", result.body.source_sha256));
          resultHost.appendChild(resultRow("revision_seq", String(result.body.revision_seq)));
          showStatus("ok", `${result.body.provider_id} ${result.body.created ? "created" : "updated"} · revision ${result.body.revision_seq}`);
          dirty.markClean();
          await load();
        } finally {
          run.disabled = false;
        }
      });
      stepHost.appendChild(run);
      stepHost.appendChild(resultHost);
      return;
    }
    // route wiring
    stepHost.appendChild(el("p", "hint", "Optional: append this provider/model to a routing pool tier. This writes user routing with a backup and a route.bind revision."));
    const serverSelect = el("select");
    const servers = state.routes?.servers || [];
    for (const server of servers) {
      const option = el("option", null, `${server.server_id}:${server.port}`);
      option.value = server.server_id;
      serverSelect.appendChild(option);
    }
    const poolField = createField({ name: "pool", label: "Pool", value: "default" });
    const tierField = createField({ name: "tier", label: "Tier index", type: "number", value: "0" });
    const modelField = createField({ name: "route_model", label: "Model", hint: "Defaults to the provider default model." });
    stepHost.appendChild(serverSelect);
    stepHost.appendChild(poolField.element);
    stepHost.appendChild(tierField.element);
    stepHost.appendChild(modelField.element);
    if (!servers.length) {
      stepHost.appendChild(el("div", "loading", "no servers found in user routing — bind is unavailable until a server exists"));
    }
    const run = el("button", "btn primary", "Bind route");
    run.addEventListener("click", async () => {
      run.disabled = true;
      resultHost.innerHTML = "";
      try {
        const providerId = String(form.values().provider_id || "").trim();
        const result = await apiRaw("/api/providers/routes/bind", {
          method: "POST",
          body: JSON.stringify({
            provider_id: providerId,
            server_id: serverSelect.value,
            pool: poolField.value(),
            model: modelField.value() || null,
            tier: Number(tierField.value() || 0),
            reason: "webui provider onboarding",
          }),
        });
        if (!result.ok) {
          resultHost.appendChild(el("div", "loading", `bind failed (${result.status}): ${result.body?.error || JSON.stringify(result.body)}`));
          showStatus("err", `bind failed: ${result.body?.error || result.status}`);
          return;
        }
        resultHost.appendChild(resultRow("use_ref", result.body.use_ref));
        resultHost.appendChild(resultRow("already_bound", String(result.body.already_bound)));
        resultHost.appendChild(resultRow("written", String(result.body.written)));
        showStatus("ok", result.body.already_bound ? `${result.body.use_ref} already bound` : `bound ${result.body.use_ref}`);
        await load();
      } finally {
        run.disabled = false;
      }
    });
    stepHost.appendChild(run);
    stepHost.appendChild(resultHost);
  }

  function wizardCandidate(options = {}) {
    const payload = candidateFromValues(form.values());
    if (payload.invalidHeaders.length) {
      if (!options.silent) showStatus("err", `invalid header line(s): ${payload.invalidHeaders.join(", ")}`);
      return null;
    }
    const failures = fields.filter((field) => field.validate());
    if (failures.length) {
      form.summary.show(failures.map((field) => ({ field, message: field.errorElement.textContent })));
      if (!options.silent) showStatus("err", `${failures.length} field(s) need attention`);
      return null;
    }
    return payload.config;
  }

  function redactCandidate(config) {
    if (!config) return config;
    const clone = JSON.parse(JSON.stringify(config));
    if (clone.provider?.auth?.apiKey) clone.provider.auth.apiKey = "***redacted***";
    if (clone.provider?.headers) {
      for (const key of Object.keys(clone.provider.headers)) clone.provider.headers[key] = "***redacted***";
    }
    return clone;
  }

  function go(step) {
    if (step > state.wizardStep && state.wizardStep === 0) {
      if (!form.validateAll()) {
        showStatus("err", "fix the highlighted credential fields first");
        return;
      }
    }
    state.wizardStep = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step));
    renderStep();
  }

  return {
    open() {
      state.wizardStep = 0;
      form.reset({ provider_type: "openai_chat", headers: "", models: "" });
      dirty.markClean();
      document.getElementById("wizard-panel").hidden = false;
      renderStep();
      loadRoutes();
    },
    close: () => closeWizard(),
    dirty,
    go,
    form,
  };
}

let wizard = null;

function closeWizard() {
  const panel = document.getElementById("wizard-panel");
  if (panel) panel.hidden = true;
}

async function loadRoutes() {
  try {
    state.routes = await api("/api/routes");
  } catch (error) {
    showStatus("err", `routes unavailable: ${error.message}`);
  }
}

function openProbeFor(id) {
  const panel = document.getElementById("probe-panel");
  if (!panel) return;
  panel.hidden = false;
  const host = document.getElementById("probe-host");
  const terminal = createProbeTerminal();
  host.innerHTML = "";
  host.appendChild(terminal.element);
  const provider = state.providers.find((item) => item.id === id);
  terminal.run({ id, model: null, stages: PROBE_STAGES });
  document.getElementById("probe-target").textContent = `provider ${id}${provider ? ` · ${provider.base_url}` : ""}`;
}

// ---------------------------------------------------------------------------
// patrol
// ---------------------------------------------------------------------------

function renderPatrolProviderOptions() {
  const select = document.getElementById("patrol-provider");
  if (!select) return;
  const current = state.patrolProvider || select.value;
  select.innerHTML = "";
  for (const provider of state.providers) {
    const option = el("option", null, provider.id);
    option.value = provider.id;
    select.appendChild(option);
  }
  if (current && state.providers.some((provider) => provider.id === current)) {
    select.value = current;
  }
  if (!state.patrolProvider && state.providers.length) state.patrolProvider = select.value;
  if (state.patrolProvider) loadPatrol();
}

function selectPatrolProvider(id) {
  state.patrolProvider = id;
  const select = document.getElementById("patrol-provider");
  if (select) select.value = id;
  document.getElementById("patrol-panel").hidden = false;
  loadPatrol();
}

async function loadPatrol() {
  const id = state.patrolProvider;
  const planHost = document.getElementById("patrol-plan");
  const historyHost = document.getElementById("patrol-history");
  const statusHost = document.getElementById("patrol-status");
  if (!id || !planHost) return;
  try {
    const [planPayload, results, status] = await Promise.all([
      api(`/api/providers/${encodeURIComponent(id)}/patrol`),
      api(`/api/providers/${encodeURIComponent(id)}/patrol/results`),
      api("/api/providers/patrol/status"),
    ]);
    const plan = planPayload.plan;
    planHost.innerHTML = "";
    planHost.appendChild(resultRow("provider", id));
    planHost.appendChild(resultRow("stored plan", String(planPayload.stored)));
    planHost.appendChild(resultRow("enabled", String(plan.enabled)));
    planHost.appendChild(resultRow("interval_secs", String(plan.interval_secs)));
    planHost.appendChild(resultRow("stages", (plan.stages || []).join(", ")));
    planHost.appendChild(resultRow("last run", planPayload.last_run_epoch_ms ? new Date(planPayload.last_run_epoch_ms).toLocaleString() : "never"));
    const enabledBox = el("input");
    enabledBox.type = "checkbox";
    enabledBox.checked = Boolean(plan.enabled);
    const intervalInput = el("input");
    intervalInput.type = "number";
    intervalInput.min = "30";
    intervalInput.value = String(plan.interval_secs || 300);
    const stageBoxes = PROBE_STAGES.map((stage) => {
      const box = el("input");
      box.type = "checkbox";
      box.value = stage;
      box.checked = (plan.stages || []).includes(stage);
      return box;
    });
    const editor = el("div", "actions");
    const enabledLabel = el("label", "hint");
    enabledLabel.appendChild(enabledBox);
    enabledLabel.appendChild(document.createTextNode(" enabled"));
    const intervalLabel = el("label", "hint");
    intervalLabel.appendChild(document.createTextNode("interval (s) "));
    intervalLabel.appendChild(intervalInput);
    editor.appendChild(enabledLabel);
    editor.appendChild(intervalLabel);
    PROBE_STAGES.forEach((stage, index) => {
      const label = el("label", "hint");
      label.appendChild(stageBoxes[index]);
      label.appendChild(document.createTextNode(` ${stage}`));
      editor.appendChild(label);
    });
    const save = el("button", "btn primary", "Save plan");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api(`/api/providers/${encodeURIComponent(id)}/patrol`, {
          method: "PUT",
          body: JSON.stringify({
            enabled: enabledBox.checked,
            interval_secs: Number(intervalInput.value || 0),
            stages: stageBoxes.filter((box) => box.checked).map((box) => box.value),
          }),
        });
        showStatus("ok", `patrol plan saved for ${id}`);
        loadPatrol();
      } catch (error) {
        showStatus("err", `patrol plan rejected: ${error.message}`);
      } finally {
        save.disabled = false;
      }
    });
    const remove = el("button", "btn", "Delete plan");
    remove.addEventListener("click", async () => {
      await api(`/api/providers/${encodeURIComponent(id)}/patrol`, { method: "DELETE" });
      showStatus("ok", `patrol plan removed for ${id}`);
      loadPatrol();
    });
    const runNow = el("button", "btn", "Run now");
    runNow.addEventListener("click", async () => {
      runNow.disabled = true;
      try {
        const result = await api(`/api/providers/${encodeURIComponent(id)}/patrol/run`, { method: "POST" });
        showStatus(result.ok ? "ok" : "err", `patrol ${result.ok ? "passed" : "failed"} (${(result.result?.stages || []).length} stage(s))`);
        loadPatrol();
      } catch (error) {
        showStatus("err", `patrol run failed: ${error.message}`);
      } finally {
        runNow.disabled = false;
      }
    });
    editor.appendChild(save);
    editor.appendChild(remove);
    editor.appendChild(runNow);
    planHost.appendChild(editor);
    planHost.appendChild(el("div", "hint", "Patrol results are advisory diagnostics. They never mutate runtime provider health."));

    statusHost.textContent = `${status.plan_count} plan(s), ${status.enabled_count} enabled · next tick ${status.next_tick_ms} ms · history ${status.results_path}`;

    historyHost.innerHTML = "";
    if (!results.results.length) {
      historyHost.appendChild(el("div", "loading", "no patrol results recorded yet"));
    } else {
      const table = el("table");
      const head = el("thead");
      const headRow = el("tr");
      for (const label of ["Started", "Trigger", "Result", "Duration", "Stages"]) headRow.appendChild(el("th", null, label));
      head.appendChild(headRow);
      table.appendChild(head);
      const body = el("tbody");
      for (const result of results.results) {
        const row = el("tr");
        row.appendChild(el("td", null, new Date(result.started_at_epoch_ms).toLocaleString()));
        row.appendChild(el("td", null, result.trigger));
        const cell = el("td");
        cell.appendChild(badge(result.ok ? "ok" : "failed"));
        row.appendChild(cell);
        row.appendChild(el("td", "num", fmtMs(result.duration_ms)));
        row.appendChild(el("td", "mono", (result.stages || []).map((stage) => `${stage.stage}:${stage.ok ? "ok" : stage.error_code || "fail"}`).join(" ")));
        body.appendChild(row);
      }
      table.appendChild(body);
      historyHost.appendChild(table);
    }
  } catch (error) {
    showStatus("err", `patrol failed: ${error.message}`);
  }
}

function resultRow(label, value) {
  const row = el("div", "row");
  row.appendChild(el("span", "name", label));
  row.appendChild(el("span", "meta mono", value));
  return row;
}

// ---------------------------------------------------------------------------
// bulk import
// ---------------------------------------------------------------------------

async function runImport(dryRun) {
  const textarea = document.getElementById("import-text");
  const resultsHost = document.getElementById("import-results");
  const summaryHost = document.getElementById("import-summary");
  const text = textarea.value;
  if (!text.trim()) {
    showStatus("err", "paste at least one provider document first");
    return;
  }
  state.importText = text;
  try {
    const result = await api("/api/providers/import", {
      method: "POST",
      body: JSON.stringify({ text, dry_run: dryRun, reason: dryRun ? "webui import preview" : "webui bulk import" }),
    });
    summaryHost.textContent = `${dryRun ? "preview" : "import"}: ${result.written} written, ${result.failed} failed, ${result.retry?.count || 0} retryable`;
    resultsHost.innerHTML = "";
    const table = el("table");
    const head = el("thead");
    const headRow = el("tr");
    for (const label of ["#", "Provider", "Result", "Retryable", "Detail"]) headRow.appendChild(el("th", null, label));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    for (const item of result.items) {
      const row = el("tr");
      row.appendChild(el("td", "num", String(item.index)));
      row.appendChild(el("td", null, item.provider_id || "—"));
      const cell = el("td");
      cell.appendChild(badge(item.ok ? "ok" : "failed"));
      row.appendChild(cell);
      row.appendChild(el("td", null, item.retryable ? "yes" : "no"));
      const detail = [
        item.parse_error,
        item.compile_error,
        ...(item.errors || []).map((error) => `${error.field}: ${error.message}`),
        item.written ? `written · revision ${item.revision_seq}` : null,
      ].filter(Boolean).join(" · ");
      row.appendChild(el("td", "mono", detail || "—"));
      body.appendChild(row);
    }
    table.appendChild(body);
    resultsHost.appendChild(table);
    if (result.retry?.count) {
      const retryBtn = el("button", "btn", `Load ${result.retry.count} retryable document(s) into the editor`);
      retryBtn.addEventListener("click", () => {
        textarea.value = result.retry.text;
        showStatus("ok", "retryable documents loaded — press Import to retry them");
      });
      resultsHost.appendChild(retryBtn);
    }
    showStatus(result.failed ? "warn" : "ok", `import ${dryRun ? "preview" : "complete"}: ${result.written} written, ${result.failed} failed`);
    if (!dryRun && result.written) load();
  } catch (error) {
    showStatus("err", `import failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

wizard = buildWizard();
document.getElementById("add-provider-btn")?.addEventListener("click", () => wizard?.open());
document.getElementById("refresh-btn")?.addEventListener("click", load);
document.getElementById("patrol-provider")?.addEventListener("change", (event) => {
  state.patrolProvider = event.target.value;
  loadPatrol();
});
document.getElementById("import-preview-btn")?.addEventListener("click", () => runImport(true));
document.getElementById("import-run-btn")?.addEventListener("click", () => runImport(false));

loadRoutes();
load();
startAutoRefresh(load);
