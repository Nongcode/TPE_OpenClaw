---
name: generate-sales-content
metadata:
  openclaw:
    skillKey: "generate_sales_content"
description: Sinh nội dung bán hàng online từ `product_profile` (caption, CTA, hashtag, image/video prompt) và lưu artifact.
requires:
  bins:
    - node
---

# Skill `generate_sales_content`

## Instructions (Hướng dẫn cho AI Agent)

Để sử dụng skill này, bạn (AI Agent) PHẢI thực thi file `skills/generate_sales_content/action.js` bằng lệnh dòng lệnh `node`, truyền đầu vào là một chuỗi JSON hợp lệ được đặt trong dấu ngoặc kép đơn (`'`). Đầu vào JSON này có thể là object `product_profile` trực tiếp.

**Câu lệnh thực thi:**

```bash
node skills/generate_sales_content/action.js '{"product_name": "...", "product_description": "..."}'
```
