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
7. When invoking the CLI from an agent lane on Windows, prefer `--message-file` with a UTF-8 brief file instead of passing raw Vietnamese text directly in shell arguments.

## Fixed Department Flow (Facebook Campaign)

When user commands `truong_phong` directly, hierarchy mode should behave like this:

1. If user explicitly asks for a detailed plan first, `truong_phong` returns a proposal for approval.
2. If user asks to "trien khai bai viet", "viet bai", or "soan bai" for a product, `truong_phong` must execute immediately instead of asking whether to draft or publish.
3. The default scope for the case above is content-only so user can review the draft first.
4. `pho_phong` triggers mandatory product research via `search_product_text`.
5. `pho_phong` assigns `nv_content` to write content.
6. `pho_phong` reviews content.
7. Only if the brief explicitly asks for image/video/media does `pho_phong` open `nv_media`, review media, and compile the package.
8. `nv_media` uses product reference images from `artifacts/references/search_product_text/<product-slug>/` when calling `gemini_generate_image` and `generate_video`.
9. `truong_phong` performs the real `final_review`.
10. Publishing with `facebook_publish_post` happens only after explicit user confirmation to publish.

Detailed-plan approval gate is applied only when user explicitly requests planning before execution.

## CLI Notes

- `--product-keyword`: keyword passed to `skills/search_product_text/action.js`.
- `--target-site`: target domain for product research (default `uptek.vn`).
- `--artifacts-dir`: custom output folder for simulation artifacts.
- `--no-simulation-artifacts`: disable artifact writing.
- `--strict-review-gates`: enforce strict blocking review behavior.

Simulation output default folder:

- `artifacts/campaigns/agent-orchestrator-simulations/<run-id>/`
- Includes plan/result, per-step snapshots, final content, image/video prompts, and copied product original images.
- Includes publish result artifacts when compile/publish runs successfully.

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
