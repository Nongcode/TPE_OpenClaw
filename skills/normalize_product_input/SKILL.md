---
name: normalize-product-input
metadata:
  openclaw:
    skillKey: "normalize_product_input"
description: Chuẩn hóa dữ liệu sản phẩm đầu vào thành `product_profile` JSON thống nhất và lưu artifact.
requires:
  bins:
    - node
---

# Skill `normalize_product_input`

## Instructions (Hướng dẫn cho AI Agent)

Để sử dụng skill này, bạn (AI Agent) PHẢI thực thi file `skills/normalize_product_input/action.js` bằng lệnh dòng lệnh `node`, truyền đầu vào là một chuỗi JSON hợp lệ được đặt trong dấu ngoặc kép đơn (`'`).

**Câu lệnh thực thi:**

```bash
node skills/normalize_product_input/action.js '{"product_name": "...", "product_description": "..."}'
```
