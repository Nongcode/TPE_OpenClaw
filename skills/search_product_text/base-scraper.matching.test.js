import test from "node:test";
import assert from "node:assert/strict";

import { pickBestProductCandidateForKeyword } from "./base-scraper.js";

test("pickBestProductCandidateForKeyword prefers exact red 3D 8 camera product over CCD blue variant", () => {
  const keyword = "Thiết bị kiểm tra góc đặt bánh xe công nghệ 3D 8 camera xoay tự động (màu đỏ)";
  const candidates = [
    {
      title: "Thiết bị kiểm tra góc đặt bánh xe công nghệ CCD dùng cho xe tải, bus (màu xanh)",
      url: "https://uptek.vn/shop/mana-jumbo9000-thiet-bi-kiem-tra-goc-dat-banh-xe-cong-nghe-ccd-dung-cho-xe-tai-bus-mau-xanh-53558",
      category: { name: "Thiết bị kiểm tra góc đặt bánh xe", url: "https://uptek.vn/shop/category/demo" },
    },
    {
      title: "Thiết bị kiểm tra góc đặt bánh xe công nghệ 3D 8 camera xoay tự động (màu đỏ)",
      url: "https://uptek.vn/shop/cogi-exactblacktechplusxr-03-thiet-bi-kiem-tra-goc-dat-banh-xe-cong-nghe-3d-8-camera-xoay-tu-dong-mau-do-59293",
      category: { name: "Thiết bị kiểm tra góc đặt bánh xe", url: "https://uptek.vn/shop/category/demo" },
    },
  ];

  const picked = pickBestProductCandidateForKeyword(candidates, keyword);
  assert.equal(picked?.title, candidates[1].title);
});
