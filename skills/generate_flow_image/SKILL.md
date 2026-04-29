---
name: generate-flow-image
metadata:
  openclaw:
    skillKey: "generate_flow_image"
description: Dung Google Flow project da cau hinh san de tao anh, tai anh ve `output_dir` voi do phan giai 2k mac dinh, va ghi logs.
requires:
  bins:
    - node
---

# Skill `generate_flow_image`

## Instructions

AI agent phai chay:

```powershell
node skills/generate_flow_image/action.js --input_file .\artifacts\images\flow_image_input.json
```

Khong uu tien nhet JSON truc tiep vao command line PowerShell, vi de roi truong `image_prompt`.

## Input JSON

File JSON can co toi thieu:

```json
{
  "image_prompt": "...",
  "image_paths": [
    "C:/path/to/product-image.png",
    "C:/path/to/logo.png"
  ],
  "output_dir": "C:/Users/Administrator/.openclaw/workspace_media/artifacts/images",
  "dry_run": false
}
```

Mac dinh skill dung Flow project:

```text
https://labs.google/fx/vi/tools/flow/project/64c7c243-037d-4136-a867-4ba4d834605b
```

## Required behavior

- Khi tao anh, phai gui day du `image_prompt`.
- Khi co reference, phai dua day du vao `image_paths`.
- Neu workflow muon luu anh o thu muc co dinh, phai truyen ro `output_dir`.
- Mac dinh tai ban `2k` tu Flow.
- Tren Windows/PowerShell, uu tien `--input_file`.
- Khong sua file skill trong luc dang chay workflow thong thuong.
- Neu tool fail, bao lai loi that tu output cua tool.
