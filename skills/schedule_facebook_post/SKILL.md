---
name: schedule-facebook-post
metadata:
  openclaw:
    skillKey: "schedule_facebook_post"
description: Tự động ĐẶT LỊCH đăng bài (Chữ, Ảnh, hoặc Video/Reels) lên Fanpage vào một thời điểm cụ thể trong tương lai thông qua Facebook Graph API.
requires:
  bins:
    - node
---

# Skill `schedule_facebook_post`

## Instructions (Hướng dẫn cho AI Agent)

Bạn (AI Agent) sử dụng skill này khi người dùng yêu cầu "đặt lịch", "hẹn giờ" bài viết.

**NHIỆM VỤ QUAN TRỌNG NHẤT CỦA BẠN VỀ THỜI GIAN:**
Người dùng sẽ đưa ra yêu cầu bằng ngôn ngữ tự nhiên (Ví dụ: "8h tối nay", "9h sáng mai", "cuối tuần này").
Bạn BẮT BUỘC phải làm các bước sau trước khi chạy lệnh:

1. Xác định ngày giờ hiện tại của hệ thống.
2. Dựa vào yêu cầu của người dùng, tính toán ra mốc thời gian tương lai chính xác.
3. Chuyển đổi mốc thời gian đó sang định dạng **ISO 8601 (có kèm múi giờ, ví dụ: "2026-04-10T20:00:00+07:00")** HOẶC **Unix Timestamp (tính bằng giây)** và truyền vào biến `scheduled_publish_time`.

**Các quy tắc về API của Facebook:**

- Thời gian đặt lịch phải cách thời điểm hiện tại **ít nhất 11 phút** và **tối đa là 75 ngày**. (Nếu người dùng yêu cầu thời gian quá gần, hãy tự động cộng thêm 11 phút và thông báo cho họ biết).

**Lưu ý:**
- `access_token` và `page_id` đã được lưu cứng trong file, tác nhân AI không cần truyền các tham số này, script sẽ tự đặt lịch trên tất cả các trang đã cấu hình.

**Câu lệnh thực thi mẫu:**

```bash
node skills/schedule_facebook_post/action.js '{"caption_short": "Nội dung bài đăng", "media_paths": ["D:/.../anh.jpg"], "scheduled_publish_time": "2026-04-10T20:00:00+07:00"}'
```
