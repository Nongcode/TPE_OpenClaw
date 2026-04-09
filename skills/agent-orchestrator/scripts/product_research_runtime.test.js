const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.OPENCLAW_PRODUCT_RESEARCH_CACHE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "tests",
  "product-research-cache",
);

const {
  readCachedResearch,
  resolveKeyword,
  writeCachedResearch,
} = require("./product_research_runtime");

test.beforeEach(() => {
  try {
    fs.rmSync(process.env.OPENCLAW_PRODUCT_RESEARCH_CACHE_DIR, { recursive: true, force: true });
  } catch {}
});

test.after(() => {
  try {
    fs.rmSync(process.env.OPENCLAW_PRODUCT_RESEARCH_CACHE_DIR, { recursive: true, force: true });
  } catch {}
});

test("resolveKeyword strips execution instructions after product name", () => {
  const keyword = resolveKeyword(
    { message: "Viet bai Facebook cho cau nang 1 tru rua xe de toi duyet va dang Facebook" },
    { message: "" },
    {},
  );

  assert.equal(keyword, "cau nang 1 tru rua xe");
});

test("resolveKeyword prefers quoted product names", () => {
  const keyword = resolveKeyword(
    { message: 'Tao bai viet cho san pham "may ra vao lop xe tai" de dang Facebook' },
    { message: "" },
    {},
  );

  assert.equal(keyword, "may ra vao lop xe tai");
});

test("resolveKeyword keeps explicit productKeyword override", () => {
  const keyword = resolveKeyword(
    { message: "Viet bai cho san pham bat ky" },
    { message: "" },
    { productKeyword: "cau nang 2 tru giang duoi" },
  );

  assert.equal(keyword, "cau nang 2 tru giang duoi");
});

test("product research cache reads fresh cached payload by keyword and site", () => {
  const options = {
    productResearchCacheDir: process.env.OPENCLAW_PRODUCT_RESEARCH_CACHE_DIR,
    productResearchCacheTtlMs: 60_000,
  };
  writeCachedResearch(
    "cau nang 1 tru",
    "uptek.vn",
    {
      success: true,
      keyword: "cau nang 1 tru",
      targetSite: "uptek.vn",
      data: {
        product_name: "Cau nang 1 tru",
      },
    },
    options,
  );

  const cached = readCachedResearch("cau nang 1 tru", "uptek.vn", options);
  assert.equal(cached?.cacheHit, true);
  assert.equal(cached?.data?.product_name, "Cau nang 1 tru");
});
