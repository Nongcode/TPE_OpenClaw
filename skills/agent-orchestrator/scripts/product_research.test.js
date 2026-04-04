const test = require("node:test");
const assert = require("node:assert/strict");

const { extractProductKeywordFromMessage } = require("./product_research");

test("extractProductKeywordFromMessage picks the product after 'sản phẩm'", () => {
  const keyword = extractProductKeywordFromMessage(
    "Triển khai nhanh 1 gói bài Facebook quảng bá sản phẩm tủ đựng đồ 7 ngăn để trình truong_phong duyệt trước khi đăng.",
  );

  assert.equal(keyword, "tủ đựng đồ 7 ngăn");
});

test("extractProductKeywordFromMessage prefers TEN_SAN_PHAM labels from handoff context", () => {
  const keyword = extractProductKeywordFromMessage(
    "DU_LIEU_SAN_PHAM_BAT_BUOC:\nTEN_SAN_PHAM: Tủ đựng đồ 7 ngăn\nURL_SAN_PHAM: https://example.com",
  );

  assert.equal(keyword, "Tủ đựng đồ 7 ngăn");
});
