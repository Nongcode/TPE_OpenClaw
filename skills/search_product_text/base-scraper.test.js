import test from "node:test";
import assert from "node:assert/strict";

import { extractProductIntentKeyword } from "./base-scraper.js";

test("extractProductIntentKeyword keeps the actual product from a long workflow sentence", () => {
  const keyword = extractProductIntentKeyword(
    "Triển khai nhanh 1 gói bài Facebook quảng bá sản phẩm tủ đựng đồ 7 ngăn để trình trưởng phòng duyệt trước khi đăng.",
  );

  assert.equal(keyword, "tủ đựng đồ 7 ngăn");
});

test("extractProductIntentKeyword prefers TEN_SAN_PHAM labels", () => {
  const keyword = extractProductIntentKeyword(
    "DU_LIEU_SAN_PHAM_BAT_BUOC:\nTEN_SAN_PHAM: Máy cân bằng lốp tự động\nURL_SAN_PHAM: https://example.com",
  );

  assert.equal(keyword, "Máy cân bằng lốp tự động");
});
