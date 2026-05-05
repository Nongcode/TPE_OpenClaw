# Overnight Live Plan

## Live runtime confirmation

- Live runtime to fix and validate: `skills/agent-orchestrator-test`
- Do not treat `skills/agent-orchestrator/scripts/orchestrator.js` as the live runtime
- Live files prioritized for fixes:
  - `skills/agent-orchestrator-test/scripts/orchestrator.js`
  - `skills/agent-orchestrator-test/scripts/executor.js`
  - `skills/agent-orchestrator-test/scripts/transport.js`
  - `skills/agent-orchestrator-test/scripts/planner.js`
  - `skills/agent-orchestrator-test/scripts/campaign_pipeline.js` when relevant
- FE/backend validation scope:
  - `../UpTek_FE/src/hooks/useConversations.ts`
  - `../UpTek_FE/src/hooks/useConversations.helpers.ts`
  - `../UpTek_FE/src/components/MessageBubble.tsx`
  - `../UpTek_FE/src/lib/chatSanitization.ts`
  - `../UpTek_FE/backend/src/server.js`
  - `../UpTek_FE/backend/scripts/overnight-live-e2e.js`

## Public FE test target

- Primary public target: `https://gods-sunday-latinas-gage.trycloudflare.com/`
- Public backend/gateway checks must use the same host to avoid local-only false positives
- If browser automation is unavailable, validate through:
  - public auth + conversation APIs
  - public gateway streaming endpoint
  - root conversation message timeline
  - workflow state/history under `.openclaw`
  - FE rendering regressions with targeted tests against live payload shapes

## Exact brief

- `triển khai quảng cáo cho sản phẩm "Mễ kê 6 Tấn, chiều cao nâng 382-600 mm (1 đôi)"`

## Exact approval sequence

1. Send brief above
2. When root content checkpoint appears, send `Duyệt content, tạo ảnh`
3. When root image checkpoint appears, send `Duyệt ảnh, tạo video`
4. When root video checkpoint appears, send `Duyệt video`
5. When publish-ready checkpoint appears, send `Đăng ngay`

## Self-heal loop

1. Reproduce the exact failing step on the public stack
2. Capture evidence:
   - timestamp
   - workflow id
   - root conversation id
   - child conversation or session id
   - expected vs actual
   - FE symptom
   - network or SSE symptom
   - workflow or orchestrator state
   - reject reason when applicable
3. Identify root cause from code plus evidence
4. Apply the smallest fix at the true live runtime or FE reconcile layer
5. Run targeted regression tests
6. Resume the same workflow only when safe
7. Stop immediately after first real publish success with canonical `postId`

## Final stop condition

PASS only when all are true:

- content, image, and video checkpoints auto-surface at root `pho_phong`
- no extra user follow-up is needed to reveal image or video checkpoints
- FE no longer depends on placeholder-only assistant bubbles
- waiting banner clears when a persisted backend checkpoint arrives
- user-facing chat does not expose local paths, artifact paths, or raw prompt dumps
- publish succeeds once
- canonical `postId` is present
- no duplicate publish is sent after success
