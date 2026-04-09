const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyContentDecision,
  classifyMediaDecision,
  extractBlock,
  extractField,
  parseContentReply,
  parseMediaReply,
} = require("./orchestrator");

test("classifyContentDecision detects approval", () => {
  assert.equal(classifyContentDecision("Duyet content, tao anh"), "approve");
});

test("classifyContentDecision detects rejection", () => {
  assert.equal(classifyContentDecision("Sua content, bai chua dat"), "reject");
});

test("classifyMediaDecision detects publish approval", () => {
  assert.equal(classifyMediaDecision("Duyet anh va dang bai"), "approve");
});

test("extract helpers read workflow markers", () => {
  const reply = `
WORKFLOW_META:
- workflow_id: wf_test
- step_id: step_01_content

TRANG_THAI:
- status: completed

KET_QUA:
PRODUCT_NAME: Cau nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
APPROVED_CONTENT_BEGIN
Noi dung bai dang
APPROVED_CONTENT_END

RUI_RO:
- khong co

DE_XUAT_BUOC_TIEP:
- cho user duyet
`;
  assert.equal(extractField(reply, "PRODUCT_NAME"), "Cau nang 2 tru");
  assert.equal(extractBlock(reply, "APPROVED_CONTENT_BEGIN", "APPROVED_CONTENT_END"), "Noi dung bai dang");
  const parsed = parseContentReply(reply);
  assert.equal(parsed.productUrl, "https://example.test/product");
  assert.equal(parsed.imageDir, "D:\\images");
});

test("parseMediaReply reads image prompt and output path", () => {
  const reply = `
WORKFLOW_META:
- workflow_id: wf_test
- step_id: step_02_media

TRANG_THAI:
- status: completed

KET_QUA:
IMAGE_PROMPT_BEGIN
Prompt tieng Viet
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: D:\\output\\image.png

RUI_RO:
- khong co

DE_XUAT_BUOC_TIEP:
- cho user duyet
`;
  const parsed = parseMediaReply(reply);
  assert.equal(parsed.imagePrompt, "Prompt tieng Viet");
  assert.equal(parsed.generatedImagePath, "D:\\output\\image.png");
});
