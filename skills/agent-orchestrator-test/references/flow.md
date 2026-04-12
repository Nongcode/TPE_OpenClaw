# Flow

## Main path

```text
idle
  -> CREATE_NEW
  -> nv_content
  -> awaiting_content_approval
  -> nv_prompt
  -> nv_media
  -> awaiting_media_approval
  -> awaiting_publish_decision
  -> published | scheduled
```

## Media path details

- `nv_prompt` viet prompt image, video, hoac both.
- `nv_media` phai thuc thi bang prompt duoc giao.
- Khi tao anh, `nv_media` phai dua vao skill:
  - `image_paths[0] = anh san pham goc`
  - `image_paths[1..] = logo cong ty trong .openclaw/assets/logos`
- Khi tao video, `nv_media` uu tien gui anh san pham goc lam reference image.

## Approval summary

Khi dang cho duyet media, `pho_phong` phai hien thi:

- duong dan media vua tao
- prompt da dung
- anh san pham goc da dung
- logo da dung

## Reject loops

- `Sua anh, ...` -> `nv_media` hoc feedback, `nv_prompt` viet lai prompt, `nv_media` tao lai media
- `Sua prompt, ...` -> `nv_prompt` hoc feedback, viet lai prompt, `nv_media` tao lai media

## Training target agents

- `nv_content`
- `nv_prompt`
- `nv_media`
