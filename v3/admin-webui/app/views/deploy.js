// Deploy page: environment projection, doctor self-check and runtime lifecycle control.
// feature_id: v3.admin_observability_aggregation (v3/admin-webui/app/views/deploy.js)
import {
  api,
  badge,
  copyText,
  el,
  fmtMs,
  kv,
  showStatus,
  startAutoRefresh,
  timeText,
} from "../core.js";
import { confirmDialog } from "../form.js";
import { initShell, requireAdminSession } from "../shell.js";

initShell("deploy", {
  title: "Deploy",
  subtitle: "Runtime environment, doctor self-check and lifecycle control",
});

const environmentHost = document.getElementById("environment-cards");
const doctorHost = document.getElementById("doctor-panel");
const lifecycleHost = document.getElementById("lifecycle-panel");
const guideHost = document.getElementById("first-run-guide");

const state = { environment: null, doctor: null };

function card(title, rows, options = {}) {
  const panel = el("section", "panel deploy-card amb-surface amb-elevation-1");
  const head = el("div", "deploy-card-head");
  head.appendChild(el("h3", null, title));
  if (options.badge) head.appendChild(options.badge);
  panel.appendChild(head);
  const body = el("div", "deploy-card-body");
  for (const row of rows) body.appendChild(row);
  panel.appendChild(body);
  return panel;
}

function hashRow(label, value) {
  const row = kv(label, value ? `${value.slice(0, 16)}…` : "—", {
    mono: true,
    title: value || undefined,
  });
  if (value) {
    const valueNode = row.querySelector(".kv-value");
    const copy = el("button", "link", "copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        const copied = await copyText(value);
        showStatus(copied ? "ok" : "warn", copied ? `${label} copied` : "clipboard unavailable");
      } catch (error) {
        showStatus("warn", `clipboard unavailable: ${error.message}`);
      }
    });
    valueNode.appendChild(document.createTextNode(" "));
    valueNode.appendChild(copy);
  }
  return row;
}

function driftBadge(environment) {
  const installed = environment?.binary?.version || null;
  const listeners = environment?.listeners || [];
  if (!installed) return el("span", "badge neutral", "version unknown");
  if (!listeners.length) return el("span", "badge neutral", "no listener");
  const drifted = listeners.filter(
    (listener) => listener.build_version && listener.build_version !== installed,
  );
  if (drifted.length) {
    return el("span", "badge bad", `drift: ${drifted.length} listener(s)`);
  }
  const unknown = listeners.filter((listener) => !listener.build_version);
  if (unknown.length) return el("span", "badge warn", `${unknown.length} listener(s) silent`);
  return el("span", "badge ok", "build_version in sync");
}

function listenerBadge(listener) {
  if (listener.reachable) return badge("ok");
  return badge("fail");
}

function renderEnvironment(environment) {
  environmentHost.textContent = "";
  environmentHost.appendChild(
    el(
      "div",
      "deploy-note muted tiny",
      `projection generated ${timeText(environment.generated_at_epoch_ms)} · refreshes every 15s`,
    ),
  );
  const binary = environment.binary || {};
  environmentHost.appendChild(
    card(
      "Runtime binary",
      [
        kv("version", binary.version || "—", { mono: true }),
        kv("path", binary.path || "—", { mono: true, title: binary.path }),
        hashRow("sha256", binary.sha256),
        kv("size", binary.size_bytes === null || binary.size_bytes === undefined ? "—" : `${binary.size_bytes} B`),
        binary.error ? kv("read error", binary.error, { mono: true }) : null,
      ].filter(Boolean),
      { badge: driftBadge(environment) },
    ),
  );

  const config = environment.config || {};
  environmentHost.appendChild(
    card("Config", [
      kv("path", config.path || "—", { mono: true, title: config.path }),
      hashRow("sha256", config.sha256),
      kv("servers", config.server_count ?? "—"),
      kv("providers", config.provider_count ?? "—"),
      kv("route groups", config.route_group_count ?? "—"),
      kv("debug log file", config.debug_log_file || "—", { mono: true }),
      config.error ? kv("compile", config.error, { mono: true }) : null,
    ].filter(Boolean)),
  );

  const instance = environment.instance;
  const instanceRows = instance
    ? [
        kv("instance id", instance.instance_id, { mono: true }),
        kv("state", instance.state || "—"),
        kv("pid", instance.pid ?? "—", { mono: true }),
        kv("pid alive", instance.pid_alive === null || instance.pid_alive === undefined ? "—" : String(instance.pid_alive)),
        kv("start nonce", instance.start_nonce || "—", { mono: true }),
        kv("started at", instance.started_at_epoch_ms ? new Date(instance.started_at_epoch_ms).toLocaleString() : "—"),
        kv("status updated", instance.status_updated_at_epoch_ms ? timeText(instance.status_updated_at_epoch_ms) : "—"),
        kv("config match", instance.config_match ? "yes" : "no"),
        kv("state root", instance.state_root || "—", { mono: true, title: instance.state_root }),
        kv(
          "listeners",
          instance.listeners?.length
            ? instance.listeners.map((listener) => `${listener.server_id}:${listener.port}`).join(", ")
            : "—",
          { mono: true },
        ),
        ...(instance.errors || []).map((error) => kv("record error", error, { mono: true })),
      ]
    : [
        kv("instance", "no managed instance record", { mono: false }),
        kv(
          "known instances",
          environment.instances?.length ? environment.instances.join(", ") : "none",
          { mono: true },
        ),
      ];
  environmentHost.appendChild(
    card("Managed instance", instanceRows, {
      badge: instance && instance.state === "running" && instance.pid_alive ? badge("running") : badge(instance?.state || "stopped"),
    }),
  );

  const listenerRows = [];
  for (const listener of environment.listeners || []) {
    const row = kv(
      `${listener.server_id}:${listener.port}`,
      listener.reachable
        ? `health ok · build_version ${listener.build_version || "—"} · manifest ${listener.manifest_version ?? "—"}`
        : `unreachable · ${listener.error || "unknown error"}`,
      { mono: true, title: listener.url },
    );
    row.querySelector(".kv-value").prepend(listenerBadge(listener));
    listenerRows.push(row);
  }
  environmentHost.appendChild(
    card(
      "Listeners",
      listenerRows.length ? listenerRows : [kv("listeners", "no enabled listener", {})],
    ),
  );

  const logRows = (environment.logs || []).map((log) =>
    kv(log.path, log.exists ? `${log.size_bytes} B` : "absent", { mono: true, title: log.path }),
  );
  environmentHost.appendChild(card("Logs", logRows.length ? logRows : [kv("logs", "—", {})]));

  const sidecar = environment.hooks_sidecar;
  environmentHost.appendChild(
    card("Admin & hooks", [
      kv(
        "admin listener",
        environment.admin?.enabled ? `${environment.admin.bind}:${environment.admin.port}` : "disabled",
        { mono: true },
      ),
      kv("admin source", environment.admin?.source || "—", { mono: true }),
      kv(
        "hooks sidecar pid",
        sidecar ? (sidecar.pid_file_present ? "present" : "absent") : "—",
        { mono: true, title: sidecar?.pid_file },
      ),
      kv(
        "hooks sidecar socket",
        sidecar ? (sidecar.socket_present ? "present" : "absent") : "—",
        { mono: true, title: sidecar?.socket_file },
      ),
    ]),
  );
}

function renderFirstRunGuide(environment) {
  if (!guideHost) return;
  const providers = environment?.config?.provider_count;
  const hasProvider = typeof providers === "number" && providers > 0;
  guideHost.hidden = hasProvider;
  guideHost.textContent = "";
  if (hasProvider) return;
  guideHost.appendChild(el("h3", null, "First run"));
  guideHost.appendChild(
    el(
      "p",
      null,
      "No provider is compiled into the served config yet. Connect one, route traffic to it, then apply the config.",
    ),
  );
  const steps = el("ol", "wizard-steps");
  const items = [
    ["Add a provider", "/providers.html", "Providers page: validate the base URL and auth handle, then save."],
    ["Route to it", "/routes.html", "Routes page: put the provider model in a tier."],
    ["Reload config", null, "Reload config below validates and restarts the served config path."],
    ["Verify", null, "Re-run the doctor check until every item is pass or an explained warn."],
  ];
  for (const [title, href, detail] of items) {
    const step = el("li", "wizard-step");
    if (href) {
      const link = el("a", null, title);
      link.href = href;
      step.appendChild(link);
    } else {
      step.appendChild(el("strong", null, title));
    }
    step.appendChild(el("span", "ff-hint", detail));
    steps.appendChild(step);
  }
  guideHost.appendChild(steps);
}

function renderDoctor(report) {
  doctorHost.textContent = "";
  const head = el("div", "deploy-card-head");
  head.appendChild(el("h3", null, "Doctor"));
  if (report.status) head.appendChild(badge(report.status));
  const rerun = el("button", "btn", "Re-run");
  rerun.type = "button";
  rerun.addEventListener("click", () => runDoctor());
  head.appendChild(rerun);
  doctorHost.appendChild(head);

  const items = report.items || [];
  if (!items.length) {
    doctorHost.appendChild(
      el("div", "empty-state", "Doctor has not run yet — press Re-run to check this deployment."),
    );
    return;
  }

  const table = el("table", "table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const label of ["Check", "Status", "Detail", "Remediation"]) {
    headRow.appendChild(el("th", null, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const item of items) {
    const row = el("tr");
    row.appendChild(el("td", "mono", item.id));
    const statusCell = el("td");
    statusCell.appendChild(badge(item.status));
    row.appendChild(statusCell);
    row.appendChild(el("td", null, item.detail));
    row.appendChild(el("td", "muted", item.remediation || "—"));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  doctorHost.appendChild(table);
}

function renderLifecycleShell() {
  lifecycleHost.textContent = "";
  const actions = el("div", "actions");
  const restart = el("button", "btn primary", "Restart runtime");
  restart.type = "button";
  restart.addEventListener("click", () => restartRuntime());
  const reload = el("button", "btn", "Reload config");
  reload.type = "button";
  reload.addEventListener("click", () => reloadConfig());
  actions.appendChild(restart);
  actions.appendChild(reload);
  lifecycleHost.appendChild(actions);
  lifecycleHost.appendChild(
    el(
      "p",
      "ff-hint",
      "Restart delegates to `rccv3 restart -c <served config>` and shows the raw stdout/stderr tail. Reload validates the config before restarting.",
    ),
  );
  const terminal = el("pre", "terminal");
  terminal.id = "lifecycle-output";
  terminal.appendChild(el("div", "terminal-line dim", "no lifecycle command run yet"));
  lifecycleHost.appendChild(terminal);
}

function appendTerminalLine(className, text) {
  const terminal = document.getElementById("lifecycle-output");
  if (!terminal || !text) return;
  terminal.appendChild(el("div", `terminal-line${className ? ` ${className}` : ""}`, text));
}

function renderLifecycleResult(label, result) {
  const terminal = document.getElementById("lifecycle-output");
  if (!terminal) return;
  terminal.textContent = "";
  const exit = result.exit_code === null || result.exit_code === undefined ? "n/a" : result.exit_code;
  const duration = result.duration_ms === undefined ? "" : ` (${fmtMs(result.duration_ms)})`;
  appendTerminalLine(
    result.ok ? "ok" : "fail",
    `${label}: ${result.ok ? "ok" : "failed"} · exit ${exit}${duration}`,
  );
  if (result.command) appendTerminalLine("dim", result.command);
  if (result.error) appendTerminalLine("fail", result.error);
  for (const line of String(result.stdout_tail || "").split("\n")) {
    if (line.trim()) appendTerminalLine(null, line);
  }
  for (const line of String(result.stderr_tail || "").split("\n")) {
    if (line.trim()) appendTerminalLine("fail", line);
  }
}

async function loadEnvironment() {
  try {
    const environment = await api("/api/environment");
    state.environment = environment;
    renderEnvironment(environment);
    renderFirstRunGuide(environment);
  } catch (error) {
    environmentHost.textContent = "";
    environmentHost.appendChild(el("div", "empty-state", `environment unavailable: ${error.message}`));
  }
}

async function runDoctor() {
  try {
    await requireAdminSession();
    const report = await api("/api/environment/doctor", { method: "POST" });
    state.doctor = report;
    renderDoctor(report);
    showStatus(report.status === "pass" ? "ok" : "warn", `doctor finished: ${report.status}`);
  } catch (error) {
    showStatus("err", `doctor failed: ${error.message}`);
  }
}

async function restartRuntime() {
  const accepted = await confirmDialog({
    title: "Restart runtime",
    message: "Restart the managed runtime for the served config path? Active requests will be interrupted.",
    confirmLabel: "Restart",
  });
  if (!accepted) return;
  try {
    await requireAdminSession();
    const result = await api("/api/runtime/restart", { method: "POST" });
    renderLifecycleResult("restart", result);
    showStatus(result.ok ? "ok" : "err", result.ok ? "runtime restarted" : result.error || "restart failed");
    await loadEnvironment();
  } catch (error) {
    showStatus("err", `restart failed: ${error.message}`);
  }
}

async function reloadConfig() {
  const accepted = await confirmDialog({
    title: "Reload config",
    message: "Validate the served config and restart the runtime with the new snapshot?",
    confirmLabel: "Reload",
  });
  if (!accepted) return;
  try {
    await requireAdminSession();
    const result = await api("/api/reload", { method: "POST" });
    renderLifecycleResult("reload", { ...result, exit_code: result.ok ? 0 : undefined });
    showStatus(result.ok ? "ok" : "err", result.detail || "reload finished");
    await loadEnvironment();
  } catch (error) {
    renderLifecycleResult("reload", { ok: false, error: error.message });
    showStatus("err", `reload failed: ${error.message}`);
  }
}

document.getElementById("refresh-btn")?.addEventListener("click", async () => {
  await loadEnvironment();
  await runDoctor();
});
document.getElementById("deploy-reload-btn")?.addEventListener("click", () => reloadConfig());

renderLifecycleShell();
renderDoctor({ items: [] });
loadEnvironment();
startAutoRefresh(loadEnvironment, 15000);
