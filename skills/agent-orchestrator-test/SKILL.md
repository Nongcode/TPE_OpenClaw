---
name: agent-orchestrator-test
description: "Dieu phoi workflow marketing cho lane `pho_phong`: `nv_content` viet bai, `nv_prompt` viet prompt image/video, `nv_media` thuc thi media bang anh san pham goc + logo cong ty, sau do cho User duyet truoc khi publish hoac schedule."
---

# Agent Orchestrator Test

## Overview

Workflow hien tai:

1. `pho_phong` nhan brief.
2. `nv_content` research va viet content.
3. User duyet content.
4. `nv_prompt` viet prompt image, video, hoac ca hai.
5. `nv_media` tao media bang prompt duoc giao va bat buoc gui:
   - anh san pham goc
   - logo cong ty trong `.openclaw/assets/logos`
6. User duyet media va doc duoc prompt da dung.
7. `pho_phong` hoi dang ngay hay hen gio.

## Runtime requirements

- Can co 4 agent: `pho_phong`, `nv_content`, `nv_prompt`, `nv_media`.
- `pho_phong.subagents.allowAgents` phai co `nv_prompt`.
- `nv_prompt` dung workspace `C:/Users/Administrator/.openclaw/workspace_prompt`.
- `nv_media` dung prompt package tu `nv_prompt`, khong con mac dinh background-only.

## Human-in-the-loop

- User luon duyet content truoc khi sang media.
- User luon duyet media truoc khi dang bai.
- Khi `pho_phong` goi entry point orchestrator, phai cho lenh chay xong va lay ket qua cuoi cung roi moi tra loi user.
- Khong duoc dung o trang thai `Process still running` trong luc dang cho `nv_content`; buoc nay bat buoc phai doi den khi co ban content de trinh duyet.
- Chi duoc gui thong bao tien do tam thoi khi buoc tao media render lau da duoc xac minh la van dang chay, va khong duoc coi do la ket qua workflow cuoi cung.
- Summary media approval phai co:
  - duong dan media vua tao
  - prompt da dung
  - anh san pham goc da dung
  - danh sach logo da dung
- Khi orchestrator tra ve truong `human_message`, `pho_phong` phai uu tien chuyen nguyen van truong nay cho user.
- Neu `human_message` co cac dong `MEDIA: "..."`, phai giu nguyen de gateway chat render anh; khong duoc doi sang duong dan text thuong.
- O buoc tao media, neu lenh chay tra ve `Command still running`, `pho_phong` phai tiep tuc `process poll` thay vi dung lai sau lan poll dau.
- Truoc khi gui thong bao tien do tam thoi, can kiem tra `workspace_phophong/agent-orchestrator-test/current-workflow.json`; neu da sang `awaiting_media_approval` thi phai trinh ngay media cho user duyet.
- Chi cho phep thong bao tam thoi khi da doi lau ma tien trinh van chua ket thuc; khong dung thong bao tam thoi lam ket qua cuoi cung cua workflow.

## Learning

- Feedback media: `nv_media` hoc vao `rules.json`.
- Feedback prompt: `nv_prompt` hoc vao `rules.json`.
- Knowledge base prompt co the bo sung them file vao:
  - `workspace_prompt/prompt-library.md`
  - `workspace_prompt/knowledge/*`

## Entry point

```bash
node D:/CodeAiTanPhat/TPE_OpenClaw/skills/agent-orchestrator-test/scripts/orchestrator.js --json --openclaw-home C:/Users/Administrator/.openclaw --from pho_phong --message-file C:/Users/Administrator/.openclaw/workspace_phophong/tmp/workflow-brief.txt
```

## References

- `references/flow.md`
- `scripts/orchestrator.js`
