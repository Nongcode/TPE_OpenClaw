const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
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
