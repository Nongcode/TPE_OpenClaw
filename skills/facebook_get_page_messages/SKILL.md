---
name: facebook-get-page-messages
metadata:
  openclaw:
    skillKey: "facebook_get_page_messages"
description: Đọc thủ công inbox Facebook Page qua Graph API để lấy hội thoại gần nhất hoặc các hội thoại chưa được phản hồi.
requires:
  bins:
    - node
---

# Skill `facebook_get_page_messages`

## Mục tiêu

- Lấy danh sách hội thoại từ Facebook Page inbox.
- Có thể lấy kèm tin nhắn trong từng hội thoại để agent phân tích nhu cầu khách hàng.
- Hỗ trợ chế độ `recent` và `unreplied`.

## Input JSON

- `page_id` (optional nếu đã đặt `FACEBOOK_PAGE_ID` hoặc dùng mặc định)
- `access_token` (optional nếu đã đặt `FACEBOOK_PAGE_ACCESS_TOKEN`)
- `limit` (optional, default `10`)
- `mode` (optional, `recent` | `unreplied`, default `recent`)
- `include_messages` (optional, default `true`)
- `message_limit` (optional, default `20`)
- `graph_version` (optional, default `v20.0`)

## Lưu ý bảo mật

- Không hard-code token trong source.
- Khuyến nghị truyền `access_token` lúc chạy hoặc dùng biến môi trường `FACEBOOK_PAGE_ACCESS_TOKEN`.
- Skill không log token.

## Câu lệnh mẫu

```bash
node skills/facebook_get_page_messages/action.js '{"page_id":"643048852218433","access_token":"YOUR_PAGE_TOKEN","limit":10,"mode":"recent","include_messages":true}'
```

```bash
FACEBOOK_PAGE_ACCESS_TOKEN="YOUR_PAGE_TOKEN" node skills/facebook_get_page_messages/action.js '{"page_id":"643048852218433","limit":10,"mode":"unreplied"}'
```
