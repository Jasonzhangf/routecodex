# Routing Policy UI (planned)

This repo already has a CRUD editor under the daemon-admin “Runtime Routing Pool” tab.

The next step (not implemented yet) is a unified **policy editor** in the control plane that:
- edits `virtualrouter.routing` tiers (targets/mode/priority) and `virtualrouter.loadBalancing` (strategy/healthWeighted/contextWeighted/aliasSelection)
- writes to the user config file and triggers a controlled restart (`config-driven` rule)

This doc exists to reserve the contract and avoid ad-hoc runtime patching.

See `docs/ROUTING_POLICY_SCHEMA.md` for the control-plane schema and the `/daemon/control/*` contract.
