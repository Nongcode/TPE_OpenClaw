---
name: trend-analyzer
description: "Lấy 5 từ khóa/hashtag đang hot nhất tuần từ Google Trends cho thị trường Việt Nam. Input: keyword. Output: danh sách trends + related queries."
---

# Trend Analyzer

## Overview

Skill phân tích xu hướng tìm kiếm Google Trends, trả về danh sách hashtag/keyword đang hot nhất liên quan đến chủ đề đầu vào.

## Input

```json
{
  "keyword": "máy nâng hàng",
  "geo": "VN",
  "count": 5
}
```

- `keyword` (bắt buộc): Từ khóa gốc để tìm trends.
- `geo` (tùy chọn, mặc định `"VN"`): Mã quốc gia Google Trends.
- `count` (tùy chọn, mặc định `5`): Số lượng trends trả về.

## Output

```json
{
  "success": true,
  "data": {
    "keyword": "máy nâng hàng",
    "geo": "VN",
    "trends": ["#maynang", "#forklift", "#khonangmay", "#thietbicongnghiep", "#logistic"],
    "related_queries": ["máy nâng điện", "máy nâng tay", "giá máy nâng"],
    "fetched_at": "2026-04-09T..."
  }
}
```

## Cách chạy

```bash
node D:/CodeAiTanPhat/TPE_OpenClaw/skills/trend_analyzer/action.js '{"keyword":"máy nâng","geo":"VN","count":5}'
```

## Lưu ý

- Cần Internet để truy cập Google Trends.
- Nếu API lỗi, skill sẽ trả mảng rỗng (degrade gracefully), không crash.
- Kết quả chỉ mang tính tham khảo, NV Content tự quyết định dùng hashtag nào phù hợp.
