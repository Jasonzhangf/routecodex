# Owner Migration and Gate Binding

## When

Use after the main skill resolves current maps and the task changes ownership, module boundaries, paths, builders, caller edges, or required gates.

## Migration

1. Update only the bindings changed by this task: resource relations, function owner/scope/builders/paths, mainline edges/anchors, or verification gates. Unchanged maps need no edit.
2. For a changed ownership boundary, reuse or add a regression that detects the concrete old, duplicate or wrong-layer behavior; do not add a fixture only to mirror a map edit.
3. Run the main skill's required checks once. Reuse umbrella sub-gate results instead of running the same gates before and after the umbrella.

Missing or conflicting bindings block implementation. Never invent caller edges or infer ownership from grep count.

## Evidence

Keep the feature id, resource edge, unique owner, allowed edit path, ruled-out adjacent layers, required gates, and review surface in the task's existing evidence record. User-facing feedback follows the main skill's Report section; do not repeat this inventory at each stage.
