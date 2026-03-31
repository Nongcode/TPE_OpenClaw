---
name: generate-video
metadata:
  openclaw:
    skillKey: "generate_video"
description: Dùng Gemini (chuyên Veo 3) để tự động tạo video từ prompt, hỗ trợ chờ render lâu và bắt lỗi khi hết giới hạn (3 video/ngày).
requires:
  bins:
    - node
---

# Skill `generate_video`

## Instructions (Hướng dẫn cho AI Agent)

Để sử dụng skill này, bạn (AI Agent) PHẢI thực thi file `skills/generate_video/action.js` bằng lệnh `node`, truyền đầu vào là một chuỗi JSON hợp lệ được đặt trong dấu ngoặc kép đơn (`'`).

**Lưu ý quan trọng cho Agent:** Model Veo chỉ tạo được video 8 giây và giới hạn 3 video/ngày. Nếu skill trả về lỗi báo hết lượt, bạn cần thông báo lại cho người dùng biết.

**Câu lệnh thực thi:**

```bash
node skills/generate_video/action.js '{"video_prompt": "...", "target_gemini_url": "URL_CHAT_VEO_CUA_BAN"}'
```
