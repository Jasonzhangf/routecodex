// RCC V3 Admin WebUI — Routes editor view.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/routes.js)

import { api, el, escapeHtml, showStatus } from "../core.js";
import { initShell } from "../shell.js";

initShell("routes", {
  title: "Routes",
  subtitle: "Tier 1 is tried first. Put alternatives in the same tier to share traffic; add lower tiers as backups.",
});

const state = {
  servers: [],
  baseline: "",
  activeServer: null,
  query: "",
  providers: null,
  pickerTarget: null,
  pickerSelected: null,
  busy: false,
  collapsedPools: new Set(),
  collapsedTiers: new Set(),
};

const tree = document.getElementById("route-tree");
const statusBar = document.getElementById("status-bar");
const saveButton = document.getElementById("save-btn");
const discardButton = document.getElementById("discard-btn");
const saveState = document.getElementById("save-state");
const picker = document.getElementById("provider-picker");
document.getElementById("server-selector").addEventListener("change", event => {
  state.activeServer = event.target.value;
  renderRoutes();
});

function snapshot() {
  return JSON.stringify(state.servers);
}

function isDirty() {
  return state.baseline !== "" && snapshot() !== state.baseline;
}

function setBusy(busy, label) {
  state.busy = busy;
  tree.setAttribute("aria-busy", String(busy));
  saveButton.disabled = busy || !isDirty();
  discardButton.disabled = busy || !isDirty();
  if (label) {
    saveState.textContent = label;
    saveState.classList.toggle("dirty", isDirty() && !busy);
  }
}

function announce(kind, message) {
  statusBar.className = `status-bar ${kind}`;
  statusBar.textContent = message;
}

function markDirty() {
  saveState.textContent = "Unsaved changes";
  saveState.classList.add("dirty");
  saveButton.disabled = false;
  discardButton.disabled = false;
  announce("info", "Changes are local until you save.");
}

function currentServer() {
  return state.servers.find(server => server.server_id === state.activeServer) || null;
}

function renderServerSelector() {
  const selector = document.getElementById("server-selector");
  if (!state.activeServer && state.servers.length) state.activeServer = state.servers[0].server_id;
  selector.innerHTML = state.servers.map(server =>
    `<option value="${escapeHtml(server.server_id)}">${escapeHtml(server.server_id)}:${escapeHtml(server.port)}</option>`
  ).join("");
  selector.value = state.activeServer || "";
}

function memberMatches(member, query) {
  return !query || member.use.toLowerCase().includes(query);
}

function renderRoutes() {
  const group = currentServer();
  const query = state.query.trim().toLowerCase();
  if (!group) {
    tree.innerHTML = `<div class="route-empty"><h2>No servers</h2><p>Run <code>rccv3 init</code> after adding a provider.</p></div>`;
    tree.setAttribute("aria-busy", "false");
    return;
  }
  const pools = group.pools.filter(pool =>
    !query || pool.name.toLowerCase().includes(query) ||
    pool.tiers.some(tier => tier.members.some(member => memberMatches(member, query)))
  );
  if (!pools.length) {
    tree.innerHTML = `<div class="route-empty"><h2>No matching routes</h2><p>Try another provider, model, or pool name.</p></div>`;
    tree.setAttribute("aria-busy", "false");
    return;
  }
  tree.innerHTML = pools.map(pool => {
    const poolIndex = group.pools.indexOf(pool);
    const tiers = pool.tiers.map((tier, tierIndex) => renderTier(pool, poolIndex, tier, tierIndex)).join("");
    const collapsed = state.collapsedPools.has(poolIndex) ? " collapsed" : "";
    return `<article class="route-pool-card route-pool${collapsed}">
      <div class="route-pool-head">
        <button type="button" class="pool-toggle" data-action="toggle-pool" data-pool="${poolIndex}" aria-expanded="${!state.collapsedPools.has(poolIndex)}"><span class="caret">▾</span><h2>${escapeHtml(pool.name)}</h2></button>
        <button class="btn route-add-tier" data-action="add-tier" data-pool="${poolIndex}">Add backup tier</button>
      </div>
      <div class="route-tier-list">${tiers}</div>
    </article>`;
  }).join("");
  tree.setAttribute("aria-busy", "false");
}

function renderTier(pool, poolIndex, tier, tierIndex) {
  const members = tier.members.map((member, memberIndex) => {
    const [provider, ...modelParts] = member.use.split("/");
    const model = modelParts.join("/");
    const showWeight = tier.members.length > 1;
    return `<div class="route-member">
      <div class="route-member-name"><strong>${escapeHtml(provider)}</strong><span>${escapeHtml(model)}</span></div>
      ${showWeight ? `<label class="route-weight">Weight<span class="sr-only"> for ${escapeHtml(member.use)}</span><input type="number" min="1" step="1" inputmode="numeric" placeholder="Equal" value="${member.weight ?? ""}" data-action="weight" data-pool="${poolIndex}" data-tier="${tierIndex}" data-member="${memberIndex}"></label>` : `<span class="mono muted tiny">equal weight</span>`}
      <button class="icon-btn danger" data-action="remove-member" data-pool="${poolIndex}" data-tier="${tierIndex}" data-member="${memberIndex}" ${tier.members.length === 1 ? "disabled" : ""} aria-label="Remove ${escapeHtml(member.use)}">×</button>
    </div>`;
  }).join("");
  const collapsed = state.collapsedTiers.has(`${poolIndex}:${tierIndex}`) ? " collapsed" : "";
  return `<section class="route-tier${collapsed}" aria-labelledby="tier-${poolIndex}-${tierIndex}">
    <div class="route-tier-head">
      <button type="button" class="tier-toggle" data-action="toggle-tier" data-pool="${poolIndex}" data-tier="${tierIndex}" aria-expanded="${!state.collapsedTiers.has(`${poolIndex}:${tierIndex}`)}"><span class="caret">▾</span><h3 id="tier-${poolIndex}-${tierIndex}">Tier ${tierIndex + 1}</h3><span class="role">${tierIndex === 0 ? "Primary" : "Fallback"}</span></button>
      <div class="route-tier-actions">
        <button class="icon-btn" data-action="tier-up" data-pool="${poolIndex}" data-tier="${tierIndex}" ${tierIndex === 0 ? "disabled" : ""} aria-label="Move tier up">↑</button>
        <button class="icon-btn" data-action="tier-down" data-pool="${poolIndex}" data-tier="${tierIndex}" ${tierIndex === pool.tiers.length - 1 ? "disabled" : ""} aria-label="Move tier down">↓</button>
        <button class="icon-btn danger" data-action="remove-tier" data-pool="${poolIndex}" data-tier="${tierIndex}" ${pool.tiers.length === 1 ? "disabled" : ""} aria-label="Remove tier">×</button>
      </div>
    </div>
    <div class="route-members">${members}</div>
    <button class="route-add-member" data-action="add-member" data-pool="${poolIndex}" data-tier="${tierIndex}">+ Add model to this tier</button>
  </section>`;
}

function poolFrom(target) {
  return currentServer()?.pools[Number(target.dataset.pool)];
}

tree.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "toggle-pool") {
    const poolIndex = Number(button.dataset.pool);
    state.collapsedPools.has(poolIndex) ? state.collapsedPools.delete(poolIndex) : state.collapsedPools.add(poolIndex);
    renderRoutes();
    return;
  }
  if (button.dataset.action === "toggle-tier") {
    const key = `${button.dataset.pool}:${button.dataset.tier}`;
    state.collapsedTiers.has(key) ? state.collapsedTiers.delete(key) : state.collapsedTiers.add(key);
    renderRoutes();
    return;
  }
  const pool = poolFrom(button);
  if (!pool) return;
  const tierIndex = Number(button.dataset.tier);
  if (button.dataset.action === "tier-up" || button.dataset.action === "tier-down") {
    const next = tierIndex + (button.dataset.action === "tier-up" ? -1 : 1);
    [pool.tiers[tierIndex], pool.tiers[next]] = [pool.tiers[next], pool.tiers[tierIndex]];
    markDirty(); renderRoutes(); return;
  }
  if (button.dataset.action === "remove-tier" && pool.tiers.length > 1) {
    pool.tiers.splice(tierIndex, 1); markDirty(); renderRoutes(); return;
  }
  if (button.dataset.action === "remove-member") {
    const tier = pool.tiers[tierIndex];
    if (tier.members.length > 1) tier.members.splice(Number(button.dataset.member), 1);
    markDirty(); renderRoutes(); return;
  }
  if (button.dataset.action === "add-tier") openPicker(Number(button.dataset.pool), null);
  if (button.dataset.action === "add-member") openPicker(Number(button.dataset.pool), tierIndex);
});

tree.addEventListener("change", event => {
  if (event.target.dataset.action !== "weight") return;
  const pool = poolFrom(event.target);
  const member = pool?.tiers[Number(event.target.dataset.tier)]?.members[Number(event.target.dataset.member)];
  if (!member) return;
  member.weight = event.target.value === "" ? null : Number(event.target.value);
  markDirty();
});

async function providerModels() {
  if (state.providers) return state.providers;
  const providers = await api("/api/providers");
  const details = await Promise.all(providers.map(provider => api(`/api/providers/${encodeURIComponent(provider.id)}`)));
  state.providers = details.filter(detail => detail?.config?.provider?.enabled !== false).flatMap(detail =>
    Object.keys(detail?.config?.provider?.models || {}).map(model => ({ use: `${detail.id}/${model}` }))
  ).sort((a, b) => a.use.localeCompare(b.use));
  return state.providers;
}

async function openPicker(poolIndex, tierIndex) {
  state.pickerTarget = { poolIndex, tierIndex };
  state.pickerSelected = null;
  document.getElementById("picker-filter").value = "";
  document.getElementById("picker-list").innerHTML = '<div class="route-picker-state">Loading provider models…</div>';
  document.getElementById("picker-confirm").disabled = true;
  picker.showModal();
  try {
    await providerModels();
    renderPicker("");
    document.getElementById("picker-filter").focus();
  } catch (error) {
    document.getElementById("picker-list").innerHTML = `<div class="route-picker-state error">Could not load providers: ${escapeHtml(error.message)}</div>`;
  }
}

function renderPicker(query) {
  const normalized = query.trim().toLowerCase();
  const candidates = (state.providers || []).filter(item => !normalized || item.use.toLowerCase().includes(normalized));
  const list = document.getElementById("picker-list");
  if (!candidates.length) {
    list.innerHTML = '<div class="route-picker-state">No provider models match.</div>';
    return;
  }
  list.innerHTML = candidates.map(item => `<label class="route-picker-option"><input type="radio" name="provider-model" value="${escapeHtml(item.use)}"><span>${escapeHtml(item.use)}</span></label>`).join("");
}

document.getElementById("picker-filter").addEventListener("input", event => renderPicker(event.target.value));
document.getElementById("picker-list").addEventListener("change", event => {
  state.pickerSelected = event.target.value;
  document.getElementById("picker-confirm").disabled = false;
});
picker.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    picker.close("cancel");
  }
});
picker.addEventListener("close", () => {
  if (picker.returnValue !== "default" || !state.pickerSelected) return;
  const pool = currentServer()?.pools[state.pickerTarget.poolIndex];
  if (!pool) return;
  const duplicate = pool.tiers.some(tier => tier.members.some(member => member.use === state.pickerSelected));
  if (duplicate) {
    announce("err", `${state.pickerSelected} is already in this pool.`);
    return;
  }
  const member = { use: state.pickerSelected, weight: null };
  if (state.pickerTarget.tierIndex == null) pool.tiers.push({ members: [member] });
  else pool.tiers[state.pickerTarget.tierIndex].members.push(member);
  markDirty(); renderRoutes();
});

async function load() {
  setBusy(true, "Loading");
  announce("info", "Loading routes…");
  try {
    const data = await api("/api/routes");
    state.servers = data.servers || [];
    state.baseline = snapshot();
    state.activeServer = state.servers[0]?.server_id || null;
    renderServerSelector(); renderRoutes();
    announce("ok", "Routes loaded. Tier 1 is tried first.");
    setBusy(false, "Saved");
  } catch (error) {
    tree.innerHTML = `<div class="route-empty error"><h2>Routes could not load</h2><p>${escapeHtml(error.message)}</p><button class="btn" id="retry-load">Try again</button></div>`;
    document.getElementById("retry-load")?.addEventListener("click", load);
    announce("err", `Load failed: ${error.message}`);
    setBusy(false, "Load failed");
  }
}

document.getElementById("search-filter").addEventListener("input", event => {
  state.query = event.target.value; renderRoutes();
});
document.getElementById("validate-btn").addEventListener("click", async () => {
  setBusy(true, "Validating"); announce("info", "Validating routes…");
  try {
    const result = await api("/api/routes/validate", { method: "POST", body: JSON.stringify({ servers: state.servers, reason: "webui validate" }) });
    announce(result.ok ? "ok" : "err", result.ok ? "Configuration is valid." : `Invalid configuration: ${result.error}`);
  } catch (error) { announce("err", `Validation failed: ${error.message}`); }
  finally { setBusy(false, isDirty() ? "Unsaved changes" : "Saved"); }
});
saveButton.addEventListener("click", async () => {
  setBusy(true, "Saving"); announce("info", "Validating and saving routes…");
  saveButton.textContent = "Saving…";
  try {
    const result = await api("/api/routes", { method: "PUT", body: JSON.stringify({ servers: state.servers, reason: "webui routes update" }) });
    state.servers = result.servers; state.baseline = snapshot();
    renderServerSelector(); renderRoutes();
    announce("info", `Saved revision #${result.revision_seq}; reloading runtime…`);
    // A saved revision is not effective until the runtime reloads its immutable
    // manifest, so success is only announced after reload confirms it.
    try {
      await api("/api/reload", { method: "POST" });
      announce("ok", `Routes saved as revision #${result.revision_seq} and runtime reloaded.`);
      setBusy(false, "Saved");
    } catch (reloadError) {
      announce("err", `Revision #${result.revision_seq} saved but runtime reload failed, so it is not active yet: ${reloadError.message}`);
      setBusy(false, "Saved (reload failed)");
    }
  } catch (error) {
    announce("err", `Save failed: ${error.message}`);
    setBusy(false, "Save failed");
  } finally {
    saveButton.textContent = "Save routes";
  }
});
discardButton.addEventListener("click", () => {
  state.servers = JSON.parse(state.baseline); renderServerSelector(); renderRoutes();
  announce("info", "Unsaved changes discarded."); setBusy(false, "Saved");
});
window.addEventListener("beforeunload", event => { if (isDirty()) { event.preventDefault(); event.returnValue = ""; } });

load();
