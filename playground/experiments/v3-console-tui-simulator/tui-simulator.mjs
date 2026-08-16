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
  const request = {
    id: `#${state.nextRequest++}`,
    port: PORTS[state.nextPort++ % PORTS.length],
    route: ROUTES[state.nextRequest % ROUTES.length],
    provider: PROVIDERS[state.nextRequest % PROVIDERS.length],
    status: "routing",
    elapsed: 0,
    started: Date.now(),
    attempts: 1,
    output: 0,
    terminalAt: Date.now() + (1_800 + (state.nextRequest % 5) * 700) / state.speed,
  };
  state.requests.set(request.id, request);
}

function finishRequest(request) {
  const failed = Number(request.id.slice(1)) % 7 === 0;
  request.status = failed ? "failed" : "completed";
  request.elapsed = (Date.now() - request.started) / 1000;
  request.statusCode = failed ? 503 : 200;
  request.finishReason = failed ? "provider_unavailable" : "stop";
  request.output = failed ? 0 : 180 + (Number(request.id.slice(1)) % 220);
  state.history.push({ ...request, time: now() });
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.requests.delete(request.id);
}

function advanceRequests() {
  if (state.paused) return;
  for (const request of state.requests.values()) {
    request.elapsed = (Date.now() - request.started) / 1000;
    if (request.status === "routing" && request.elapsed > 0.5) request.status = "streaming";
    if (request.status === "streaming" && request.elapsed > 1.4 && Number(request.id.slice(1)) % 5 === 0) {
      request.status = "switching";
      request.attempts = 2;
      request.provider = PROVIDERS[(Number(request.id.slice(1)) + 1) % PROVIDERS.length];
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

function historyLines(width) {
  const items = state.history.filter(visible);
  const maxOffset = Math.max(0, items.length - 1);
  state.scroll = clamp(state.scroll, 0, maxOffset);
  const end = items.length - state.scroll;
  const start = Math.max(0, end - Math.max(1, process.stdout.rows - LIVE_PANEL_ROWS - 5));
  return items.slice(start, end).map((item) => {
    const status = `${colorForStatus(item.status)}${item.status}${RESET}`;
    const error = item.status === "failed" ? ` error=${item.finishReason}` : "";
    return line(`${DIM}${item.time}${RESET} ${item.port} ${item.id} ${status} ${item.route} ${item.provider} ${item.statusCode} ${item.elapsed.toFixed(1)}s attempts=${item.attempts}${error}`, width);
  });
}

function liveLines(width) {
  const active = [...state.requests.values()].filter((item) => {
    if (state.filter === "all") return true;
    if (state.filter.startsWith("port=")) return String(item.port) === state.filter.slice(5);
    if (state.filter.startsWith("provider=")) return item.provider.includes(state.filter.slice(9));
    if (state.filter.startsWith("route=")) return item.route === state.filter.slice(6);
    return state.filter === "error" ? item.status === "failed" : true;
  });
  const rows = [
    `${CYAN}LIVE${RESET} active=${active.length} filter=${state.filter} speed=${state.speed}x ${state.paused ? `${YELLOW}PAUSED${RESET}` : ""}`,
    `${DIM}${"PORT".padEnd(6)}${"REQ".padEnd(8)}${"TIME".padEnd(9)}${"ROUTE".padEnd(17)}${"PROVIDER".padEnd(27)}STATE${RESET}`,
  ];
  for (const item of active.slice(0, Math.max(0, LIVE_PANEL_ROWS - 3))) {
    rows.push(line(`${item.port}`.padEnd(6) + `${item.id}`.padEnd(8) + `${item.elapsed.toFixed(1)}s`.padEnd(9) + `${item.route}`.padEnd(17) + `${item.provider}`.padEnd(27) + `${colorForStatus(item.status)}${item.status}${RESET}`, width));
  }
  while (rows.length < LIVE_PANEL_ROWS - 1) rows.push("");
  rows.push(`${DIM}q quit  ↑/↓ scroll history  space pause  +/- speed  f cycle filter  r reset scroll${RESET}`);
  return rows.map((item) => line(item, width));
}

function render() {
  if (state.renderPending) return;
  state.renderPending = true;
  setImmediate(() => {
    state.renderPending = false;
    const width = Math.max(60, process.stdout.columns || 100);
    const height = Math.max(LIVE_PANEL_ROWS + 4, process.stdout.rows || 24);
    const history = historyLines(width);
    const header = [
      line(`${WHITE}RouteCodex TUI simulator${RESET}  ${DIM}${now()}  history=${state.history.filter(visible).length}  terminal=${width}x${height}${RESET}`, width),
      line(`${DIM}Historical final transactions scroll above; live requests stay fixed at bottom.${RESET}`, width),
    ];
    const bodyRows = Math.max(0, height - LIVE_PANEL_ROWS - header.length);
    const body = history.slice(-bodyRows);
    while (body.length < bodyRows) body.unshift("");
    const output = [...header, ...body, ...liveLines(width)].join("\n");
    process.stdout.write(`${ESC}H${ESC}J${output}${ESC}${height};1H`);
  });
}

function cycleFilter() {
  const filters = ["all", "port=5520", "provider=minimax", "route=router-relay", "error"];
  state.filter = filters[(filters.indexOf(state.filter) + 1) % filters.length];
  state.scroll = 0;
}

function cleanup() {
  if (state.timer) clearInterval(state.timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${RESET}${ESC}?25h${ESC}0m\n`);
}

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
  if (key.name === "up") state.scroll += 1;
  if (key.name === "down") state.scroll = Math.max(0, state.scroll - 1);
  if (key.name === "space") state.paused = !state.paused;
  if (key.name === "r") state.scroll = 0;
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
