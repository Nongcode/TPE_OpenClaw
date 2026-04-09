const test = require("node:test");
const assert = require("node:assert/strict");

const { createPlan } = require("./planner");
const { executePlan } = require("./executor");
const transport = require("./transport");

function makeRegistry() {
  const agents = [
    {
      id: "truong_phong",
      label: "Truong phong",
      reportsTo: "quan_ly",
      canDelegateTo: ["pho_phong"],
      transport: { sessionKey: "agent:truong_phong:main" },
    },
    {
      id: "pho_phong",
      label: "Pho phong",
      reportsTo: "truong_phong",
      canDelegateTo: ["nv_content", "nv_media"],
      transport: { sessionKey: "agent:pho_phong:main" },
    },
    {
      id: "nv_content",
      label: "Nhan vien content",
      reportsTo: "pho_phong",
      canDelegateTo: [],
      transport: { sessionKey: "agent:nv_content:main" },
    },
    {
      id: "nv_media",
      label: "Nhan vien media",
      reportsTo: "pho_phong",
      canDelegateTo: [],
      transport: { sessionKey: "agent:nv_media:main" },
    },
    {
      id: "quan_ly",
      label: "Quan ly",
      canDelegateTo: ["truong_phong"],
      transport: { sessionKey: "agent:quan_ly:main" },
    },
  ];
  return {
    agents,
    byId: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
  };
}

function parsePromptField(prompt, field) {
  const match = String(prompt || "").match(new RegExp(`${field}\\s*:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() || "";
}

function buildMockReply({ workflowId, stepId, action, agentId }) {
  const decision =
    action === "content_review" || action === "media_review" || action === "final_review"
      ? "approve"
      : "";
  const currentAction = {
    plan_execute: "planning",
    product_research: "researching",
    compile_post: "preparing_publish",
    publish: "publishing",
  }[action] || (agentId === "nv_content" ? "writing_content" : agentId === "nv_media" ? "generating_image" : "processing");

  const resultLines = [
    `- Agent ${agentId} da hoan thanh action ${action}.`,
  ];
  if (action === "product_research") {
    resultLines.push("- Da dung skill search_product_text de tim du lieu san pham.");
  }
  if (agentId === "nv_media") {
    resultLines.push("- Da dung skill gemini_generate_image de tao anh.");
    resultLines.push("- Da dung skill generate_video de tao video.");
    resultLines.push("- asset_paths: artifacts/generated/image-1.png");
    resultLines.push("- asset_paths: artifacts/generated/video-1.mp4");
  }

  return [
    "WORKFLOW_META:",
    `- workflow_id: ${workflowId}`,
    `- step_id: ${stepId}`,
    `- action: ${action}`,
    "",
    "TRANG_THAI:",
    "- status: completed",
    `- current_action: ${currentAction}`,
    "",
    decision ? `QUYET_DINH: ${decision}` : "",
    decision ? "" : "",
    "KET_QUA:",
    ...resultLines,
    "",
    "RUI_RO:",
    "- Khong co blocker.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Tiep tuc workflow.",
  ]
    .filter(Boolean)
    .join("\n");
}

test("executePlan drives full real-agent flow and emits transcript progress markers", async () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Trien khai chien dich facebook cho san pham cau nang oto, viet bai va lam media",
    taskType: "campaign.execute",
  });

  const original = {
    sendTaskToAgentLane: transport.sendTaskToAgentLane,
    waitForAgentResponse: transport.waitForAgentResponse,
    appendSystemEnvelopeToLane: transport.appendSystemEnvelopeToLane,
    markStepStarted: transport.markStepStarted,
    emitProgressEvent: transport.emitProgressEvent,
    markStepCompleted: transport.markStepCompleted,
    markStepFailed: transport.markStepFailed,
  };

  const sentTasks = [];
  const transcriptEvents = [];

  transport.appendSystemEnvelopeToLane = async (options) => {
    transcriptEvents.push({ kind: "assignment", ...options });
    return { ok: true };
  };
  transport.markStepStarted = async (options) => {
    transcriptEvents.push({ kind: "started", ...options });
    return { ok: true };
  };
  transport.emitProgressEvent = async (options) => {
    transcriptEvents.push({ kind: "progress", ...options });
    return { ok: true };
  };
  transport.markStepCompleted = async (options) => {
    transcriptEvents.push({ kind: "completed", ...options });
    return { ok: true };
  };
  transport.markStepFailed = async (options) => {
    transcriptEvents.push({ kind: "failed", ...options });
    return { ok: true };
  };
  transport.sendTaskToAgentLane = (options) => {
    const action = parsePromptField(options.prompt, "action");
    sentTasks.push({ agentId: options.agentId, sessionKey: options.sessionKey, action });
    return {
      ...options,
      pending: Promise.resolve({
        runId: `run-${options.stepId}`,
        text: buildMockReply({
          workflowId: options.workflowId,
          stepId: options.stepId,
          action,
          agentId: options.agentId,
        }),
        correlation: {
          ok: true,
          workflowId: options.workflowId,
          stepId: options.stepId,
          matchedBy: "reply_text",
        },
      }),
    };
  };
  transport.waitForAgentResponse = async (task) => task.pending;

  try {
    const result = await executePlan(registry, plan, {
      openClawHome: "C:/Users/Administrator/.openclaw",
    });

    assert.equal(result.executedSteps.length, 8);
    assert.deepEqual(
      sentTasks.map((item) => `${item.action}:${item.agentId}`),
      [
        "plan_execute:pho_phong",
        "product_research:pho_phong",
        "produce:nv_content",
        "content_review:pho_phong",
        "produce:nv_media",
        "media_review:pho_phong",
        "compile_post:pho_phong",
        "final_review:truong_phong",
      ],
    );

    const workflowIds = new Set(result.executedSteps.map((step) => step.envelope.workflowId));
    assert.equal(workflowIds.size, 1);
    assert.equal(result.workflowState.status, "completed");

    const startedEventTypes = transcriptEvents
      .filter((item) => item.kind === "started")
      .map((item) => `${item.sessionKey}:${item.eventType}`);
    assert.ok(startedEventTypes.includes("agent:pho_phong:main:planning"));
    assert.ok(startedEventTypes.includes("agent:pho_phong:main:researching"));
    assert.ok(startedEventTypes.includes("agent:pho_phong:main:skill_running"));
    assert.ok(startedEventTypes.includes("agent:nv_content:main:writing_content"));
    assert.ok(startedEventTypes.includes("agent:nv_media:main:generating_image"));
    assert.ok(startedEventTypes.includes("agent:nv_media:main:generating_video"));
    assert.ok(startedEventTypes.includes("agent:pho_phong:main:preparing_publish"));

    const waitingReviewEvents = transcriptEvents
      .filter((item) => item.eventType === "waiting_review")
      .map((item) => item.sessionKey);
    assert.ok(waitingReviewEvents.includes("agent:nv_content:main"));
    assert.ok(waitingReviewEvents.includes("agent:nv_media:main"));

    const completedEvents = transcriptEvents.filter((item) => item.kind === "completed");
    assert.equal(completedEvents.length, 8);
    assert.match(result.finalReply, /QUYET_DINH:\s*approve/i);
  } finally {
    transport.sendTaskToAgentLane = original.sendTaskToAgentLane;
    transport.waitForAgentResponse = original.waitForAgentResponse;
    transport.appendSystemEnvelopeToLane = original.appendSystemEnvelopeToLane;
    transport.markStepStarted = original.markStepStarted;
    transport.emitProgressEvent = original.emitProgressEvent;
    transport.markStepCompleted = original.markStepCompleted;
    transport.markStepFailed = original.markStepFailed;
  }
});
