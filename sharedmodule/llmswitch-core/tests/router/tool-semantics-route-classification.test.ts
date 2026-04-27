import { describe, expect, test } from "@jest/globals";

import { classifyToolCallForReport } from "../../src/router/virtual-router/tool-signals.js";

function classify(name: string, argumentsPayload: unknown) {
  return classifyToolCallForReport({
    id: "call_test",
    type: "function",
    function: {
      name,
      arguments:
        typeof argumentsPayload === "string"
          ? argumentsPayload
          : JSON.stringify(argumentsPayload),
    },
  } as any);
}

describe("tool semantics route classification", () => {
  test("classifies update_plan as thinking", () => {
    const result = classify("update_plan", {
      plan: [{ step: "inspect", status: "in_progress" }],
    });

    expect(result?.category).toBe("thinking");
  });

  test("classifies exec_command grep/find style commands as search", () => {
    const grepResult = classify("exec_command", {
      cmd: 'grep -n "route" README.md',
    });
    const findResult = classify("exec_command", {
      cmd: "find src -name '*.ts'",
    });

    expect(grepResult?.category).toBe("search");
    expect(findResult?.category).toBe("search");
  });

  test("classifies exec_command sed/awk edit semantics as coding", () => {
    const sedResult = classify("exec_command", {
      cmd: "sed -i '' 's/old/new/g' src/a.ts",
    });
    const awkResult = classify("exec_command", {
      cmd: "awk '{gsub(/old/,\"new\")}1' src/a.ts",
    });

    expect(sedResult?.category).toBe("coding");
    expect(awkResult?.category).toBe("coding");
  });

  test("classifies read-style exec_command as thinking", () => {
    const result = classify("exec_command", {
      cmd: "cat src/router/virtual-router/classifier.ts",
    });

    expect(result?.category).toBe("thinking");
  });
});
