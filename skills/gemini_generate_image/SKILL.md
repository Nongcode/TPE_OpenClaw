---
name: gemini-generate-image
metadata:
  openclaw:
    skillKey: "gemini_generate_image"
description: Dung Gemini web theo profile browser co dinh de tao anh, tai anh ve thu muc `output_dir` duoc chi dinh (hoac mac dinh `artifacts/images/`), va ghi logs.
requires:
  bins:
    - node
---

# Skill `gemini_generate_image`

## Instructions

AI agent phai chay:

```powershell
node skills/gemini_generate_image/action.js --input_file .\artifacts\images\gemini_input.json
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

## Required behavior

- Khi tao anh, phai gui day du `image_prompt`.
- Khi co reference, phai dua day du vao `image_paths`.
- Neu workflow muon luu anh o thu muc co dinh, phai truyen ro `output_dir`.
- Tren Windows/PowerShell, uu tien `--input_file`.
- Khong sua file skill trong luc dang chay workflow thong thuong.
- Neu tool fail, bao lai loi that tu output cua tool.
