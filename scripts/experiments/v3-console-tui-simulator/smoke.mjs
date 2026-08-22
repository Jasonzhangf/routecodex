#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.dirname(new URL(import.meta.url).pathname);
const source = fs.readFileSync(path.join(root, "tui-simulator.mjs"), "utf8");
const simulatorUrl = pathToFileURL(path.join(root, "tui-simulator.mjs")).href;

assert.match(source, /LIVE/);
assert.match(source, /historyLines/);
assert.match(source, /SIGWINCH/);
assert.match(source, /state\.scroll/);
assert.match(source, /finishRequest/);
assert.match(source, /history_browsing/);
assert.match(source, /follow_latest/);
assert.match(source, /key\.name === "escape"/);
assert.match(source, /responseStatus/);
assert.match(source, /responseBytes/);
assert.match(source, /sessionId/);
assert.match(source, /usage/);
assert.match(source, /reason/);
assert.match(source, /terminalSize/);
assert.match(source, /compact/);
assert.match(source, /liveRows/);
assert.match(source, /newCount/);

const layoutProbe = spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `import(${JSON.stringify(simulatorUrl)}).then(({ calculateLayout }) => process.stdout.write(JSON.stringify([calculateLayout(24), calculateLayout(12), calculateLayout(2), calculateLayout(1)])))`,
], {
  encoding: "utf8",
  env: { ...process.env, TUI_SIMULATOR_NO_START: "1" },
});
assert.equal(layoutProbe.status, 0, layoutProbe.stderr);
assert.deepEqual(JSON.parse(layoutProbe.stdout), [
  { headerRows: 2, historyRows: 15, liveRows: 7 },
  { headerRows: 2, historyRows: 3, liveRows: 7 },
  { headerRows: 2, historyRows: 0, liveRows: 0 },
  { headerRows: 1, historyRows: 0, liveRows: 0 },
]);

const result = spawnSync(process.execPath, [path.join(root, "tui-simulator.mjs")], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
assert.equal(result.status, 2);
assert.match(result.stderr, /requires an interactive TTY/);

console.log("tui simulator smoke passed");
