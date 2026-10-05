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
  "close_for_exec_replacement",
  "V3FrontTransportRequestCycle",
  "restart_closeout_closes_without_error_for_request_before_response_headers",
  "persistent_connection_second_request_gets_preheader_restart_terminal",
  "front_socket_restart_after_request_acceptance_delivers_zero_bytes",
  "front_socket_discards_configured_error_terminal_after_headers",
  "front_socket.mark_request_started();",
];

const missing = requiredContracts.filter((contract) => !source.includes(contract));
if (missing.length > 0) {
  throw new Error(
    `v3 runtime restart handoff contract is incomplete: ${missing.join(", ")}`,
  );
}

console.log("v3 runtime restart handoff contract: PASS");
