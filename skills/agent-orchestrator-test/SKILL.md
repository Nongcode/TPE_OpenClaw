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
- `pho_phong` phai chu dong gui thong bao tien do cho user o moi buoc chay lau:
  - vua nhan brief va dang giao `nv_content`
  - da nhan duyet content va dang giao `nv_prompt` / `nv_media`
  - dang sua content hoac sua media theo feedback
  - dang cho ket qua render media / dang publish / dang schedule
- Moi thong bao tien do phai ngan, ro va noi dung dung giai doan dang chay; khong im lang trong luc workflow dang lam viec.
- Neu tien trinh van chua xong sau lan thong bao dau, `pho_phong` phai gui them thong bao cho user biet la he thong van dang xu ly.
- Khi `pho_phong` goi entry point orchestrator, phai cho lenh chay xong va lay ket qua cuoi cung roi moi tra loi user.
- Khong duoc dung o trang thai `Process still running` trong luc dang cho `nv_content`; buoc nay bat buoc phai doi den khi co ban content de trinh duyet.
- Chi duoc gui thong bao tien do tam thoi khi buoc tao media render lau da duoc xac minh la van dang chay, va khong duoc coi do la ket qua workflow cuoi cung.
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
- Chi cho phep thong bao tam thoi khi da doi lau ma tien trinh van chua ket thuc; khong dung thong bao tam thoi lam ket qua cuoi cung cua workflow.

## Progress protocol

- Ngay khi bat dau mot buoc co do tre, `pho_phong` phai gui 1 thong bao ngan de user biet dang xu ly.
- Mau thong bao duoc khuyen nghi:
  - `Da nhan brief, toi dang giao NV Content len bai cho ban.`
  - `Da nhan duyet content, toi dang giao NV Prompt va NV Media tao anh.`
  - `He thong van dang render media, toi se gui anh ngay khi co ket qua.`
  - `Toi dang day len page / dat lich dang bai, vui long doi them mot chut.`
- Thong bao tien do chi la thong bao tam thoi; sau do `pho_phong` van phai tiep tuc doi va gui ket qua cuoi cung khi workflow xong.

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
- Neu entry point chua xong va process con dang chay:
  - duoc phep gui 1 thong bao tien do ngan;
  - nhung van phai tiep tuc poll cho toi khi co ket qua that;
  - khong duoc coi thong bao tam thoi la cau tra loi cuoi cung.
- Neu orchestrator tra ve `stage = awaiting_content_approval`, `awaiting_media_approval`, `awaiting_video_approval`, hoac `awaiting_publish_decision`, `pho_phong` phai trinh dung checkpoint do; khong duoc tu y noi da sang buoc tiep theo.

## References

- `references/flow.md`
- `scripts/orchestrator.js`
