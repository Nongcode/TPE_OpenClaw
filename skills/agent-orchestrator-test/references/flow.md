# Flow

## Main path

Each manager account/instance must run the CLI with its own `--manager-instance-id`.
The manager state file is namespaced by that value, while worker agents are shared
through workflow-scoped sessions:

```text
mgr_pho_phong_A -> nv_content session agent:nv_content:automation:<workflow-A>:<step>
mgr_pho_phong_B -> nv_content session agent:nv_content:automation:<workflow-B>:<step>
```

```text
idle
  -> CREATE_NEW
  -> nv_content
  -> awaiting_content_approval
  -> nv_prompt
  -> nv_media
  -> awaiting_media_approval
  -> awaiting_publish_decision
  -> [optional] pho_phong goi y tao them video
  -> [optional] media_video
  -> [optional] nv_prompt
  -> [optional] media_video render video
  -> [optional] awaiting_video_approval
  -> published | scheduled
```

## Media path details

- `nv_prompt` viet IMAGE prompt cho `nv_media`.
- `nv_media` phai thuc thi anh bang prompt duoc giao.
- Khi tao anh, `nv_media` phai dua vao skill:
  - `image_paths[0] = anh san pham goc`
  - `image_paths[1..] = logo cong ty trong .openclaw/assets/logos`
- Khi user dong y tao them video:
  - `media_video` tong hop brief video de gui `nv_prompt`
  - `nv_prompt` viet VIDEO prompt
  - `media_video` goi `generate_veo_video`
  - `reference_image = anh san pham goc`
  - `logo_paths = tat ca logo cong ty`
  - `output_dir = workspace_media_video/artifacts/videos`

## Approval summary

Khi dang cho duyet media, `pho_phong` phai hien thi:

- preview media that trong chat
- prompt da dung
- anh san pham goc da dung
- logo da dung

## User-facing progress

- `pho_phong` uu tien tra checkpoint that cua orchestrator, khong tu y noi progress bang tay.
- Neu worker dang chay lau, `pho_phong` phai poll tiep va kiem tra state file truoc; chi duoc gui toi da 1 thong bao tam thoi neu chua co checkpoint that.
- Khi da co ket qua cuoi cung hoac state da recover sang checkpoint duyet thi phai gui ngay, khong duoc de user phai hoi lai moi thay ket qua.

## Reject loops

- `Sua anh, ...` -> `nv_media` hoc feedback, `nv_prompt` viet lai prompt, `nv_media` tao lai media
- `Sua prompt, ...` -> `nv_prompt` hoc feedback, viet lai prompt, `nv_media` tao lai media
- `Sua video, ...` -> `media_video` hoc feedback, `nv_prompt` viet lai VIDEO prompt, `media_video` tao lai video
- `Sua prompt video, ...` -> `nv_prompt` hoc feedback, viet lai VIDEO prompt, `media_video` tao lai video

## Training target agents

- `nv_content`
- `nv_prompt`
- `nv_media`
- `media_video`
