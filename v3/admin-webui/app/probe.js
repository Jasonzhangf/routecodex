// Streaming probe terminal for the provider connectivity ladder.
// Consumes the SSE stage events emitted by POST /api/providers/probe (candidate) and
// POST /api/providers/:id/probe (existing provider).
//
// The terminal renders one row per ladder stage plus the raw evidence stream, so a failed
// probe shows exactly which stage failed and what the runtime observed. Zero-build ES
// module: no bundler, no npm runtime deps.
// feature_id: v3.admin_provider_onboarding (v3/admin-webui/app/probe.js)

import { copyText, el, fmtMs, showStatus } from "./core.js";
import { requireAdminSession } from "./shell.js";

export const PROBE_STAGES = ["l1_contract", "l2_reachability_auth", "l3_semantic"];

export const PROBE_STAGE_LABELS = {
  l1_contract: "L1 contract (offline candidate validation)",
  l2_reachability_auth: "L2 reachability + auth",
  l3_semantic: "L3 HTTP status probe (2xx)",
};

/** Normalise a probe stage id to the ladder order used for row rendering. */
export function probeStageLabel(stage) {
  return PROBE_STAGE_LABELS[stage] || stage;
}

function errorText(error) {
  if (!error) return "";
  const code = error.error_code ? `${error.error_code}: ` : "";
  const detail = error.detail;
  if (detail === undefined || detail === null) return code.replace(/: $/, "");
  const message =
    typeof detail === "string"
      ? detail
      : detail.message || detail.error || JSON.stringify(detail);
  return `${code}${message}`;
}

/**
 * Create a probe terminal.
 *
 * options: { onComplete(payload) }
 * returns: { element, run(request), retry(), clear(), copy(), text(), isRunning(), result() }
 *
 * request: { id?, config?, model?, authAlias?, stages? }
 */
export function createProbeTerminal(options = {}) {
  const stageRows = el("div", "probe-stage-rows");
  const terminal = el("div", "terminal");
  terminal.setAttribute("role", "log");
  terminal.setAttribute("aria-live", "polite");
  terminal.setAttribute("aria-label", "Probe evidence stream");

  const copyBtn = el("button", "btn", "Copy evidence");
  copyBtn.type = "button";
  const retryBtn = el("button", "btn", "Retry");
  retryBtn.type = "button";
  retryBtn.disabled = true;
  const actions = el("div", "actions");
  actions.appendChild(copyBtn);
  actions.appendChild(retryBtn);

  const element = el("div", "probe");
  element.appendChild(stageRows);
  element.appendChild(terminal);
  element.appendChild(actions);

  const rows = new Map();
  const raw = [];
  let lastRequest = null;
  let running = false;
  let completed = null;

  function append(kind, text) {
    raw.push(text);
    terminal.appendChild(el("span", `terminal-line ${kind}`, text));
    terminal.scrollTop = terminal.scrollHeight;
  }

  function clear() {
    terminal.textContent = "";
    stageRows.textContent = "";
    rows.clear();
    raw.length = 0;
    completed = null;
  }

  function rowFor(stage, label) {
    let row = rows.get(stage);
    if (row) return row;
    const wrapper = el("div", "row");
    const name = el("span", "name", label || probeStageLabel(stage));
    const meta = el("span", "meta", "pending");
    wrapper.appendChild(name);
    wrapper.appendChild(meta);
    stageRows.appendChild(wrapper);
    row = { wrapper, name, meta };
    rows.set(stage, row);
    return row;
  }

  function setRowState(stage, label, kind, text) {
    const row = rowFor(stage, label);
    row.meta.textContent = text;
    row.meta.className = `meta ${kind === "ok" ? "ok" : kind === "fail" ? "fail" : ""}`.trim();
  }

  function dispatch(payload) {
    const stage = payload.stage;
    switch (payload.event) {
      case "stage_started": {
        setRowState(stage, payload.label, "running", "running…");
        append("stage", `▶ [${payload.index}/${payload.total}] ${payload.label} (${stage})`);
        break;
      }
      case "evidence": {
        append("evidence", `  ${payload.kind}: ${JSON.stringify(payload.data)}`);
        break;
      }
      case "stage_result": {
        setRowState(stage, payload.label, "ok", `ok · ${fmtMs(payload.duration_ms)}`);
        append("ok", `✔ ${payload.label} ok in ${fmtMs(payload.duration_ms)}`);
        break;
      }
      case "stage_failed": {
        const detail = errorText(payload.error);
        setRowState(stage, payload.label, "fail", `failed · ${detail || "no detail"}`);
        append("fail", `✖ ${payload.label} failed in ${fmtMs(payload.duration_ms)} · ${detail}`);
        break;
      }
      case "probe_complete": {
        completed = payload;
        append(
          payload.ok ? "ok" : "fail",
          `probe_complete: ok=${payload.ok} total=${fmtMs(payload.duration_ms)} probe_id=${payload.probe_id}`,
        );
        if (typeof options.onComplete === "function") options.onComplete(payload);
        break;
      }
      default: {
        append("dim", JSON.stringify(payload));
      }
    }
  }

  function handleFrame(frame) {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const text = dataLines.join("\n");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      append("dim", text);
      return;
    }
    dispatch(payload);
  }

  async function run(request) {
    if (running) return completed;
    lastRequest = request;
    clear();
    running = true;
    retryBtn.disabled = true;
    const target = request.id ? `provider ${request.id}` : "candidate";
    append("dim", `# probe ${target} at ${new Date().toLocaleTimeString()}`);
    if (request.stages && request.stages.length) {
      append("dim", `# stages: ${request.stages.join(", ")}`);
    }

    const url = request.id
      ? `/api/providers/${encodeURIComponent(request.id)}/probe`
      : "/api/providers/probe";
    const body = {
      model: request.model || null,
      auth_alias: request.authAlias || null,
      stages: request.stages && request.stages.length ? request.stages : null,
    };
    if (request.config) body.config = request.config;

    let response;
    try {
      const token = await requireAdminSession();
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-routecodex-admin-token": token,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      append("fail", `probe request failed: ${error.message}`);
      showStatus("err", `probe failed: ${error.message}`);
      running = false;
      retryBtn.disabled = false;
      return null;
    }

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        detail = payload.error || payload.error_code || detail;
      } catch {
        /* keep the status line */
      }
      append("fail", `probe rejected (${response.status}): ${detail}`);
      showStatus("err", `probe rejected: ${detail}`);
      running = false;
      retryBtn.disabled = false;
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          handleFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) handleFrame(buffer);
    } catch (error) {
      append("fail", `probe stream interrupted: ${error.message}`);
    } finally {
      running = false;
      retryBtn.disabled = false;
    }
    return completed;
  }

  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(raw.join("\n"));
    showStatus(ok ? "ok" : "warn", ok ? "probe evidence copied" : "clipboard unavailable");
  });

  retryBtn.addEventListener("click", () => {
    if (lastRequest) run(lastRequest);
  });

  return {
    element,
    run,
    retry() {
      return lastRequest ? run(lastRequest) : Promise.resolve(null);
    },
    clear,
    copy: () => copyText(raw.join("\n")),
    text: () => raw.join("\n"),
    isRunning: () => running,
    result: () => completed,
  };
}
