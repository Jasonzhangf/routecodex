// RCC V3 Admin WebUI — shared request/UI primitives.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/core.js)

export async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.detail || body;
    const message = detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : `${response.status} ${response.statusText}`;
    const error = new Error(message);
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
    warning: ["warn", "warning"],
    warn: ["warn", "warning"],
    down: ["bad", "down"],
    failed: ["bad", "failed"],
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

export function showStatus(kind, message) {
  const bar = document.getElementById("status-bar");
  if (!bar) return;
  bar.className = `status-bar ${kind}`;
  bar.textContent = message;
  bar.style.display = "block";
  if (kind === "err") {
    bar.classList.remove("is-shaking");
    void bar.offsetWidth;
    bar.classList.add("is-shaking");
    setTimeout(() => bar.classList.remove("is-shaking"), 320);
  }
}

export function hideStatus() {
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
  setInterval(refresh, intervalMs);
}
