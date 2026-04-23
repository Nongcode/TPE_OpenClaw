# Overnight Recovery Plan

## Live Runtime
- Live workflow runtime: `skills/agent-orchestrator-test`
- Active workflow under overnight test: `wf_1776883073117_xd74z21`
- Root conversation: `conv_1776883073117_ivclk7m`
- Mandatory brief:
  `triển khai quảng cáo cho sản phẩm "Mễ kê 6 Tấn, chiều cao nâng 382-600 mm (1 đôi)"`

## Allowed Scope
- Primary live fixes:
  - `skills/agent-orchestrator-test/scripts/*`
  - `skills/generate_veo_video/action.js`
  - FE/backend stability files only when evidence points there
- Do not continue live feature work in `skills/agent-orchestrator/scripts/*`

## Self-Heal Loop
1. Confirm live runtime and current workflow state.
2. Reproduce the next blocking stage with the exact live brief/workflow.
3. Collect evidence from:
   - workflow JSON
   - session logs
   - tool JSON output
   - screenshots
   - network traces
4. Fix the smallest proven root cause.
5. Re-run the same live workflow step or a direct diagnostic micro-run.
6. Repeat until the workflow reaches publish success with a real `postId`.

## Current Focus
- Unblock live video generation in `skills/generate_veo_video/action.js`
- Then let `agent-orchestrator-test` continue:
  - `awaiting_video_approval`
  - video approval
  - publish

## Stop Condition
- Final PASS only when the live workflow finishes end-to-end and the final result contains a real `postId`.
