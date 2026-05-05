---
name: facebook-publish-group-post
metadata:
  openclaw:
    skillKey: "facebook_publish_group_post"
description: Tự động đăng bài (chữ + ảnh/video) lên các Hội/Nhóm Facebook qua trình duyệt Chrome thật (Playwright + persistent profile). Dùng identity hiện tại của profile (đã set sẵn là Page). Auto-skip group cấm Page tham gia.
requires:
  bins:
    - node
---

# Skill `facebook_publish_group_post`

## Mục đích

Đăng bài lên nhiều Group Facebook bằng trình duyệt Chrome thật. Khác với `facebook_publish_post` (dùng Graph API cho Fanpage), skill này **không thể dùng API** vì Facebook đã chặn `publish_to_groups` từ 04/2024 → bắt buộc phải dùng browser automation.

## Yêu cầu vận hành

- **Chrome đã được cài** tại `C:/Program Files/Google/Chrome/Application/chrome.exe`.
- **Profile `Default`** đã đăng nhập Facebook và **đã chuyển identity sang Page** trước khi chạy skill.
- **Đóng tất cả cửa sổ Chrome** trước khi chạy (Playwright sẽ launch persistent context — Chrome khóa user-data-dir nếu đang chạy).
- Profile đã **được admin các group duyệt làm member**.

## Hành vi quan trọng

- Skill **không tự switch identity** — dùng nguyên identity Page mà bạn đã chọn sẵn trong Chrome.
- **Auto-skip** group có banner `"Nhóm này không cho phép các trang tham gia"` (status `skipped` với `reason: "page_blocked"`).
- **Auto-skip** group nếu profile chưa là member (`reason: "not_member"`).
- Random delay 25–55s giữa 2 group để tránh spam-detect.
- Concurrency-safe: dùng `shared/browser-profile-lock.js` (cùng profile không bị 2 process tranh nhau).

## Cấu hình group

Sửa `config/target-groups.json`. Mỗi group có:

```json
{ "id": "412910482507838", "url": "https://www.facebook.com/groups/412910482507838/", "enabled": true, "status": "approved" }
```

- `enabled: false` → skill bỏ qua (dùng cho group đang `pending_approval`).
- Khi admin duyệt xong, đổi `enabled: true`.

## Cách AI Agent gọi skill

```bash
node skills/facebook_publish_group_post/action.js '{"caption_short": "Nội dung bài viết", "media_paths": ["D:/path/anh.jpg"]}'
```

### Tham số JSON

| Key | Type | Mô tả |
|---|---|---|
| `caption_short` hoặc `caption_long` | string | **Bắt buộc** — nội dung bài viết |
| `media_paths` | string[] | Optional — ảnh/video (đường dẫn tuyệt đối) |
| `group_ids` | string[] | Optional — chỉ đăng vào subset group cụ thể; mặc định = tất cả group `enabled: true` |
| `max_groups` | number | Optional — giới hạn số group/lần (default 9) |
| `delay_min_ms` / `delay_max_ms` | number | Optional — khoảng delay random (default 25000–55000) |
| `dry_run` | boolean | Optional — không mở browser, chỉ in plan |

## Output

```json
{
  "success": true,
  "message": "Posted: 7, Skipped: 1, Failed: 1",
  "data": {
    "results": [
      { "group_id": "412910482507838", "success": true, "screenshot_path": "..." },
      { "group_id": "511947023271334", "success": false, "skipped": true, "reason": "page_blocked" }
    ],
    "summary": { "succeeded": 7, "skipped": 1, "failed": 1, "total": 9 }
  }
}
```

Screenshot mỗi group được lưu tại `skills/facebook_publish_group_post/.screenshots/`.

## Troubleshooting

- **"Chrome đang chạy với profile này"** → đóng hết cửa sổ Chrome, chạy lại.
- **`reason: page_blocked` ở 1 group** → group đó cấm Page; muốn đăng phải chuyển identity cá nhân (ngoài scope skill này).
- **`reason: not_member`** → profile chưa join group hoặc admin chưa duyệt request.
- **Composer không tìm thấy** → FB đã đổi DOM; cập nhật selectors trong `lib/selectors.js`.
