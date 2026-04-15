const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeCompletedWorkflowReply } = require("./transport");

test("looksLikeCompletedWorkflowReply accepts Vietnamese status marker with spaces", () => {
  const reply = `
WORKFLOW_META
- workflow_id: wf_test_123
- step_id: step_02_media_prepare

TRẠNG THÁI
Hoàn thành bước tổng hợp yêu cầu gửi NV Prompt.

KẾT QUẢ
PROMPT_REQUEST_BEGIN
Noi dung yeu cau prompt
PROMPT_REQUEST_END
`;

  assert.equal(
    looksLikeCompletedWorkflowReply(reply, "wf_test_123", "step_02_media_prepare"),
    true,
  );
});

test("looksLikeCompletedWorkflowReply still accepts underscore marker", () => {
  const reply = `
WORKFLOW_META
- workflow_id: wf_test_456
- step_id: step_02_media_prepare

TRANG_THAI
- status: done

KET_QUA
PROMPT_REQUEST_BEGIN
Noi dung yeu cau prompt
PROMPT_REQUEST_END
`;

  assert.equal(
    looksLikeCompletedWorkflowReply(reply, "wf_test_456", "step_02_media_prepare"),
    true,
  );
});
