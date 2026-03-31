---
name: agent-orchestrator
description: Coordinate multiple OpenClaw agents as one governed system with registry discovery, hierarchy-aware planning, task delegation, and permission boundaries. Use when Codex needs to route work across agents under ~/.openclaw/agents, design or enforce manager/staff hierarchies, generate delegation workflows, or replace skill-local agent bridges with a reusable orchestrator.
---

# Agent Orchestrator

Build or operate a reusable orchestration layer above OpenClaw agents. Prefer this skill over ad-hoc bridges when the system must discover agents from `~/.openclaw/agents`, enforce delegation boundaries, plan multi-step workflows, and keep transport/runtime concerns separate from business skills.

## Workflow

1. Discover runtime agents from `OPENCLAW_HOME` or the default `~/.openclaw`.
2. Load manifest overrides from the orchestrator `manifests/` directory or an external manifest directory.
3. Merge runtime metadata and manifest policy into one registry.
4. Create a plan:
   - direct: send to one agent
   - auto: select the best allowed child
   - hierarchy: walk the org tree for review/delegation chains
5. Execute through the transport layer using each agent's real session key.
6. Keep wrappers thin. Feature skills should call the orchestrator, not reimplement routing.

## Rules

- Treat `agents/*` as the runtime source of truth for which agents exist.
- Treat manifests as the source of truth for hierarchy, permissions, and capabilities.
- Do not hardcode session keys inside business skills.
- Keep transport generic so the system can later move from chat-completions relay to session tools or other runtimes.
- Prefer explicit `reportsTo`, `canDelegateTo`, and `capabilities` over keyword-only routing.

## Resources

- Scripts: use `scripts/orchestrator.js` as the CLI entrypoint.
- References: read `references/architecture.md`, `references/manifest-schema.md`, and `references/openclaw-config-template.json5` when editing the hierarchy model or gateway policy.
- Manifests: keep default agent hierarchy in `manifests/*.json`; allow external overrides through env/config.
