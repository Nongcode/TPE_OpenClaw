---
name: gemini-generate-image
metadata:
  openclaw:
    skillKey: "gemini_generate_image"
description: Dùng Gemini web theo profile Edge cố định để tự động hóa trình duyệt, tạo ảnh, tải về thư mục `artifacts/images/` và ghi logs.
requires:
  bins:
    - node
---

# Skill `gemini_generate_image`

## Instructions (Hướng dẫn cho AI Agent)

Để sử dụng skill này, bạn (AI Agent) PHẢI thực thi file `skills/gemini_generate_image/action.js` bằng lệnh dòng lệnh `node`, truyền đầu vào là một chuỗi JSON hợp lệ được đặt trong dấu ngoặc kép đơn (`'`). Các tham số mặc định (browser_path, user_data_dir...) có thể bỏ qua nếu người dùng không yêu cầu ghi đè.

**Câu lệnh thực thi:**

```bash
node skills/gemini_generate_image/action.js '{"image_prompt": "...", "dry_run": false}'
```
