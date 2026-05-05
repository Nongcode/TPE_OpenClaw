---
name: agent-orchestrator-test
description: "Dieu phoi workflow marketing cho lane `pho_phong`: `nv_content` viet bai, `nv_media` tao anh, sau do o buoc chot dang bai co the goi them `media_video` de tao video roi moi publish hoac schedule."
---

# Agent Orchestrator Test

## Overview

Workflow hien tai:

1. `pho_phong` nhan brief.
2. `nv_content` research va viet content.
3. User duyet content.
4. `nv_prompt` viet image prompt.
5. `nv_media` tao anh bang prompt duoc giao va bat buoc gui:
   - anh san pham goc
   - logo cong ty trong `.openclaw/assets/logos`
6. User duyet anh va doc duoc prompt da dung.
7. `pho_phong` hoi dang ngay / hen gio, dong thoi goi y tao them video quang cao.
8. Neu user dong y tao video:
   - `media_video` tong hop brief video
   - `nv_prompt` viet VIDEO prompt
   - `media_video` dung `generate_veo_video` tao video bang anh goc san pham + logo cong ty
   - User duyet video va doc duoc video prompt da dung
9. Sau khi user duyet xong media can thiet, `pho_phong` moi dang bai hoac hen gio.

## Runtime requirements

- Can co 5 agent: `pho_phong`, `nv_content`, `nv_prompt`, `nv_media`, `media_video`.
- `pho_phong.subagents.allowAgents` phai co `nv_prompt`.
- `nv_prompt` dung workspace `C:/Users/Administrator/.openclaw/workspace_prompt`.
- `nv_media` dung prompt package tu `nv_prompt`, khong con mac dinh background-only.
- `media_video` dung workspace `C:/Users/Administrator/.openclaw/workspace_media_video`.
- `media_video` phai goi `generate_veo_video` voi:
  - `prompt`
  - `reference_image = anh san pham goc`
  - `logo_paths = tat ca logo cong ty`
  - `output_dir = workspace_media_video/artifacts/videos`

## Human-in-the-loop

- User luon duyet content truoc khi sang media.
- User luon duyet anh truoc khi dang bai.
- Neu tao them video, user luon duyet video truoc khi dang bai.
- Khi `pho_phong` goi entry point orchestrator, phai cho lenh chay xong va lay ket qua cuoi cung roi moi tra loi user.
- Khong duoc dung o trang thai `Process still running` trong luc dang cho `nv_content`; buoc nay bat buoc phai doi den khi co ban content de trinh duyet.
- `pho_phong` khong duoc gui thong bao kieu "da nhan brief", "dang giao viec", "dang kiem tra", "dang render" truoc khi da chay entry point orchestrator cho tin nhan hien tai va da xac minh state that.
- Khong gui thong bao tien do tam thoi cho buoc content/media/video trong chat root; phai tiep tuc cho/poll cho toi khi co checkpoint that hoac loi that tu orchestrator.
- Neu `current-workflow.json` da sang `awaiting_content_approval`, `awaiting_media_approval`, `awaiting_video_approval`, hoac `awaiting_publish_decision`, `pho_phong` phai trinh ngay checkpoint do, khong duoc tiep tuc noi "dang xu ly".
- Neu `nv_content` dang research web hoac `nv_media` / `media_video` dang render, `pho_phong` phai tiep tuc theo doi dung state that; khong duoc tu y bao loi neu chua co bang chung loi ro rang tu orchestrator hoac artifact.
- Summary media approval phai co:
  - preview media thuc te trong chat
  - prompt da dung
  - anh san pham goc da dung
  - danh sach logo da dung
- O buoc `awaiting_publish_decision`, `pho_phong` phai goi y:
  - `Co muon tao them video quang cao san pham tren roi dang len page khong?`
  - Neu user dong y, phai chuyen sang nhanh video thay vi publish ngay.
- Khi orchestrator tra ve truong `human_message`, `pho_phong` phai uu tien chuyen nguyen van truong nay cho user.
- Neu `human_message` co cac dong `MEDIA: "..."`, phai giu nguyen de gateway chat render anh; khong duoc doi sang duong dan text thuong.
- O buoc tao media, neu lenh chay tra ve `Command still running`, `pho_phong` phai tiep tuc `process poll` thay vi dung lai sau lan poll dau.
- Truoc khi gui thong bao tien do tam thoi, can kiem tra `workspace_phophong/agent-orchestrator-test/current-workflow.json`; neu da sang `awaiting_media_approval` thi phai trinh ngay media cho user duyet.
- Khong dung thong bao tam thoi lam ket qua cua workflow; neu tien trinh con chay, agent phai tiep tuc poll va chi tra checkpoint hoac loi that.

## Progress protocol

- Mac dinh, `pho_phong` chi tra lai checkpoint that cua orchestrator, khong tu viet thong bao tien do.
- Neu process van dang chay va chua co checkpoint duyet:
  - phai tiep tuc `process poll`;
  - phai kiem tra `agent-orchestrator-test/current-workflow.json`;
  - neu state da doi sang checkpoint duyet thi trinh ngay checkpoint do.
- Khong gui thong bao tam thoi trong chat root; tiep tuc poll cho toi khi co checkpoint hoac loi that.
- Khong duoc rerun entry point chi vi PowerShell in ra log giua chung hoac `NativeCommandError` neu state file va checkpoint cho thay workflow van dang tien trien.

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

## Bat buoc cho `pho_phong`

- Khi user gui BAT KY tin nhan nao lien quan den workflow, `pho_phong` BAT BUOC phai:
  1. ghi nguyen van tin nhan do vao file tam;
  2. chay dung entry point orchestrator o tren;
  3. doi den khi lenh tra JSON ket qua hoac loi that;
  4. uu tien tra lai `human_message` neu co.
- "Bat ky tin nhan lien quan den workflow" bao gom:
  - brief moi;
  - lenh duyet nhu `Duyet content`, `Duyet content, tao anh`, `Duyet anh`, `Duyet video`;
  - lenh sua nhu `Sua content, ...`, `Sua anh, ...`, `Sua video, ...`;
  - lenh reset/chay lai nhu `thuc hien lai workflow tu dau`, `reset workflow`, `lam lai tu dau`;
  - quyet dinh publish/schedule nhu `Dang ngay`, `Hen gio ...`, `Tao video`.
- Khong duoc chi doc `SKILL.md` roi tu suy luan va tra loi bang van ban tay.
- Khong duoc tra loi bang cach noi "dang giao NV Prompt / NV Media", "he thong dang render", "toi dang kiem tra log", hoac bat ky cau mo ta tien trinh nao neu CHUA chay entry point orchestrator cho tin nhan hien tai.
- Khong duoc noi workflow loi content/media/publish neu chua chay entry point hoac chua co bang chung loi that tu orchestrator.
- Neu brief moi vua den, khong duoc tra loi bang trang thai suy dien cua workflow cu.
- Neu user vua gui lenh duyet/sua ma `current-workflow.json` van o stage cu, van phai goi orchestrator lai voi chinh tin nhan vua gui; khong duoc tu nhay sang suy doan la workflow dang render hay dang loi.
- Neu buoc `nv_content` dang chay, khong duoc ket thuc turn bang mot cau tam thoi nhu "workflow thoat som" neu chua xac minh loi that tu orchestrator.
- Neu entry point da chay ma tra ve `status=error`, phai bam dung `summary`/`human_message` cua orchestrator; khong tu doi nghia sang mot loi khac.
- Neu entry point chua xong va process con dang chay, tiep tuc poll cho toi khi co ket qua that; khong ket thuc turn bang thong bao tien do.
- Neu orchestrator tra ve `stage = awaiting_content_approval`, `awaiting_media_approval`, `awaiting_video_approval`, hoac `awaiting_publish_decision`, `pho_phong` phai trinh dung checkpoint do; khong duoc tu y noi da sang buoc tiep theo.
- Neu state file hoac ket qua recover da cho thay worker lam xong, `pho_phong` phai trinh ngay checkpoint duyet; khong duoc doi den khi user hoi lai "den dau roi".

## References

- `references/flow.md`
- `scripts/orchestrator.js`
