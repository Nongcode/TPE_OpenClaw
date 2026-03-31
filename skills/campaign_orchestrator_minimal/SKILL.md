---
name: campaign-orchestrator-minimal
metadata:
  openclaw:
    skillKey: "campaign_orchestrator_minimal"
description: "Nhạc trưởng tự động: Chuẩn hóa -> Viết Content -> Tạo Ảnh -> Tạo Video -> Chuẩn bị/đăng bài ảnh -> Chuẩn bị/đăng bài video -> Lưu báo cáo."
requires:
  bins:
    - node
---

# Skill `campaign_orchestrator_minimal`

## Input Parameters

### Thông tin sản phẩm

- `product_name` (required)
- `product_description` (required)
- `specifications` (optional)
- `selling_points` (optional)

### Cấu hình Gemini / Facebook

Các tham số dưới đây có thể bỏ qua nếu hệ thống đã có cấu hình mặc định trong `action.js` hoặc môi trường:

- `browser_path` (optional)
- `user_data_dir` (optional)
- `profile_name` (optional)
- `target_gemini_image_url` (optional)
- `target_gemini_video_url` (optional)
- `page_id` (optional nếu đã cấu hình sẵn)
- `access_token` (optional nếu đã cấu hình sẵn)

### Điều khiển publish

- `facebook_publish_mode` (optional) — `confirm_only` | `publish_now`
- `publish_image_post` (optional)
- `publish_video_post` (optional)
- `allow_text_only_fallback` (optional)
- `retry_count` (optional)
- `timeout_ms` (optional)
- `dry_run` (optional)

## Flow cố định

1. `normalize_product_input`: Chuẩn hóa dữ liệu sản phẩm
2. `generate_sales_content`: Viết content marketing và prompt media
3. `gemini_generate_image`: Tạo ảnh quảng cáo
4. `generate_video`: Tạo video quảng cáo
5. `facebook_publish_post`: Chuẩn bị/đăng bài ảnh
6. `facebook_publish_post`: Chuẩn bị/đăng bài video
7. Lưu file `summary.json`

## Kết quả đầu ra

- Nội dung marketing
- Ảnh quảng cáo
- Video quảng cáo
- Kết quả publish bài ảnh
- Kết quả publish bài video
- File `summary.json`
