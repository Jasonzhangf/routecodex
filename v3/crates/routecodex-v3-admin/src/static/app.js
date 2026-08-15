// RCC V3 Config Management WebUI — shared logic
async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && (body.error || body.detail || JSON.stringify(body)) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtMs(value) {
  if (value === undefined || value === null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function badge(status) {
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

async function reload() {
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

function showStatus(kind, message) {
  const bar = document.getElementById("status-bar");
  if (!bar) return;
  bar.className = `status-bar ${kind}`;
  bar.textContent = message;
  bar.style.display = "block";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
