# Flow

## Main path

```text
idle
  -> pho_phong thong bao "da nhan brief, dang giao viec"
  -> CREATE_NEW
  -> nv_content
  -> pho_phong thong bao "dang cho content"
  -> awaiting_content_approval
  -> pho_phong thong bao "da nhan duyet content, dang tao media"
  -> nv_prompt
  -> nv_media
  -> pho_phong thong bao "dang render media"
  -> awaiting_media_approval
  -> pho_phong thong bao "dang cho user duyet media"
  -> awaiting_publish_decision
  -> pho_phong thong bao "dang dang bai / hen gio"
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

## User-facing progress

- `pho_phong` khong duoc im lang trong luc workflow dang chay.
- O moi buoc co do tre, phai co thong bao tam thoi de user biet he thong van dang xu ly.
- Khi da co ket qua cuoi cung thi phai gui ngay, khong duoc de thong bao tam thoi tro thanh diem dung cuoi.

## Reject loops

- `Sua anh, ...` -> `nv_media` hoc feedback, `nv_prompt` viet lai prompt, `nv_media` tao lai media
- `Sua prompt, ...` -> `nv_prompt` hoc feedback, viet lai prompt, `nv_media` tao lai media

## Training target agents

- `nv_content`
- `nv_prompt`
- `nv_media`
