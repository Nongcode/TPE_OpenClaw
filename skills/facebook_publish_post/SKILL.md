---
name: facebook-publish-post
metadata:
  openclaw:
    skillKey: "facebook_publish_post"
description: Tự động đăng bài (Chữ, Ảnh, hoặc Video/Reels) lên Fanpage siêu tốc thông qua Facebook Graph API. Không dùng trình duyệt.
requires:
  bins:
    - node
---

# Skill `facebook_publish_post`

## Instructions (Hướng dẫn cho AI Agent)

Bạn (AI Agent) sử dụng skill này bằng cách chạy file `skills/facebook_publish_post/action.js` qua lệnh `node`, truyền dữ liệu là chuỗi JSON.
**Lưu ý:**

- Bắt buộc phải có `access_token` (Page Access Token) và `page_id`.
- Nếu đăng kèm ảnh/video, truyền đường dẫn tuyệt đối vào mảng `media_paths`. API sẽ tự nhận diện đuôi file (mp4, jpg...) để gọi đúng endpoint.

**Câu lệnh thực thi:**

```bash
node skills/facebook_publish_post/action.js '{"caption_short": "Nội dung bài viết", "media_paths": ["D:/.../video.mp4"], "page_id": "ID_TRANG", "access_token": "TOKEN_CUA_BAN"}'
```
