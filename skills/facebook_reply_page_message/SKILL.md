---
name: facebook-reply-page-message
metadata:
  openclaw:
    skillKey: "facebook_reply_page_message"
description: Gửi phản hồi thủ công cho khách hàng qua Facebook Messenger/Page Graph API.
requires:
  bins:
    - node
---

# Skill `facebook_reply_page_message`

## Mục tiêu

- Gửi tin nhắn trả lời tới đúng `recipient_id` trong inbox Page.
- Hỗ trợ `dry_run` để chỉ tạo nháp, chưa gửi thật.

## Input JSON

- `page_id` (optional nếu đã đặt `FACEBOOK_PAGE_ID` hoặc dùng mặc định)
- `access_token` (optional nếu đã đặt `FACEBOOK_PAGE_ACCESS_TOKEN`)
- `recipient_id` (required)
- `reply_text` (required)
- `dry_run` (optional, default `false`)
- `graph_version` (optional, default `v20.0`)

## Lưu ý bảo mật

- Không hard-code token trong source.
- Không log lộ `access_token`.
- Endpoint và `recipient_id` vẫn được log để tiện audit/debug.

## Câu lệnh mẫu

```bash
node skills/facebook_reply_page_message/action.js '{"page_id":"643048852218433","access_token":"YOUR_PAGE_TOKEN","recipient_id":"USER_PSID","reply_text":"Dạ em đã nhận tin nhắn và sẽ tư vấn ngay ạ."}'
```

```bash
FACEBOOK_PAGE_ACCESS_TOKEN="YOUR_PAGE_TOKEN" node skills/facebook_reply_page_message/action.js '{"page_id":"643048852218433","recipient_id":"USER_PSID","reply_text":"Dạ em gửi nháp phản hồi.","dry_run":true}'
```
