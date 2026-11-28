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
  queues: new Map(),
  queueBusy: false,
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
  renderRoutes();
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
      <div class="route-tier-list">${renderActiveKeys(pool, poolIndex)}${tiers}</div>
    </article>`;
  }).join("");
  tree.setAttribute("aria-busy", "false");
}

function identityLabel(member) {
  return `${member.provider_id} / ${member.auth_alias} · ${member.interface_id} / ${member.model_id}`;
}

function renderActiveKeys(pool, index) {
  const policy = pool.active_keys;
  const strategy = pool.selection?.strategy || "priority";
  const modes = policy ? [["active_queue", "Sequential"], ["round_robin", "Round robin"], ["sticky", "Session sticky"]]
    : [[strategy, `Legacy (${strategy})`], ["active_queue", "Sequential with active keys"], ["round_robin", "Round robin with active keys"], ["sticky", "Session sticky with active keys"]];
  const cached = state.queues.get(state.activeServer);
  const runtime = cached?.data?.pools?.find(item => item.pool_id === pool.name && item.routing_group_id === state.activeServer);
  const members = policy?.members || [];
  const queue = runtime ? `<p class="hint">Runtime strategy: ${escapeHtml(runtime.strategy)}. Configured aliases: ${escapeHtml((runtime.configured_members || []).map(item => `${item.provider}/${item.alias}`).join(", ") || "none")}.</p>
    <h4>Current queue</h4><ol>${(runtime.order || []).map(member => `<li class="mono">${escapeHtml(identityLabel(member))}</li>`).join("") || "<li>No queued members</li>"}</ol>
    <h4>Held by queue policy</h4><ul>${(runtime.held || []).map((member, heldIndex) => `<li>${escapeHtml(identityLabel(member))} <button class="btn" data-action="release-key" data-pool="${index}" data-held="${heldIndex}" ${state.queueBusy ? "disabled" : ""}>Release to tail</button></li>`).join("") || "<li>No held members</li>"}</ul>
    <h4>Health cooldown (separate)</h4><ul>${(runtime.health || []).map(member => `<li>${escapeHtml(identityLabel(member))}: ${member.eligible ? "eligible" : "unavailable"}${member.reason ? ` — ${escapeHtml(member.reason)}` : ""}</li>`).join("") || "<li>No health restrictions reported</li>"}</ul>
    ${runtime.persistence_error ? `<p class="error">Durability error: ${escapeHtml(runtime.persistence_error)}</p>` : ""}`
    : `<p class="hint">${escapeHtml(cached?.error || (cached ? "No active-key runtime scope for this pool." : "Load queue to view the running listener. Unsaved edits are shown above."))}</p>`;
  return `<section class="route-tier" aria-label="Active keys for ${escapeHtml(pool.name)}">
    <h3>Active keys</h3><label>Selection <select data-action="selection-mode" data-pool="${index}" ${state.busy ? "disabled" : ""}>${modes.map(([value, label], modeIndex) => `<option value="${value}" ${modeIndex === 0 && !policy || policy && value === strategy ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    ${policy ? `<p class="hint">${members.length} active aliases. An empty list sends no requests through this pool.</p>
      <label>Retries after initial attempt <input type="number" min="0" step="1" value="${escapeHtml(policy.retries ?? 3)}" data-action="key-retries" data-pool="${index}"></label>
      <label>After failure <select data-action="key-failure" data-pool="${index}"><option value="hold" ${policy.on_failure !== "tail" ? "selected" : ""}>Hold until released</option><option value="tail" ${policy.on_failure === "tail" ? "selected" : ""}>Move to tail</option></select></label>
      ${members.map((member, memberIndex) => `<div class="route-member"><label>Provider <input value="${escapeHtml(member.provider)}" data-action="key-provider" data-pool="${index}" data-key="${memberIndex}"></label><label>Key alias <input value="${escapeHtml(member.alias)}" data-action="key-alias" data-pool="${index}" data-key="${memberIndex}"></label><button class="icon-btn danger" data-action="remove-key" data-pool="${index}" data-key="${memberIndex}" aria-label="Remove active alias">×</button></div>`).join("")}
      <button class="btn" data-action="add-key" data-pool="${index}">Add active alias</button>
      <button class="btn" data-action="legacy-keys" data-pool="${index}">Remove active-key policy</button>` : "<p class=\"hint\">Existing selection is preserved. Choose an active-key mode to configure an explicit subset.</p>"}
    <p class="hint">Release appends a held member to the tail. It does not clear health cooldown or retry an old request.</p>
    <button class="btn" data-action="load-queue" data-pool="${index}" ${state.queueBusy || state.busy ? "disabled" : ""}>${state.queueBusy ? "Loading queue…" : "Load queue"}</button>${queue}
  </section>`;
}

async function loadQueue(serverId = state.activeServer) {
  state.queueBusy = true; renderRoutes();
  try {
    const data = await api(`/api/routes/active-keys?server_id=${encodeURIComponent(serverId)}`);
    state.queues.set(serverId, { data });
  } catch (error) {
    state.queues.set(serverId, { error: error.message });
    announce("err", `Queue load failed: ${error.message}`);
  } finally { state.queueBusy = false; renderRoutes(); }
}

async function releaseKey(pool, heldIndex) {
  const serverId = state.activeServer;
  const runtime = state.queues.get(serverId)?.data?.pools?.find(item => item.pool_id === pool.name && item.routing_group_id === serverId);
  const member = runtime?.held?.[heldIndex];
  if (!member || state.queueBusy) return;
  state.queueBusy = true; renderRoutes();
  try {
    await api("/api/routes/active-keys/release", { method: "POST", body: JSON.stringify({ server_id: serverId, routing_group_id: runtime.routing_group_id, pool_id: runtime.pool_id, provider_id: member.provider_id, interface_id: member.interface_id, model_id: member.model_id, auth_alias: member.auth_alias }) });
    announce("ok", "Member released to queue tail. Health cooldown is unchanged.");
  } catch (error) { announce("err", `Release failed: ${error.message}`); }
  finally { await loadQueue(serverId); }
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
  if (button.dataset.action === "load-queue") { loadQueue(); return; }
  if (button.dataset.action === "release-key") { releaseKey(pool, Number(button.dataset.held)); return; }
  if (state.busy) return;
  if (button.dataset.action === "add-key") {
    pool.active_keys.members.push({ provider: pool.tiers[0]?.members[0]?.use.split("/")[0] || "", alias: "" });
    markDirty(); renderRoutes(); return;
  }
  if (button.dataset.action === "remove-key") { pool.active_keys.members.splice(Number(button.dataset.key), 1); markDirty(); renderRoutes(); return; }
  if (button.dataset.action === "legacy-keys") { pool.active_keys = null; pool.selection = { strategy: "priority" }; markDirty(); renderRoutes(); return; }
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
  const pool = poolFrom(event.target);
  if (!pool || state.busy) return;
  const action = event.target.dataset.action;
  if (action === "selection-mode") {
    // The first legacy option is a no-op; opting in starts with an explicit empty subset.
    if (!pool.active_keys && event.target.selectedIndex === 0) return;
    pool.selection = { ...(pool.selection || {}), strategy: event.target.value };
    pool.active_keys ||= { members: [], retries: 3, on_failure: "hold" };
    markDirty(); renderRoutes(); return;
  }
  if (action === "key-retries") {
    const retries = Number(event.target.value);
    if (event.target.value === "" || !Number.isSafeInteger(retries) || retries < 0) { announce("err", "Retries must be a nonnegative integer."); event.target.value = pool.active_keys.retries ?? 3; return; }
    pool.active_keys.retries = retries;
  } else if (action === "key-failure") pool.active_keys.on_failure = event.target.value;
  else if (action === "key-provider" || action === "key-alias") pool.active_keys.members[Number(event.target.dataset.key)][action === "key-provider" ? "provider" : "alias"] = event.target.value.trim();
  else if (action !== "weight") return;
  if (action !== "weight") { markDirty(); return; }
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
      state.queues.clear();
      await loadQueue();
      const queueError = state.queues.get(state.activeServer)?.error;
      if (queueError) announce("err", `Routes saved as revision #${result.revision_seq} and runtime reloaded, but queue status failed: ${queueError}`);
      else announce("ok", `Routes saved as revision #${result.revision_seq} and runtime reloaded.`);
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
