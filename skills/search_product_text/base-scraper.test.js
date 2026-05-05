import test from "node:test";
import assert from "node:assert/strict";

import { extractDirectProductUrl, extractProductIntentKeyword } from "./base-scraper.js";

test("extractProductIntentKeyword prefers TEN_SAN_PHAM labels", () => {
  const keyword = extractProductIntentKeyword(
    "DU_LIEU_SAN_PHAM_BAT_BUOC:\nTEN_SAN_PHAM: May can bang lop tu dong\nURL_SAN_PHAM: https://example.com",
  );

  assert.equal(keyword, "May can bang lop tu dong");
});

test("extractDirectProductUrl prefers exact product URL from a workflow brief", () => {
  const productUrl = extractDirectProductUrl(
    'Cap nhat brief cho workflow dang cho duyet content. San pham dung can trien khai quang cao Facebook. Link san pham: https://uptek.vn/shop/cogi-exactblacktechplusxr-03-thiet-bi-kiem-tra-goc-dat-banh-xe-cong-nghe-3d-8-camera-xoay-tu-dong-mau-do-59293?category=1560#attr=158513',
    "uptek.vn",
  );

  assert.equal(
    productUrl,
    "https://uptek.vn/shop/cogi-exactblacktechplusxr-03-thiet-bi-kiem-tra-goc-dat-banh-xe-cong-nghe-3d-8-camera-xoay-tu-dong-mau-do-59293?category=1560#attr=158513",
  );
});
