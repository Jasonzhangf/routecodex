import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const sourcePaths = [
  "crates/routecodex-v3-server/src/restart_handoff.rs",
  "crates/routecodex-v3-server/src/restart_closeout.rs",
  "crates/routecodex-v3-server/src/restart_handoff/tests/restart_handoff_closeout.rs",
];
const source = sourcePaths
  .map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"))
  .join("\n");

const requiredContracts = [
  "close_active_client_transports",
  "build_v3_restart_closeout_http_error",
  "restart_closeout_has_explicit_terminal_for_request_before_response_headers",
  "front_socket_writes_restart_terminal_after_request_acceptance",
  "front_socket.mark_request_started();",
];

const missing = requiredContracts.filter((contract) => !source.includes(contract));
if (missing.length > 0) {
  throw new Error(
    `v3 runtime restart handoff contract is incomplete: ${missing.join(", ")}`,
  );
}

console.log("v3 runtime restart handoff contract: PASS");
