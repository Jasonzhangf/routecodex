# Owner Migration and Gate Binding

## When

Use after the main skill resolves current maps and the task changes ownership, module boundaries, paths, builders, caller edges, or required gates.

## Migration

1. Update resource relations when ownership changes cross-module flow.
2. Update the V3 function-map owner, scope, builders, and allowed/forbidden paths.
3. Update the V3 mainline edge and source anchor.
4. Update the V3 verification map and named gate.
5. Add a red fixture for the old, duplicate, or wrong-layer owner.
6. Run mapped gates, then the project architecture gate from `../SKILL.md`.

Missing or conflicting bindings block implementation. Never invent caller edges or infer ownership from grep count.

## Evidence

Report feature id, resource edge, unique owner, allowed edit path, ruled-out adjacent layers, required gates, and review surface.
