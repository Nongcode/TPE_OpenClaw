const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assessProductResearchAlignment,
  buildProductResearchMismatchReply,
  buildOriginalImageMediaReply,
  classifyReviewDecision,
  shouldForceOriginalImageMedia,
} = require("./executor");

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

test("classifyReviewDecision returns unknown when no approval or revision signal", () => {
  const reply = `
KET_QUA:
- Da tiep nhan va tong hop thong tin.

RUI_RO:
- Chua xac dinh.

DE_XUAT_BUOC_TIEP:
- Tiep tuc danh gia.
`;

  assert.equal(classifyReviewDecision(reply), "unknown");
});

test("classifyReviewDecision prioritizes revision when reply contains both dat and chua dat", () => {
  const reply = `
KET_QUA:
- Content: dat.
- Media: chua dat, khong du dieu kien nghiem thu.

RUI_RO:
- Neu day tiep se gay loi quy trinh.

DE_XUAT_BUOC_TIEP:
- Agent tiep theo: nv_media sua lai.
`;

  assert.equal(classifyReviewDecision(reply), "revise");
});

test("shouldForceOriginalImageMedia enables forced mode for media pipeline when original images exist", () => {
  const workflowState = {
    productResearch: {
      data: {
        images: [{ file_path: "artifacts/references/search_product_text/a.jpg" }],
      },
    },
  };
  const plan = { steps: [{ type: "media_review" }] };

  assert.equal(
    shouldForceOriginalImageMedia({ type: "produce", to: "nv_media" }, workflowState, plan),
    true,
  );
  assert.equal(shouldForceOriginalImageMedia({ type: "media_review" }, workflowState, plan), true);
  assert.equal(shouldForceOriginalImageMedia({ type: "compile_post" }, workflowState, plan), true);
  assert.equal(shouldForceOriginalImageMedia({ type: "final_review" }, workflowState, plan), true);
  assert.equal(shouldForceOriginalImageMedia({ type: "produce", to: "nv_content" }, workflowState, plan), false);
});

test("buildOriginalImageMediaReply emits approval and original image assets for media_review", () => {
  const workflowState = {
    finalContent: "Noi dung final",
    imagePrompt: "Prompt anh",
    videoPrompt: "Prompt video",
    productResearch: {
      data: {
        images: [
          { file_path: "artifacts/references/search_product_text/a.jpg" },
          { file_path: "artifacts/references/search_product_text/b.jpg" },
        ],
      },
    },
  };

  const reply = buildOriginalImageMediaReply({ type: "media_review" }, workflowState);
  assert.match(reply, /DUYET PASS media/i);
  assert.match(reply, /a\.jpg/);
  assert.match(reply, /b\.jpg/);
  assert.match(reply, /IMAGE_PROMPT:\s*Prompt anh/);
  assert.equal(classifyReviewDecision(reply), "approved");
});

test("assessProductResearchAlignment flags unrelated product names as mismatch", () => {
  const result = assessProductResearchAlignment("tủ đựng đồ 7 ngăn", "Cầu nâng cắt kéo 4,3 tấn");
  assert.equal(result.aligned, false);
  assert.equal(result.reason, "weak-overlap");
});

test("assessProductResearchAlignment accepts close product matches", () => {
  const result = assessProductResearchAlignment(
    "tủ đựng đồ 7 ngăn",
    "Tủ đựng đồ 7 ngăn bằng thép sơn tĩnh điện",
  );
  assert.equal(result.aligned, true);
});

test("buildProductResearchMismatchReply includes requested and found products", () => {
  const reply = buildProductResearchMismatchReply({
    requestedKeyword: "tủ đựng đồ 7 ngăn",
    productName: "Cầu nâng cắt kéo 4,3 tấn",
    productUrl: "https://example.com/product",
    alignment: { overlapTokens: [] },
  });

  assert.match(reply, /YÊU_CẦU_GỐC_SẢN_PHẨM: tủ đựng đồ 7 ngăn/);
  assert.match(reply, /SẢN_PHẨM_ĐÃ_TÌM_ĐƯỢC: Cầu nâng cắt kéo 4,3 tấn/);
});
