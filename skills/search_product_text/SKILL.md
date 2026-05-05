---
name: search-product-text
description: Tìm trang sản phẩm trên website công ty qua Google, lấy đầy đủ text sản phẩm, danh mục, thông số và tải ảnh sản phẩm chất lượng cao về local để agent content viết bài dựa trên dữ liệu thật.
requires:
  bins:
    - node
---

# Skill `search_product_text`

## Khi nào dùng

Dùng skill này khi cần tìm nhanh một sản phẩm trên website công ty và lấy ra:

- URL sản phẩm
- tên sản phẩm
- danh mục sản phẩm
- thông số kỹ thuật, thuộc tính, mô tả chi tiết dưới dạng plain text
- danh sách ảnh sản phẩm và file ảnh đã tải về local

## Cách dùng

Chạy đúng file `skills/search_product_text/action.js`.

Ví dụ:

```bash
node skills/search_product_text/action.js --keyword "cầu nâng 2 trụ" --target_site "uptek.vn"
```

Khi đã có đúng link sản phẩm, ưu tiên truyền thẳng URL thay vì để skill tự search:

```bash
node skills/search_product_text/action.js --product_url "https://uptek.vn/shop/ten-san-pham-12345" --target_site "uptek.vn"
```

Khi biết trước nhóm/ngành hàng, truyền thêm `--category_hint` để tăng độ chính xác:

```bash
node skills/search_product_text/action.js --keyword "GL-3.2-2E" --target_site "uptek.vn" --category_hint "Cầu nâng"
```

Hoặc truyền JSON:

```bash
node skills/search_product_text/action.js "{\"keyword\":\"cầu nâng 2 trụ\",\"target_site\":\"tanphatetek.com\",\"category_hint\":\"Cầu nâng\"}"
```

Nếu JSON/brief có chứa URL sản phẩm của đúng site đích, skill sẽ ưu tiên bám URL đó trước khi fallback sang search bằng keyword.

## Đầu ra

Script trả về đúng một khối JSON trên `stdout`, trong đó phần `data` có các trường quan trọng:

- `product_url`, `product_name`
- `category`, `categories`
- `specifications`, `specifications_text`
- `content_sections`, `long_description`
- `images`, `primary_image`, `image_download_dir`

Ảnh sản phẩm được tải về thư mục:

```bash
artifacts/references/search_product_text/<ten-san-pham>/
```

## Quy tắc đầu ra

- Script chỉ được in đúng một khối JSON ra `stdout`.
- Không `console.log` thêm text rác.
- Nếu không tìm được sản phẩm hoặc cào thất bại, vẫn trả JSON với `success: false`.
