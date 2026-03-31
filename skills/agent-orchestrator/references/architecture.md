## Architecture

Use four layers.

1. Registry
- Discover agent ids from `~/.openclaw/agents/*`.
- Read runtime session metadata from each `sessions/sessions.json`.
- Load manifest overrides for hierarchy and permissions.

2. Planner
- Convert a user request into a structured plan.
- Respect `canDelegateTo`, `reportsTo`, and `requiresReviewBy`.

3. Executor
- Run planned steps in order.
- Preserve task ids and parent/child relationships.
- Support dry-run and plan-only modes.

4. Transport
- Deliver tasks to the target session key.
- Keep transport swappable. The orchestrator should not care whether the target is reached via chat-completions relay, session tools, or another backend.

## Current Org Shape

Default hierarchy for the current deployment:

- `quan_ly`
- `truong_phong`
- `pho_phong`
- `nv_content`
- `nv_media`

Recommended policy:

- `quan_ly` delegates to `truong_phong`
- `truong_phong` delegates to `pho_phong`
- `pho_phong` delegates to `nv_content` and `nv_media`
- staff agents report back upward for review

## Design Constraints

- Runtime discovery should work even when a manifest is missing.
- Missing manifests should degrade to inferred defaults, not crash.
- Business skills should call the orchestrator CLI or module API instead of embedding routing rules.
