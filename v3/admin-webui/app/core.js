// RCC V3 Admin WebUI — shared request/UI primitives.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/core.js)

let adminToken = null;
let statusTimer = null;

/**
 * Store the local admin token obtained from `GET /api/admin/session`.
 * Mutating requests then carry it as the `x-routecodex-admin-token` header.
 */
export function setAdminToken(token) {
  adminToken = token || null;
}

export function getAdminToken() {
  return adminToken;
}

export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (adminToken) headers["x-routecodex-admin-token"] = adminToken;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.detail || body;
    const message = detail
      ? typeof detail === "string"
        ? detail
        : JSON.stringify(detail)
      : `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    if (body?.error_code) error.code = body.error_code;
    throw error;
  }
  return body;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (tag === "button") node.type = "button";
  if (className) node.className = className;
  if (text !== undefined && text !== null) {
    node.textContent = typeof text === "string" || typeof text === "number" ? text : String(text);
  }
  return node;
}

export function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

export function fmtMs(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return "—";
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function fmtCompact(n) {
  const value = Number(n || 0);
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}K`;
  return value.toLocaleString();
}

export function timeText(value) {
  if (!value) return "—";
  const d = new Date(value);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function badge(status) {
  const map = {
    running: ["ok", "running"],
    healthy: ["ok", "healthy"],
    ok: ["ok", "ok"],
    pass: ["ok", "pass"],
    warning: ["warn", "warning"],
    warn: ["warn", "warning"],
    failed: ["bad", "failed"],
    fail: ["bad", "fail"],
    down: ["bad", "down"],
    disabled: ["neutral", "disabled"],
    stopped: ["neutral", "stopped"],
  };
  const [kind, label] = map[status] || ["neutral", status || "unknown"];
  return el("span", `badge ${kind}`, label);
}

export async function reload() {
  const button = document.getElementById("reload-btn");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/reload", { method: "POST" });
    showStatus(result.ok ? "ok" : "err", result.detail);
  } catch (error) {
    showStatus("err", `reload failed: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Show a transient status message. Errors stay until dismissed; ok/warn auto-hide.
 */
export function showStatus(kind, message, options = {}) {
  const bar = document.getElementById("status-bar");
  if (!bar) return;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  bar.className = `status-bar ${kind}`;
  bar.textContent = "";
  const text = el("span", "status-bar-text", message ?? "");
  bar.appendChild(text);
  const close = el("button", "status-bar-close", "✕");
  close.setAttribute("aria-label", "Dismiss status message");
  close.addEventListener("click", hideStatus);
  bar.appendChild(close);
  bar.style.display = "flex";
  if (kind === "err") {
    bar.classList.remove("is-shaking");
    void bar.offsetWidth;
    bar.classList.add("is-shaking");
    setTimeout(() => bar.classList.remove("is-shaking"), 320);
  }
  const ttl = options.ttlMs ?? (kind === "err" ? 0 : 6000);
  if (ttl > 0) {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      hideStatus();
    }, ttl);
  }
}

export function hideStatus() {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  const bar = document.getElementById("status-bar");
  if (bar) bar.style.display = "none";
}

export function startAutoRefresh(loadFn, intervalMs = 10000) {
  let running = false;
  const refresh = async () => {
    if (running || document.hidden) return;
    running = true;
    try {
      await loadFn();
    } finally {
      running = false;
    }
  };
  const handle = setInterval(refresh, intervalMs);
  return () => clearInterval(handle);
}

/** Copy text to the clipboard, falling back to a temporary selection when the
 *  async clipboard API is unavailable (non-secure origins). */
export async function copyText(text) {
  const value = String(text ?? "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

/** Render a `label + value` definition pair used by environment/doctor panels. */
export function kv(label, value, options = {}) {
  const row = el("div", "kv");
  row.appendChild(el("span", "kv-key", label));
  const val = el("span", `kv-value${options.mono ? " mono" : ""}`, value ?? "—");
  if (options.title) val.title = options.title;
  row.appendChild(val);
  return row;
}
