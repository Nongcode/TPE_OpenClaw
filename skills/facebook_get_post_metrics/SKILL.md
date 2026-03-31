---
name: facebook-get-post-metrics
metadata:
  openclaw:
    skillKey: "facebook_get_post_metrics"
description: Thu thập tổng số lượt Like, Comment và chi tiết nội dung từng Comment (Tên khách hàng, nội dung) của bài viết qua Graph API.
requires:
  bins:
    - node
---

# Skill `facebook_get_post_metrics`

## Instructions (Hướng dẫn cho AI Agent)

Bạn dùng skill này để kiểm tra lượng tương tác và thu thập Data khách hàng bình luận trên bài viết.
Yêu cầu bắt buộc: Phải truyền vào `post_id` (được trả về từ bước publish).

**Câu lệnh thực thi:**

```bash
node skills/facebook_get_post_metrics/action.js '{"post_id": "ID_BAI_VIET"}'
```
