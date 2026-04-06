const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMediaSpecificContent } = require("./campaign_pipeline");

test("buildMediaSpecificContent emits cleaned SEO captions for publish", () => {
  const finalContent = `
Da trien khai bai viet cho san pham **Thiet bi nang banh xe hoat dong khi nen** nhu sau:

**Hook goi y:**
Giam suc nang banh, tang toc thao tac can bang lop tai gara.

**Bai viet de xuat:**
Trong khu vuc lam lop, viec dua banh xe len dung vi tri tren may can bang thuong ton suc va mat thoi gian.

**Thiet bi nang banh xe hoat dong khi nen** la phu kien dung cho **may can bang lop**, giup thao tac nhe hon.

**Loi ich noi bat:**
- Giam thao tac nang thu cong
- Tang toc do thao tac

**CTA goi y:**
Lien he Tan Phat ETEK de duoc tu van giai phap phu hop.
`;

  const salesContent = {
    caption_short: "Thiet bi nang banh xe - giai phap cho gara.",
    cta: "Lien he Tan Phat ETEK de duoc tu van.",
    hashtags: ["#ThietBiNangBanhXe", "#MayCanBangLop"],
  };
  const productProfile = {
    product_name: "Thiet bi nang banh xe hoat dong khi nen",
  };

  const mediaContent = buildMediaSpecificContent(finalContent, salesContent, productProfile);

  assert.doesNotMatch(mediaContent.image.caption_long, /Hook goi y|Bai viet de xuat|CTA goi y/i);
  assert.doesNotMatch(mediaContent.image.caption_long, /Hinh anh san pham va key visual/i);
  assert.doesNotMatch(mediaContent.video.caption_long, /Xem video demo de thay ro/i);
  assert.doesNotMatch(mediaContent.image.caption_long, /\*\*/);
  assert.match(mediaContent.image.caption_long, /Lien he Tan Phat ETEK/);
  assert.match(mediaContent.image.caption_long, /#ThietBiNangBanhXe #MayCanBangLop/);
});
