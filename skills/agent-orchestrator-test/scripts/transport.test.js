const test = require("node:test");
const assert = require("node:assert/strict");
const baseTransport = require("../../agent-orchestrator/scripts/transport");

const {
  correlateByWorkflowIdAndStepId,
  looksLikeCompletedWorkflowReply,
  waitForAgentResponse,
} = require("./transport");

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

test("correlateByWorkflowIdAndStepId prefers authoritative WORKFLOW_META block over stale wf_test preamble", () => {
  const reply = `
Da tim thay workflow cu wf_test_old nhung khong dung cho turn nay.

WORKFLOW_META
- workflow_id: wf_test_old
- step_id: step_legacy

TRANG_THAI
stale

KET_QUA
old

WORKFLOW_META
- workflow_id: wf_test_live
- step_id: step_02_media_prepare

TRANG_THAI
done

KET_QUA
PROMPT_REQUEST_BEGIN
Noi dung moi
PROMPT_REQUEST_END
`;

  const result = correlateByWorkflowIdAndStepId({
    workflowId: "wf_test_live",
    stepId: "step_02_media_prepare",
    text: reply,
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflowId, "wf_test_live");
  assert.equal(result.stepId, "step_02_media_prepare");
  assert.match(result.matchedText, /workflow_id: wf_test_live/i);
});

test("correlateByWorkflowIdAndStepId returns mismatch reason for wrong workflow_id", () => {
  const reply = `
WORKFLOW_META
- workflow_id: wf_test_other
- step_id: step_02_media_prepare

TRANG_THAI
done

KET_QUA
PROMPT_REQUEST_BEGIN
Noi dung moi
PROMPT_REQUEST_END
`;

  const result = correlateByWorkflowIdAndStepId({
    workflowId: "wf_test_live",
    stepId: "step_02_media_prepare",
    text: reply,
  });

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /workflow_id mismatch/i);
});

test("waitForAgentResponse keeps polling history after pending transport error and returns late matching reply", async () => {
  const originalCallGatewayMethod = baseTransport.callGatewayMethod;
  const originalExtractTextFromGatewayResult = baseTransport.extractTextFromGatewayResult;

  let historyCallCount = 0;
  const lateReply = `
WORKFLOW_META
- workflow_id: wf_test_live
- step_id: step_02_prompt

TRẠNG_THÁI
- Đã hoàn tất prompt

KẾT_QUẢ
PROMPT_DECISION: image
IMAGE_PROMPT_BEGIN
Prompt ảnh
IMAGE_PROMPT_END
VIDEO_PROMPT_BEGIN
VIDEO_PROMPT_END
`;

  baseTransport.extractTextFromGatewayResult = () => "";
  baseTransport.callGatewayMethod = async (options) => {
    assert.equal(options.method, "chat.history");
    historyCallCount += 1;
    return {
      messages:
        historyCallCount >= 2
          ? [{ role: "assistant", text: lateReply }]
          : [],
    };
  };

  try {
    const response = await waitForAgentResponse({
      runId: "run_test",
      agentId: "nv_prompt",
      openClawHome: "/tmp/openclaw",
      sessionKey: "agent:nv_prompt:automation:wf_test_live:conv_test",
      workflowId: "wf_test_live",
      stepId: "step_02_prompt",
      timeoutMs: 50,
      pollIntervalMs: 1,
      pending: Promise.reject(new Error("transport failed too early")),
    });

    assert.equal(response.ok, true);
    assert.equal(response.workflowId, "wf_test_live");
    assert.equal(response.stepId, "step_02_prompt");
    assert.match(response.text, /PROMPT_DECISION:\s*image/i);
  } finally {
    baseTransport.callGatewayMethod = originalCallGatewayMethod;
    baseTransport.extractTextFromGatewayResult = originalExtractTextFromGatewayResult;
  }
});
