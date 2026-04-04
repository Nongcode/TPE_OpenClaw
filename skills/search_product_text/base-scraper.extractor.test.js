import test from "node:test";
import assert from "node:assert/strict";

import { extractProductIntentKeyword } from "./base-scraper.js";

test("extractProductIntentKeyword prefers YEU_CAU_GOC_SAN_PHAM labels", () => {
  const keyword = extractProductIntentKeyword(
    "YEU_CAU_GOC_SAN_PHAM: Thiết bị hứng, hút dầu thải hoạt động khí nén 80 lít URL_SAN_PHAM: https://uptek.vn/shop/example",
  );

  assert.equal(keyword, "Thiết bị hứng, hút dầu thải hoạt động khí nén 80 lít");
});

test("extractProductIntentKeyword prefers keyword sạch labels", () => {
  const keyword = extractProductIntentKeyword(
    "keyword sạch chỉ gồm tên sản phẩm: Thiết bị hứng, hút dầu thải hoạt động khí nén 80 lít",
  );

  assert.equal(keyword, "Thiết bị hứng, hút dầu thải hoạt động khí nén 80 lít");
});
