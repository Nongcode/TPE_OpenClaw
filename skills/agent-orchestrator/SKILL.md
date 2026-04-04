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

## Fixed Department Flow (Facebook Campaign)

When user commands `truong_phong` directly, the hierarchy mode now enforces this exact order:

1. `truong_phong` creates detailed plan (proposal only) and returns for user approval.
2. After user approval signal, `truong_phong` hands off execution to `pho_phong`.
3. `pho_phong` triggers mandatory product research via `search_product_text`.
4. `pho_phong` assigns `nv_content` to write content.
5. `pho_phong` reviews content.
6. `pho_phong` assigns `nv_media` to create media.
7. `pho_phong` reviews media.
8. `pho_phong` compiles final package and submits to `truong_phong`.
9. `truong_phong` returns final package for user approval before posting.

The orchestrator does simulation-only output for media/publish workflow; no real Facebook post is executed in this path.
Detailed-plan approval gate is applied only when user explicitly requests a detailed plan.

For presentation/demo runs, smooth mode is enabled by default: media creation/review and final review are treated as successful so the flow completes and exports a full artifact bundle (content + image prompt + video prompt + copied original product images). Use `--strict-review-gates` to restore strict blocking behavior.

## CLI Notes

- `--product-keyword`: keyword passed to `skills/search_product_text/action.js`.
- `--target-site`: target domain for product research (default `uptek.vn`).
- `--artifacts-dir`: custom output folder for simulation artifacts.
- `--no-simulation-artifacts`: disable artifact writing.
- `--strict-review-gates`: disable demo smooth mode and enforce strict review blocking.

Simulation output default folder:

- `artifacts/campaigns/agent-orchestrator-simulations/<run-id>/`
- Includes plan/result, per-step snapshots, final content, image/video prompts, and copied product original images.
- Includes `23-facebook-publish-simulation.json` for handoff to a later main-agent batch execution.

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
