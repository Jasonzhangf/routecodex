#!/usr/bin/env node

import readline from "node:readline";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const WHITE = `${ESC}37m`;

const PORTS = [5520, 5555, 4444];
const ROUTES = ["router-relay", "router-direct"];
const PROVIDERS = ["openai/gpt-5.5", "minimax/MiniMax-M2", "deepseek/deepseek-v4"];
const HISTORY_LIMIT = 160;
const LIVE_PANEL_ROWS = 7;
const TICK_MS = 300;

const state = {
  nextRequest: 1840,
  nextPort: 0,
  requests: new Map(),
  history: [],
  scroll: 0,
  historyMode: "follow_latest",
  newCount: 0,
  paused: false,
  speed: 1,
  filter: "all",
  timer: null,
  renderPending: false,
};

function now() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorForStatus(status) {
  if (status === "completed") return GREEN;
  if (status === "failed") return RED;
  if (status === "switching") return YELLOW;
  return CYAN;
}

function visible(item) {
  if (state.filter === "all") return true;
  if (state.filter === "error") return item.status === "failed";
  if (state.filter.startsWith("port=")) return String(item.port) === state.filter.slice(5);
  if (state.filter.startsWith("provider=")) return item.provider.includes(state.filter.slice(9));
  if (state.filter.startsWith("route=")) return item.route === state.filter.slice(6);
  return true;
}

function createRequest() {
  const requestNumber = state.nextRequest++;
  const request = {
    id: `#${requestNumber}`,
    port: PORTS[state.nextPort++ % PORTS.length],
    route: ROUTES[requestNumber % ROUTES.length],
    provider: PROVIDERS[requestNumber % PROVIDERS.length],
    sessionId: `sess-${String(requestNumber).padStart(4, "0")}`,
    model: PROVIDERS[requestNumber % PROVIDERS.length].split("/").at(-1),
    status: "routing",
    elapsed: 0,
    started: Date.now(),
    attempts: 1,
    responseStatus: "pending",
    responseBytes: 0,
    reason: "pending",
    usage: { inputTokens: 420 + (requestNumber % 80), outputTokens: 0 },
    terminalAt: Date.now() + (1_800 + (state.nextRequest % 5) * 700) / state.speed,
  };
  state.requests.set(request.id, request);
}

function finishRequest(request) {
  const failed = Number(request.id.slice(1)) % 7 === 0;
  request.status = failed ? "failed" : "completed";
  request.elapsed = (Date.now() - request.started) / 1000;
  request.statusCode = failed ? 503 : 200;
  request.reason = failed ? "provider_unavailable" : "stop";
  request.finishReason = request.reason;
  request.responseStatus = failed ? "error" : "completed";
  request.responseBytes = failed ? 0 : 180 + (Number(request.id.slice(1)) % 220);
  request.usage = {
    inputTokens: 420 + (Number(request.id.slice(1)) % 80),
    outputTokens: failed ? 0 : 60 + (Number(request.id.slice(1)) % 120),
  };
  state.history.push({ ...request, time: now() });
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  if (state.historyMode === "history_browsing" && visible(request)) {
    state.scroll += 1;
    state.newCount += 1;
  }
  state.requests.delete(request.id);
}

function advanceRequests() {
  if (state.paused) return;
  for (const request of state.requests.values()) {
    request.elapsed = (Date.now() - request.started) / 1000;
    if (request.status === "routing" && request.elapsed > 0.5) request.status = "streaming";
    if (request.status === "streaming") {
      request.responseStatus = "streaming";
      request.responseBytes = Math.floor(request.elapsed * 96);
      request.usage.outputTokens = Math.floor(request.elapsed * 32);
    }
    if (request.status === "streaming" && request.elapsed > 1.4 && Number(request.id.slice(1)) % 5 === 0) {
      request.status = "switching";
      request.attempts = 2;
      request.provider = PROVIDERS[(Number(request.id.slice(1)) + 1) % PROVIDERS.length];
      request.model = request.provider.split("/").at(-1);
      request.responseStatus = "retrying";
    }
    if (Date.now() >= request.terminalAt) finishRequest(request);
  }
  if (state.nextRequest % 3 === 0 && state.requests.size < 6) createRequest();
}

function truncate(value, width) {
  if (width <= 1) return "…";
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, width - 1)}…`;
}

function line(text, width) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.length <= width) return text + " ".repeat(width - clean.length);
  return truncate(clean, width);
}

function terminalSize() {
  const columns = Number.isInteger(process.stdout.columns) && process.stdout.columns > 0
    ? process.stdout.columns
    : 100;
  const rows = Number.isInteger(process.stdout.rows) && process.stdout.rows > 0
    ? process.stdout.rows
    : 24;
  return { columns, rows };
}

export function calculateLayout(height, headerRows = 2) {
  const safeHeight = Math.max(0, height);
  const visibleHeaderRows = Math.min(headerRows, safeHeight);
  const liveRows = Math.min(LIVE_PANEL_ROWS, Math.max(0, safeHeight - visibleHeaderRows));
  return {
    headerRows: visibleHeaderRows,
    historyRows: Math.max(0, safeHeight - visibleHeaderRows - liveRows),
    liveRows,
  };
}

function compactDetails(item) {
  return `sid=${item.sessionId} rt=${item.route.replace("router-", "")} pv=${item.provider} rsn=${item.reason} u=${item.usage.inputTokens}/${item.usage.outputTokens}`;
}

function historyLines(width, visibleRows) {
  const items = state.history.filter(visible);
  const maxOffset = Math.max(0, items.length - 1);
  state.scroll = clamp(state.scroll, 0, maxOffset);
  const end = items.length - state.scroll;
  const start = Math.max(0, end - visibleRows);
  return items.slice(start, end).map((item) => {
    const status = `${colorForStatus(item.status)}${item.status}${RESET}`;
    const error = item.status === "failed" ? ` error=${item.finishReason}` : "";
    if (width < 100) {
      return line(`${DIM}${item.time}${RESET} ${item.id} p${item.port} ${status} ${item.statusCode} ${item.elapsed.toFixed(1)}s ${item.responseStatus}/${item.responseBytes}B ${compactDetails(item)}${error}`, width);
    }
    return line(`${DIM}${item.time}${RESET} ${item.port} ${item.id} ${status} ${item.route} ${item.provider} model=${item.model} ${item.statusCode} ${item.elapsed.toFixed(1)}s attempts=${item.attempts} response=${item.responseStatus} bytes=${item.responseBytes} sid=${item.sessionId} reason=${item.reason} usage=${item.usage.inputTokens}/${item.usage.outputTokens}${error}`, width);
  });
}

function liveLines(width, maxRows) {
  if (maxRows <= 0) return [];
  const active = [...state.requests.values()].filter((item) => {
    if (state.filter === "all") return true;
    if (state.filter.startsWith("port=")) return String(item.port) === state.filter.slice(5);
    if (state.filter.startsWith("provider=")) return item.provider.includes(state.filter.slice(9));
    if (state.filter.startsWith("route=")) return item.route === state.filter.slice(6);
    return state.filter === "error" ? item.status === "failed" : true;
  });
  const compact = width < 100;
  const rows = [
    `${CYAN}LIVE${RESET} ${active.length} active  ${state.filter} ${state.speed}x ${state.paused ? `${YELLOW}PAUSED${RESET}` : ""}`,
    compact
      ? `${DIM}REQ TIME STATE RESPONSE / session model reason usage${RESET}`
      : `${DIM}${"PORT".padEnd(6)}${"REQ".padEnd(8)}${"TIME".padEnd(9)}${"ROUTE".padEnd(17)}${"PROVIDER".padEnd(27)}${"STATE".padEnd(13)}RESPONSE${RESET}`,
  ];
  const availableRows = Math.max(0, maxRows - rows.length - 1);
  const activeLines = [];
  for (const item of active.slice(0, compact ? Math.floor(availableRows / 2) : availableRows)) {
    if (compact) {
      activeLines.push(line(
        `${item.id} p${item.port} ${item.elapsed.toFixed(1)}s ${item.status} ${item.responseStatus}/${item.responseBytes}B`,
        width,
      ));
      activeLines.push(line(`  ${compactDetails(item)} ${item.status === "failed" ? `error=${item.finishReason}` : ""}`, width));
    } else {
      activeLines.push(line(
        `${item.port}`.padEnd(6)
          + `${item.id}`.padEnd(8)
          + `${item.elapsed.toFixed(1)}s`.padEnd(9)
          + `${item.route}`.padEnd(17)
          + `${item.provider}`.padEnd(27)
          + `${item.status}`.padEnd(13)
          + `${item.responseStatus} ${item.responseBytes}B sid=${item.sessionId} model=${item.model} reason=${item.reason} usage=${item.usage.inputTokens}/${item.usage.outputTokens}`,
        width,
      ));
    }
  }
  rows.push(...activeLines.slice(0, availableRows));
  while (rows.length < maxRows - 1) rows.push("");
  const historyState = state.historyMode === "history_browsing"
    ? `history=browsing offset=${state.scroll} new=${state.newCount} Esc=latest`
    : "history=latest follow";
  rows.push(`${DIM}q quit  ↑/↓ scroll history  ${historyState}  space pause  +/- speed  f filter${RESET}`);
  return rows.slice(-maxRows).map((item) => line(item, width));
}

function render() {
  if (state.renderPending) return;
  state.renderPending = true;
  setImmediate(() => {
    state.renderPending = false;
    const { columns: width, rows: height } = terminalSize();
    const header = [
      line(`${WHITE}RouteCodex TUI simulator${RESET}  ${DIM}${now()}  history=${state.history.filter(visible).length}  terminal=${width}x${height}${RESET}`, width),
      line(`${DIM}${width < 100 ? "Narrow mode: compact two-line live rows." : "History scrolls above; live requests stay fixed at bottom."}${RESET}`, width),
    ].slice(0, height);
    const layout = calculateLayout(height, header.length);
    const bodyRows = layout.historyRows;
    const history = historyLines(width, bodyRows);
    const body = history.slice(-bodyRows);
    while (body.length < bodyRows) body.unshift("");
    const output = [...header, ...body, ...liveLines(width, layout.liveRows)].join("\n");
    process.stdout.write(`${ESC}H${ESC}J${output}${ESC}${height};1H`);
  });
}

function cycleFilter() {
  const filters = ["all", "port=5520", "provider=minimax", "route=router-relay", "error"];
  state.filter = filters[(filters.indexOf(state.filter) + 1) % filters.length];
  state.scroll = 0;
  state.historyMode = "follow_latest";
  state.newCount = 0;
}

function followLatest() {
  state.historyMode = "follow_latest";
  state.scroll = 0;
  state.newCount = 0;
}

function cleanup() {
  if (state.timer) clearInterval(state.timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${RESET}${ESC}?25h${ESC}0m\n`);
}

if (!process.env.TUI_SIMULATOR_NO_START) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("tui-simulator requires an interactive TTY");
    process.exit(2);
  }

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (_input, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    cleanup();
    process.exit(0);
  }
  if (key.name === "up") {
    state.historyMode = "history_browsing";
    state.scroll += 1;
  }
  if (key.name === "down" && state.historyMode === "history_browsing") {
    state.scroll = Math.max(0, state.scroll - 1);
  }
  if (key.name === "escape") followLatest();
  if (key.name === "space") state.paused = !state.paused;
  if (key.name === "r") followLatest();
  if (key.name === "f") cycleFilter();
  if (key.sequence === "+" || key.sequence === "=") state.speed = Math.min(4, state.speed + 0.5);
  if (key.sequence === "-") state.speed = Math.max(0.5, state.speed - 0.5);
  render();
});

process.on("SIGWINCH", render);
process.on("exit", cleanup);

for (let index = 0; index < 5; index += 1) createRequest();
state.timer = setInterval(() => {
  advanceRequests();
  if (state.requests.size < 3 && !state.paused) createRequest();
  render();
}, TICK_MS);
render();
}
