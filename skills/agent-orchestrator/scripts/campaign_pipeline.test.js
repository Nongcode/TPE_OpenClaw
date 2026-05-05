const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  extractProductModel,
  isWindowsAbsolutePath,
  resolveAgentReportedPath,
} = require("./campaign_pipeline");

test("isWindowsAbsolutePath detects Windows drive-letter paths", () => {
  assert.equal(isWindowsAbsolutePath("D:\\output\\image.png"), true);
  assert.equal(isWindowsAbsolutePath("/tmp/output/image.png"), false);
});

test("resolveAgentReportedPath keeps Windows absolute path intact", () => {
  assert.equal(resolveAgentReportedPath("D:\\output\\image.png"), "D:\\output\\image.png");
});

test("resolveAgentReportedPath expands repo artifacts path", () => {
  const resolved = resolveAgentReportedPath("artifacts/generated/image.png");

  assert.equal(
    resolved,
    path.join(path.resolve(__dirname, "..", "..", ".."), "artifacts", "generated", "image.png"),
  );
});

test("extractProductModel prefers explicit Model field from product profile", () => {
  const model = extractProductModel({
    specifications: ["Model: HD 500", "Thuong hieu: CORGHI"],
    product_description: "Model: WRONG",
    product_name: "May ra vao lop xe tai",
  });

  assert.equal(model, "HD 500");
});

test("extractProductModel falls back to research product id when needed", () => {
  const model = extractProductModel(
    {
      specifications: [],
      product_description: "",
      product_name: "Thiet bi can bang lop",
    },
    {
      product_ids: { product_id: "EXACT LINEAR" },
      product_name: "Thiet bi kiem tra goc dat banh xe",
    },
  );

  assert.equal(model, "EXACT LINEAR");
});
