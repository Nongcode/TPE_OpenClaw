const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyReviewDecision } = require("./executor");

test("classifyReviewDecision marks explicit approval as approved", () => {
  const reply = `
KET_QUA:
- Toi duyet pass noi dung o vong nay.
- Ban caption hien tai giu nguyen, khong can sua them.

RUI_RO:
- Neu sau nay can bo sung CTA thi xem xet sau.

DE_XUAT_BUOC_TIEP:
- Agent tiep theo: truong_phong.
`;

  assert.equal(classifyReviewDecision(reply), "approved");
});

test("classifyReviewDecision marks explicit revision request as revise", () => {
  const reply = `
KET_QUA:
- Toi chua duyet ban nay.
- Content can sua lai tieu de va bo sung thong so.

RUI_RO:
- Neu giu nguyen se de sai lech.

DE_XUAT_BUOC_TIEP:
- Agent tiep theo: nv_content sua lai.
`;

  assert.equal(classifyReviewDecision(reply), "revise");
});
