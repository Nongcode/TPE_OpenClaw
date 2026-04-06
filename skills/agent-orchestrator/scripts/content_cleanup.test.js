const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPublishTextFromSections, extractContentSections } = require("./content_cleanup");

test("extractContentSections removes internal labels and preserves public-facing body", () => {
  const raw = `
Da trien khai bai viet cho san pham **Thiet bi nang banh xe** nhu sau:

**Hook goi y:**
Giam suc nang banh, tang toc thao tac can bang lop tai gara.

**Bai viet de xuat:**
Trong khu vuc lam lop, viec dua banh xe len dung vi tri tren may can bang thuong ton suc.

**Thiet bi nang banh xe** la phu kien dung cho **may can bang lop**, giup thao tac nhe hon.

**Loi ich noi bat:**
- Giam thao tac nang thu cong
- Tang toc do thao tac

**Thong tin san pham:**
- Model: **8-21100230**

**CTA goi y:**
Lien he Tan Phat ETEK de duoc tu van giai phap phu hop.
`;

  const sections = extractContentSections(raw);
  const publishText = buildPublishTextFromSections(sections);

  assert.equal(sections.hook, "Giam suc nang banh, tang toc thao tac can bang lop tai gara.");
  assert.match(sections.body, /Trong khu vuc lam lop/);
  assert.match(sections.body, /Thong tin san pham:/);
  assert.match(sections.cta, /Lien he Tan Phat ETEK/);
  assert.doesNotMatch(publishText, /Hook goi y|Bai viet de xuat|CTA goi y/i);
  assert.doesNotMatch(publishText, /\*\*/);
});
