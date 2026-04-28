---
name: agent-orchestrator-test
description: "Dieu phoi workflow marketing cho lane `pho_phong`: `nv_content` viet bai, `nv_prompt` viet prompt image/video, `nv_media` thuc thi media bang anh san pham goc + logo cong ty, sau do cho User duyet truoc khi publish hoac schedule. NHAC NHO: pho_phong TUYET DOI KHONG tu viet content, phai dung tool orchestrator de giao viec cho nv_content."
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
- `nv_prompt` dung workspace `C:/Users/PHAMDUCLONG/.openclaw/workspace_prompt`.
- `nv_media` dung prompt package tu `nv_prompt`, khong con mac dinh background-only.

## Human-in-the-loop

- User luon duyet content truoc khi sang media.
- User luon duyet media truoc khi dang bai.
- Khi `pho_phong` goi entry point orchestrator, phai cho lenh chay xong va lay ket qua cuoi cung roi moi tra loi user.
- QUY TAC CUNG: Pho phong khong duoc tu ý viet content nháp. Neu nhận yêu cầu viết bài, BAT BUOC phai goi orchestrator de nv_content thuc hien.
- Khong duoc dung o trang thai `Process still running` trong luc dang cho `nv_content`; buoc nay bat buoc phai doi den khi co ban content de trinh duyet.
- Chi duoc gui thong bao tien do tam thoi khi buoc tao media render lau da duoc xac minh la van dang chay, va khong duoc coi do la ket qua workflow cuoi cung.
- Summary media approval phai co:
  - duong dan media vua tao
  - prompt da dung
  - anh san pham goc da dung
  - danh sach logo da dung

## Learning

- Feedback media: `nv_media` hoc vao `rules.json`.
- Feedback prompt: `nv_prompt` hoc vao `rules.json`.
- Knowledge base prompt co the bo sung them file vao:
  - `workspace_prompt/prompt-library.md`
  - `workspace_prompt/knowledge/*`

## Entry point

```bash
node D:/openclaw/skills/agent-orchestrator-test/scripts/orchestrator.js --json --openclaw-home C:/Users/PHAMDUCLONG/.openclaw --from pho_phong --message-file C:/Users/PHAMDUCLONG/.openclaw/workspace_phophong/tmp/workflow-brief.txt
```

## References

- `references/flow.md`
- `scripts/orchestrator.js`
