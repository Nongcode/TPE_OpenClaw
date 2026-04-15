const test = require("node:test");
const assert = require("node:assert/strict");

const transport = require("./transport");

test("looksLikeCompletedWorkflowReply accepts section markers with Vietnamese diacritics", () => {
  const reply = `
WORKFLOW_META

workflow_id: wf_test_prompt
step_id: step_02_prompt

TRẠNG_THAI

Đã xong

KẾT_QUẢ

PROMPT_DECISION: image
IMAGE_PROMPT_BEGIN
Prompt ảnh
IMAGE_PROMPT_END
`.trim();

  assert.equal(
    transport.looksLikeCompletedWorkflowReply(reply, "wf_test_prompt", "step_02_prompt"),
    true,
  );
});

