---
name: facebook-edit-post
metadata:
  openclaw:
    skillKey: "facebook_edit_post"
description: Tự động chỉnh sửa nội dung văn bản của một bài viết đã đăng trên Fanpage thông qua Facebook Graph API (dựa vào post_id). Không dùng trình duyệt.
requires:
  bins:
    - node
---

# Skill `facebook_edit_post`

## Instructions (Hướng dẫn cho AI Agent)

Bạn (AI Agent) sử dụng skill này bằng cách chạy file `skills/facebook_edit_post/action.js` qua lệnh `node`, truyền dữ liệu là chuỗi JSON.

**Lưu ý:**
- Bắt buộc phải có `access_token` (Page Access Token), `post_id` (ID của bài viết cần sửa) và `caption_short` hoặc `caption_long` (Nội dung mới).
- Skill này chỉ hỗ trợ sửa đổi phần văn bản (text) của bài viết, không hỗ trợ thêm/sửa/xóa ảnh hoặc video đã đính kèm.

**Câu lệnh thực thi:**

```bash
node skills/facebook_edit_post/action.js '{"caption_short": "Nội dung bài viết mới đã được cập nhật", "post_id": "ID_BAI_VIET", "access_token": "TOKEN_CUA_BAN"}'
