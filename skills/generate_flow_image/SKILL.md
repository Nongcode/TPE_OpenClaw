---
name: generate-flow-image
metadata:
  openclaw:
    skillKey: "generate_flow_image"
description: Dung Google Flow theo profile browser co dinh de tao anh bang adapter input/output kieu image, tai tep ve `output_dir` duoc chi dinh hoac mac dinh `artifacts/images/`, va ghi logs.
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
  "target_flow_url": "https://labs.google/fx/vi/tools/flow/project/....",
  "output_dir": "C:/Users/Administrator/.openclaw/workspace_media/artifacts/images",
  "dry_run": false
}
```

## Required behavior

- Khi tao anh, phai gui day du `image_prompt`.
- `image_paths[0]` duoc map thanh anh tham chieu chinh cho Flow.
- `image_paths[1..n]` duoc forward tiep vao child flow nhu cac anh bo sung.
- Neu workflow muon luu tep o thu muc co dinh, phai truyen ro `output_dir`.
- Tren Windows/PowerShell, uu tien `--input_file`.
- Khong sua file skill trong luc dang chay workflow thong thuong.
- Neu tool fail, bao lai loi that tu output cua tool.
