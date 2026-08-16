#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const source = fs.readFileSync(path.join(root, "tui-simulator.mjs"), "utf8");

assert.match(source, /LIVE/);
assert.match(source, /historyLines/);
assert.match(source, /SIGWINCH/);
assert.match(source, /state\.scroll/);
assert.match(source, /finishRequest/);

const result = spawnSync(process.execPath, [path.join(root, "tui-simulator.mjs")], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
assert.equal(result.status, 2);
assert.match(result.stderr, /requires an interactive TTY/);

console.log("tui simulator smoke passed");
