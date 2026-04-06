const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractBestContent,
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

test("classifyReviewDecision keeps approval when review has light edit notes but allows media handoff", () => {
  const reply = `
KET_QUA:
- Da duyet ban nhap content va danh gia: dat yeu cau de chuyen sang brief media.
- Yeu cau chinh sua nhe truoc khi dong goi sang media:
- Giu giong van gon hon khi len post chinh thuc.

RUI_RO:
- Chua co thong so ky thuat sau.

DE_XUAT_BUOC_TIEP:
- Agent tiep theo: nv_media
- Chuyen sang brief media.
`;

  assert.equal(classifyReviewDecision(reply), "approved");
});

test("shouldForceOriginalImageMedia stays disabled because media now uses real generation skills", () => {
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
    false,
  );
  assert.equal(shouldForceOriginalImageMedia({ type: "media_review" }, workflowState, plan), false);
  assert.equal(shouldForceOriginalImageMedia({ type: "compile_post" }, workflowState, plan), false);
  assert.equal(shouldForceOriginalImageMedia({ type: "final_review" }, workflowState, plan), false);
  assert.equal(shouldForceOriginalImageMedia({ type: "produce", to: "nv_content" }, workflowState, plan), false);
});

test("buildOriginalImageMediaReply legacy helper still lists prompts and assets", () => {
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

test("extractBestContent prefers cleaned caption body over draft narration", () => {
  const reply = `
KET_QUA

Toi da hoan thanh ban nhap content Facebook cho san pham de pho_phong review, chua chuyen sang media.

**Caption de xuat:**

Gara dang can mot thiet bi lam sach khoang may va noi that nhanh hon?

May rua hoi nuoc nong 27 Lit la lua chon phu hop cho xuong dich vu can quy trinh gon hon.

Inbox ngay de duoc tu van thiet bi phu hop.

**Caption ngan du phong:**
May rua hoi nuoc nong 27 Lit cho gara.

RUI_RO
- Chua co gia.
`;

  const extracted = extractBestContent(reply);
  assert.doesNotMatch(extracted, /ban nhap content Facebook/i);
  assert.match(extracted, /Gara dang can/);
  assert.match(extracted, /Inbox ngay/);
});
