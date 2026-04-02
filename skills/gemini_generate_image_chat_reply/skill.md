---
name: show-generated-image-in-chat
metadata:
  openclaw:
    skillKey: "show_generated_image_in_chat"
description: Nhận đường dẫn ảnh đã tạo sẵn, kiểm tra file tồn tại và trả artifact để agent hiển thị ảnh trong chat.
requires:
  bins:
    - node
---

# Skill `show_generated_image_in_chat`

## Input Parameters

- `image_path` (required)

## Mục tiêu

Skill này KHÔNG tạo ảnh.

Nó chỉ:

1. Nhận đường dẫn file ảnh đã có sẵn
2. Kiểm tra file có tồn tại
3. Trả ra:
   - `reply_mode = show_image_in_chat`
   - artifact `chat_image`

## Cách dùng

```bash
node skills/show_generated_image_in_chat/action.js '{"image_path":"artifacts/images/ten-file.png"}'
```
