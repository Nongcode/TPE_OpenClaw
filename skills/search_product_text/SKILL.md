---
name: search-product-text
description: Tìm trang sản phẩm trên website công ty qua Google và cào plain text sản phẩm, gồm tên và thông số kỹ thuật, để agent content viết bài dựa trên dữ liệu thật.
requires:
  bins:
    - node
---

# Skill `search_product_text`

## Khi nào dùng

Dùng skill này khi cần tìm nhanh một sản phẩm trên website công ty và lấy ra:
- URL sản phẩm
- tên sản phẩm
- thông số kỹ thuật hoặc mô tả chi tiết dưới dạng plain text

## Cách dùng

Chạy đúng file `skills/search_product_text/action.js`.

Ví dụ:

```bash
node skills/search_product_text/action.js --keyword "cầu nâng 2 trụ" --target_site "tanphatetek.com"
```

Hoặc truyền JSON:

```bash
node skills/search_product_text/action.js "{\"keyword\":\"cầu nâng 2 trụ\",\"target_site\":\"tanphatetek.com\"}"
```

## Quy tắc đầu ra

- Script chỉ được in đúng một khối JSON ra `stdout`.
- Không `console.log` thêm text rác.
- Nếu không tìm được sản phẩm hoặc cào thất bại, vẫn trả JSON với `success: false`.
