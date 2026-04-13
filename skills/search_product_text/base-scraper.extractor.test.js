import test from "node:test";
import assert from "node:assert/strict";

import { extractProductIntentKeyword } from "./base-scraper.js";

test("extractProductIntentKeyword prefers YEU_CAU_GOC_SAN_PHAM labels", () => {
  const keyword = extractProductIntentKeyword(
    "YEU_CAU_GOC_SAN_PHAM: Thiet bi hung, hut dau thai hoat dong khi nen 80 lit URL_SAN_PHAM: https://uptek.vn/shop/example",
  );

  assert.equal(keyword, "Thiet bi hung, hut dau thai hoat dong khi nen 80 lit");
});

test("extractProductIntentKeyword prefers keyword sach labels", () => {
  const keyword = extractProductIntentKeyword(
    "keyword sach chi gom ten san pham: Thiet bi hung, hut dau thai hoat dong khi nen 80 lit",
  );

  assert.equal(keyword, "Thiet bi hung, hut dau thai hoat dong khi nen 80 lit");
});
