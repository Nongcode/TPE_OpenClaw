const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const {
  buildContentApprovalCheckpointMessage,
  buildPaths,
  buildRootSyncPayloadFromResult,
  buildStageHumanMessage,
  buildWorkflowScopedSessionKey,
  isWorkflowScopedSessionKey,
  resolveWorkflowScopedSessionKey,
  classifyContentDecision,
  classifyMediaDecision,
  continueWorkflow,
  extractBlock,
  extractField,
  hasAsyncStageExceededGrace,
  hasWorkflowStageNotification,
  parseContentReply,
  parseMediaReply,
  migrateState,
  resolveAutomationSessionKey,
  resolveRootWorkflowBinding,
  runContentCheckpointStep,
  runAutoNotifyWatcher,
  scanLatestGeneratedMedia,
  shouldSupersedePendingWorkflow,
  syncRootMessageFromResult,
  validateContentCheckpointReply,
  waitForValidContentCheckpoint,
} = require("./orchestrator");
const intentParser = require("./intent_parser");
const memory = require("./memory");
const mediaAgent = require("./media_agent");
const videoAgent = require("./video_agent");
const promptAgent = require("./prompt_agent");
const contentAgent = require("./content_agent");
const publisherModule = require("./publisher");
const logger = require("./logger");
const transport = require("./transport");
const beClient = require("./be-client");

const orchestratorSource = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

test("classifyContentDecision detects approval", () => {
  assert.equal(classifyContentDecision("Duyet content, tao anh"), "approve");
});

test("classifyContentDecision treats image retry as content-approved media generation", () => {
  assert.equal(classifyContentDecision("Tạo lại ảnh"), "approve");
});

test("classifyContentDecision detects rejection", () => {
  assert.equal(classifyContentDecision("Sua content, bai chua dat"), "reject");
});

test("classifyMediaDecision detects publish approval", () => {
  assert.equal(classifyMediaDecision("Duyet anh va dang bai"), "approve");
});

test("classifyMediaDecision detects image approval that requests video", () => {
  assert.equal(classifyMediaDecision("Duyet anh, tao video"), "generate_video");
});

test("classifyMediaDecision detects prompt rejection keywords", () => {
  assert.equal(classifyMediaDecision("Sua prompt, prompt chua on"), "reject");
});

test("buildStageHumanMessage builds media approval checkpoint text", () => {
  const text = buildStageHumanMessage({
    stage: "awaiting_media_approval",
    media: {
      generatedImagePath: "C:\\media\\generated.png",
      usedProductImage: "C:\\product.png",
      usedLogoPaths: ["C:\\logo.png"],
      mediaType: "image",
    },
    prompt_package: {
      imagePrompt: "Prompt anh test",
    },
  });
  assert.ok(text.includes("NV Media đã tạo xong media"));
  assert.ok(text.includes('MEDIA: "C:/media/generated.png"'));
  assert.ok(text.includes("Đã dùng ảnh gốc sản phẩm làm tham chiếu."));
  assert.ok(text.includes("Đã dùng 1 logo công ty."));
  assert.ok(text.includes('Duyệt ảnh, tạo video: "Duyệt ảnh, tạo video"'));
  assert.doesNotMatch(text, /Prompt anh test/);
});

test("auto notify watcher defaults to long media timeout instead of the old short fallback", () => {
  assert.match(orchestratorSource, /String\(params\.timeoutMs \|\| DEFAULT_MEDIA_TIMEOUT_MS\)/);
  assert.doesNotMatch(orchestratorSource, /params\.timeoutMs \|\| 900000/);
});

test("auto notify watcher is detached and covers async media/video stages", () => {
  assert.match(orchestratorSource, /detached:\s*true/);
  assert.match(orchestratorSource, /generating_media:\s*"awaiting_media_approval"/);
  assert.match(orchestratorSource, /revising_media:\s*"awaiting_media_approval"/);
  assert.match(orchestratorSource, /generating_video:\s*"awaiting_video_approval"/);
  assert.match(orchestratorSource, /revising_video:\s*"awaiting_video_approval"/);
});

test("buildRootSyncPayloadFromResult creates approval_request payload for media approval", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-sync-${Date.now()}`);
  const paths = {
    currentFile: path.join(tmpRoot, "current-workflow.json"),
    historyDir: path.join(tmpRoot, "history"),
  };
  fs.mkdirSync(paths.historyDir, { recursive: true });
  fs.writeFileSync(
    paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_live_1",
      stage: "awaiting_media_approval",
      rootConversationId: "conv_root_1",
    }),
  );

  const payload = buildRootSyncPayloadFromResult(
    {
      paths,
      parentConversationId: null,
    },
    {
      workflow_id: "wf_live_1",
      stage: "awaiting_media_approval",
      status: "ok",
      human_message: 'NV Media da tao xong media (image).\nMEDIA: "C:/artifacts/image.png"',
    },
  );

  assert.deepEqual(payload, {
    workflowId: "wf_live_1",
    stage: "awaiting_media_approval",
    type: "approval_request",
    eventId: "wf_live_1:awaiting_media_approval:checkpoint",
    conversationStatus: "awaiting_media_approval",
    content: 'NV Media da tao xong media (image).\nMEDIA: "C:/artifacts/image.png"',
    rootConversationId: "conv_root_1",
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("buildRootSyncPayloadFromResult creates publish result payload with postId", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-publish-sync-${Date.now()}`);
  const paths = {
    currentFile: path.join(tmpRoot, "current-workflow.json"),
    historyDir: path.join(tmpRoot, "history"),
  };
  fs.mkdirSync(paths.historyDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.historyDir, "wf_live_2.json"),
    JSON.stringify({
      workflow_id: "wf_live_2",
      stage: "published",
      rootConversationId: "conv_root_2",
    }),
  );

  const payload = buildRootSyncPayloadFromResult(
    {
      paths,
      parentConversationId: null,
    },
    {
      workflow_id: "wf_live_2",
      stage: "published",
      status: "ok",
      human_message: "Bai viet da dang thanh cong.\nPost ID: 123456789",
    },
  );

  assert.deepEqual(payload, {
    workflowId: "wf_live_2",
    stage: "published",
    type: "regular",
    eventId: "wf_live_2:published:result",
    conversationStatus: "published",
    content: "Bai viet da dang thanh cong.\nPost ID: 123456789",
    rootConversationId: "conv_root_2",
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("migrateState clears placeholder video path and reopens publish decision stage", () => {
  const state = migrateState({
    workflow_id: "wf_live_video",
    stage: "awaiting_video_approval",
    media: {
      generatedImagePath: "C:\\media\\approved-image.png",
      generatedVideoPath: "C:\\Users\\Administrator\\.openclaw\\workspace_phophong\\CHƯA_TẠO_ĐƯỢC_VIDEO",
    },
    notifications: {
      awaiting_video_approval: {
        at: "2026-04-23T00:00:00.000Z",
        delivery: "sync",
      },
    },
  });

  assert.equal(state.stage, "awaiting_publish_decision");
  assert.equal(state.media.generatedVideoPath, "");
  assert.equal(state.notifications.awaiting_video_approval, undefined);
});

test("buildStageHumanMessage builds publish decision text in Vietnamese", () => {
  const text = buildStageHumanMessage({
    stage: "awaiting_publish_decision",
    media: {
      generatedImagePath: "C:\\media\\approved-image.png",
    },
  });

  assert.match(text, /Sếp đã duyệt content và ảnh/);
  assert.match(text, /Ảnh sẽ đăng:/);
  assert.match(text, /Có muốn tạo thêm video quảng cáo/);
  assert.match(text, /Tạo video: "Tạo video"/);
  assert.match(text, /Đăng ngay: "Đăng ngay"/);
  assert.match(text, /Hẹn giờ: "Hẹn giờ 20:00 hôm nay"/);
  assert.doesNotMatch(text, /Sep da|Anh se|Co muon|Tao video|Dang ngay|Hen gio/);
});

test("migrateState clears placeholder image path and reopens content approval stage", () => {
  const state = migrateState({
    workflow_id: "wf_live_image",
    stage: "awaiting_media_approval",
    media: {
      generatedImagePath: "C:\\Users\\Administrator\\.openclaw\\workspace_phophong\\ch\u01b0a t\u1ea1o \u0111\u01b0\u1ee3c",
      mediaType: "image",
    },
    notifications: {
      awaiting_media_approval: {
        at: "2026-04-23T00:00:00.000Z",
        delivery: "sync",
      },
    },
  });

  assert.equal(state.stage, "awaiting_content_approval");
  assert.equal(state.media.generatedImagePath, "");
  assert.equal(state.notifications.awaiting_media_approval, undefined);
  assert.match(state.last_error, /image output is missing or invalid/i);
});

test("parseVideoResult rejects placeholder generated video path", () => {
  assert.throws(
    () =>
      videoAgent.parseVideoResult(
        [
          "WORKFLOW_META",
          "workflow_id: wf_live_video",
          "step_id: step_06_video_generate",
          "VIDEO_PROMPT_BEGIN",
          "Prompt video",
          "VIDEO_PROMPT_END",
          "GENERATED_VIDEO_PATH: CHƯA_TẠO_ĐƯỢC_VIDEO",
          "USED_PRODUCT_IMAGE: C:\\images\\product.png",
          "USED_LOGO_PATHS: C:\\logos\\logo.png",
        ].join("\n"),
      ),
    /thieu duong dan video that/i,
  );
});

test("buildRootSyncPayloadFromResult skips transient running placeholders", () => {
  const payload = buildRootSyncPayloadFromResult(
    { paths: { currentFile: "", historyDir: "" }, parentConversationId: null },
    {
      workflow_id: "wf_live_3",
      stage: "awaiting_media_approval",
      status: "running",
      human_message: "He thong van dang render media...",
    },
  );

  assert.equal(payload, null);
});

test("buildRootSyncPayloadFromResult syncs media errors as regular root messages", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-error-sync-${Date.now()}`);
  const paths = {
    currentFile: path.join(tmpRoot, "current-workflow.json"),
    historyDir: path.join(tmpRoot, "history"),
  };
  fs.mkdirSync(paths.historyDir, { recursive: true });
  fs.writeFileSync(
    paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_live_error",
      stage: "awaiting_media_approval",
      rootConversationId: "conv_root_error",
    }),
  );

  const payload = buildRootSyncPayloadFromResult(
    {
      paths,
      parentConversationId: null,
    },
    {
      workflow_id: "wf_live_error",
      stage: "awaiting_media_approval",
      status: "error",
      human_message: "Khong the tao media.\nLoi: GENERATED_IMAGE_PATH la anh tham chieu.",
    },
  );

  assert.deepEqual(payload, {
    workflowId: "wf_live_error",
    stage: "awaiting_media_approval",
    type: "regular",
    eventId: "wf_live_error:awaiting_media_approval:error",
    conversationStatus: "error",
    content: "Khong the tao media.\nLoi: GENERATED_IMAGE_PATH la anh tham chieu.",
    rootConversationId: "conv_root_error",
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("CLI JSON mode stays machine-safe without stderr progress logs", () => {
  const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-json-home-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "orchestrator.js"),
      "--json",
      "--openclaw-home",
      openClawHome,
      "--reset",
    ],
    {
      cwd: path.resolve(__dirname, "..", "..", ".."),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), "");
  assert.equal(JSON.parse(result.stdout).status, "reset");

  fs.rmSync(openClawHome, { recursive: true, force: true });
});

test("hasWorkflowStageNotification detects delivered checkpoints", () => {
  assert.equal(
    hasWorkflowStageNotification(
      { notifications: { awaiting_media_approval: { at: "2026-04-15T03:00:00.000Z", delivery: "auto" } } },
      "awaiting_media_approval",
    ),
    true,
  );
  assert.equal(hasWorkflowStageNotification({}, "awaiting_media_approval"), false);
});

test("runAutoNotifyWatcher persists root checkpoint through backend sync instead of gateway-only inject", async () => {
  const harness = createWorkflowHarness("orchestrator-auto-notify");
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;
  const originalCallGatewayMethod = transport.callGatewayMethod;

  const pushedEvents = [];
  let statusUpdated = null;
  let gatewayInjected = false;

  beClient.pushAutomationEvent = async (payload) => {
    pushedEvents.push(payload);
    return { success: true };
  };
  beClient.updateWorkflowStatus = async (workflowId, status) => {
    statusUpdated = { workflowId, status };
    return { success: true };
  };
  transport.callGatewayMethod = async () => {
    gatewayInjected = true;
    return { ok: true };
  };

  fs.writeFileSync(
    harness.paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_auto_notify",
      stage: "awaiting_media_approval",
      rootConversationId: "conv_root_auto_notify",
      media: {
        generatedImagePath: "D:\\media\\generated.png",
        usedProductImage: "D:\\media\\product.png",
        usedLogoPaths: ["D:\\logos\\logo.png"],
      },
      notifications: {},
    }),
  );

  try {
    await runAutoNotifyWatcher({
      openClawHome: harness.openClawHome,
      notifyWorkflowId: "wf_auto_notify",
      notifyStage: "awaiting_media_approval",
      notifySessionKey: "agent:pho_phong:automation:wf_auto_notify:root",
      timeoutMs: 30_000,
    });
  } finally {
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    transport.callGatewayMethod = originalCallGatewayMethod;
    harness.cleanup();
  }

  assert.equal(gatewayInjected, false);
  assert.deepEqual(statusUpdated, {
    workflowId: "wf_auto_notify",
    status: "awaiting_media_approval",
  });
  assert.equal(pushedEvents.length, 1);
  assert.equal(pushedEvents[0].conversationId, "conv_root_auto_notify");
  assert.equal(pushedEvents[0].injectToGateway, true);
  assert.equal(pushedEvents[0].type, "approval_request");
  assert.match(String(pushedEvents[0].content || ""), /NV Media đã tạo xong media/);
});

test("runAutoNotifyWatcher recovers completed content checkpoint from generating_content", async () => {
  const harness = createWorkflowHarness("orchestrator-content-auto-notify");
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;
  const productImage = path.join(harness.tmpRoot, "content-product.png");
  const pushedEvents = [];

  fs.writeFileSync(productImage, "product");
  const validReply = `
WORKFLOW_META
workflow_id: wf_content_auto_notify
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: ${harness.tmpRoot}
PRIMARY_PRODUCT_IMAGE: ${productImage}
APPROVED_CONTENT_BEGIN
Noi dung content tu NV Content.
APPROVED_CONTENT_END
`;

  transport.findLatestWorkflowReplyInHistory = async () => validReply;
  beClient.createSubAgentConversation = async () => ({
    id: "conv_content_auto_notify",
    sessionKey: "agent:nv_content:automation:wf_content_auto_notify:step_01_content",
  });
  beClient.pushAutomationEvent = async (payload) => {
    pushedEvents.push(payload);
    return { success: true };
  };
  beClient.updateWorkflowStatus = async () => ({ success: true });

  fs.writeFileSync(
    harness.paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_content_auto_notify",
      stage: "generating_content",
      content_started_at: new Date(Date.now() - 10_000).toISOString(),
      content_step_id: "step_01_content",
      rootConversationId: "conv_root_content_auto_notify",
      notifications: {},
    }),
  );

  try {
    await runAutoNotifyWatcher({
      openClawHome: harness.openClawHome,
      notifyWorkflowId: "wf_content_auto_notify",
      notifyStage: "awaiting_content_approval",
      notifySessionKey: "agent:nv_content:automation:wf_content_auto_notify:step_01_content",
      timeoutMs: 30_000,
    });
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    harness.cleanup();
  }

  assert.equal(pushedEvents.length, 1);
  assert.equal(pushedEvents[0].conversationId, "conv_root_content_auto_notify");
  assert.equal(pushedEvents[0].type, "approval_request");
  assert.equal(pushedEvents[0].injectToGateway, true);
  assert.match(pushedEvents[0].content, /Noi dung content tu NV Content\./);
});

test("syncRootMessageFromResult marks checkpoint delivered only after backend sync succeeds", async () => {
  const harness = createWorkflowHarness("orchestrator-root-sync-mark");
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;

  beClient.pushAutomationEvent = async () => ({ success: true });
  beClient.updateWorkflowStatus = async () => ({ success: true });

  fs.writeFileSync(
    harness.paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_root_sync_mark",
      stage: "awaiting_media_approval",
      rootConversationId: "conv_root_sync_mark",
      media: {
        generatedImagePath: "D:\\media\\generated.png",
      },
      notifications: {},
    }),
  );

  try {
    const delivered = await syncRootMessageFromResult(
      {
        paths: harness.paths,
        options: { from: "pho_phong" },
      },
      {
        workflow_id: "wf_root_sync_mark",
        stage: "awaiting_media_approval",
        status: "ok",
        human_message: "NV Media da tao xong media.\nMEDIA: D:\\media\\generated.png",
      },
    );

    assert.equal(delivered, true);
    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.notifications.awaiting_media_approval.delivery, "sync");
  } finally {
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    harness.cleanup();
  }
});

test("syncRootMessageFromResult leaves checkpoint unmarked when backend sync fails", async () => {
  const harness = createWorkflowHarness("orchestrator-root-sync-fail");
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;

  beClient.pushAutomationEvent = async () => {
    throw new Error("backend unavailable");
  };
  beClient.updateWorkflowStatus = async () => ({ success: true });

  fs.writeFileSync(
    harness.paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_root_sync_fail",
      stage: "awaiting_media_approval",
      rootConversationId: "conv_root_sync_fail",
      media: {
        generatedImagePath: "D:\\media\\generated.png",
      },
      notifications: {},
    }),
  );

  try {
    const delivered = await syncRootMessageFromResult(
      {
        paths: harness.paths,
        options: { from: "pho_phong" },
      },
      {
        workflow_id: "wf_root_sync_fail",
        stage: "awaiting_media_approval",
        status: "ok",
        human_message: "NV Media da tao xong media.\nMEDIA: D:\\media\\generated.png",
      },
    );

    assert.equal(delivered, false);
    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.notifications.awaiting_media_approval, undefined);
  } finally {
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    harness.cleanup();
  }
});

test("syncRootMessageFromResult pushes recoverable errors to root conversation", async () => {
  const harness = createWorkflowHarness("orchestrator-root-error-sync");
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;
  const pushedEvents = [];

  beClient.pushAutomationEvent = async (payload) => {
    pushedEvents.push(payload);
    return { success: true };
  };
  beClient.updateWorkflowStatus = async () => ({ success: true });

  fs.writeFileSync(
    harness.paths.currentFile,
    JSON.stringify({
      workflow_id: "wf_root_error_sync",
      stage: "awaiting_video_approval",
      rootConversationId: "conv_root_error_sync",
      notifications: {},
    }),
  );

  try {
    const delivered = await syncRootMessageFromResult(
      {
        paths: harness.paths,
        options: { from: "pho_phong" },
      },
      {
        workflow_id: "wf_root_error_sync",
        stage: "awaiting_video_approval",
        status: "error",
        human_message: "Khong the tao video quang cao.\nLoi: file tai ve khong phai video.",
      },
    );

    assert.equal(delivered, true);
    assert.equal(pushedEvents.length, 1);
    assert.equal(pushedEvents[0].type, "regular");
    assert.equal(pushedEvents[0].status, "error");
    assert.equal(pushedEvents[0].eventId, "wf_root_error_sync:awaiting_video_approval:error");
    assert.match(pushedEvents[0].content, /Khong the tao video/);

    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.notifications?.awaiting_video_approval, undefined);
  } finally {
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    harness.cleanup();
  }
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
  assert.equal(
    extractBlock(reply, "APPROVED_CONTENT_BEGIN", "APPROVED_CONTENT_END"),
    "Noi dung bai dang",
  );
  const parsed = parseContentReply(reply);
  assert.equal(parsed.productUrl, "https://example.test/product");
  assert.equal(parsed.imageDir, "D:\\images");
});

test("sub-agent conversation creation lets backend inherit root employee scope by default", () => {
  const source = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");
  assert.match(source, /employeeId: params\.employeeId \|\| undefined/);
  assert.doesNotMatch(source, /employeeId: params\.employeeId \|\| params\.agentId/);
});

test("sub-agent runtime transcript is mirrored before final completion", () => {
  assert.match(orchestratorSource, /startSubAgentRuntimeMirror/);
  assert.match(orchestratorSource, /findLatestAssistantTextInHistory/);
  assert.match(orchestratorSource, /final:\s*false/);
  assert.match(orchestratorSource, /final:\s*true/);
});

test("parseMediaReply reads image prompt and output path", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-media-reply-"));
  const generatedPath = path.join(tmpDir, "image.png");
  fs.writeFileSync(generatedPath, "image");

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
GENERATED_IMAGE_PATH: ${generatedPath}
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo.png

RUI_RO:
- khong co

DE_XUAT_BUOC_TIEP:
- cho user duyet
`;
  try {
    const parsed = parseMediaReply(reply);
    assert.equal(parsed.imagePrompt, "Prompt tieng Viet");
    assert.equal(parsed.generatedImagePath, path.resolve(generatedPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scanLatestGeneratedMedia can recover repo-level generated image artifacts", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-scan-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const repoRoot = path.join(tmpRoot, "repo");
  const workspaceMediaDir = path.join(openClawHome, "workspace_media", "artifacts", "images");
  const repoImagesDir = path.join(repoRoot, "artifacts", "images");
  const startedAtIso = new Date(Date.now() - 5_000).toISOString();
  const repoImagePath = path.join(repoImagesDir, "Gemini_Generated_Image_test.png");

  fs.mkdirSync(workspaceMediaDir, { recursive: true });
  fs.mkdirSync(repoImagesDir, { recursive: true });
  fs.writeFileSync(repoImagePath, "image");

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso, { repoRoot });
  assert.equal(result.imagePath, repoImagePath);
  assert.equal(result.videoPath, "");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("scanLatestGeneratedMedia ignores gemini after screenshots when a downloaded image exists", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-scan-priority-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workspaceImagesDir = path.join(openClawHome, "workspace_media", "artifacts", "images");
  const startedAtIso = new Date(Date.now() - 10_000).toISOString();
  const generatedPath = path.join(workspaceImagesDir, "Gemini_Generated_Image_real.png");
  const screenshotPath = path.join(workspaceImagesDir, "gemini-after-2026-04-15T03-06-16-917Z.png");

  fs.mkdirSync(workspaceImagesDir, { recursive: true });
  fs.writeFileSync(generatedPath, "generated");
  fs.writeFileSync(screenshotPath, "screenshot");

  const now = new Date();
  fs.utimesSync(generatedPath, new Date(now.getTime() - 2_000), new Date(now.getTime() - 2_000));
  fs.utimesSync(screenshotPath, now, now);

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso);
  assert.equal(result.imagePath, generatedPath);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("scanLatestGeneratedMedia strict image scan ignores shared artifacts", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-image-strict-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workflowImageDir = path.join(
    openClawHome,
    "workspace_media",
    "artifacts",
    "images",
    "wf_test",
    "step_03_media",
  );
  const sharedImageDir = path.join(openClawHome, "workspace_media", "artifacts", "images");
  const startedAtIso = new Date(Date.now() - 10_000).toISOString();
  const wrongImagePath = path.join(sharedImageDir, "flow-image-2k-other.png");

  fs.mkdirSync(workflowImageDir, { recursive: true });
  fs.mkdirSync(sharedImageDir, { recursive: true });
  fs.writeFileSync(wrongImagePath, Buffer.alloc(4096, 1));

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso, {
    imageDirs: [workflowImageDir],
    strictImageDirs: true,
  });
  assert.equal(result.imagePath, "");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("scanLatestGeneratedMedia rejects recovered images that reuse old media bytes", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-image-hash-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workflowImageDir = path.join(
    openClawHome,
    "workspace_media",
    "artifacts",
    "images",
    "wf_test",
    "step_03b_media_revise",
  );
  const startedAtIso = new Date(Date.now() - 10_000).toISOString();
  const oldImagePath = path.join(workflowImageDir, "old-approved.png");
  const duplicateNewPath = path.join(workflowImageDir, "flow-image-2k-duplicate.png");
  const freshNewPath = path.join(workflowImageDir, "flow-image-2k-fresh.png");

  fs.mkdirSync(workflowImageDir, { recursive: true });
  fs.writeFileSync(oldImagePath, Buffer.alloc(4096, 7));
  fs.writeFileSync(duplicateNewPath, Buffer.alloc(4096, 7));
  fs.writeFileSync(freshNewPath, Buffer.alloc(4096, 9));

  const now = Date.now();
  fs.utimesSync(freshNewPath, new Date(now - 2_000), new Date(now - 2_000));
  fs.utimesSync(duplicateNewPath, new Date(now), new Date(now));

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso, {
    imageDirs: [workflowImageDir],
    strictImageDirs: true,
    blockedPaths: [oldImagePath],
  });
  assert.equal(result.imagePath, freshNewPath);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("resolveMediaOutputDir scopes automatic media outputs by workflow and step", () => {
  const openClawHome = path.join(os.tmpdir(), "openclaw-home");
  const outputDir = mediaAgent.resolveMediaOutputDir(
    openClawHome,
    "wf_123:unsafe",
    "step_03 media",
  );
  assert.equal(
    outputDir,
    path.normalize(
      path.join(
        openClawHome,
        "workspace_media",
        "artifacts",
        "images",
        "wf_123_unsafe",
        "step_03_media",
      ),
    ),
  );
});

test("scanLatestGeneratedMedia prefers explicit workflow video dir and ignores non-veo files", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-video-scan-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workflowVideoDir = path.join(openClawHome, "workspace_media_video", "artifacts", "videos", "wf_test");
  const sharedVideoDir = path.join(openClawHome, "workspace_media_video", "artifacts", "videos");
  const startedAtIso = new Date(Date.now() - 10_000).toISOString();
  const wrongVideoPath = path.join(sharedVideoDir, "veo-720p-other-product.mp4");
  const ignoredVideoPath = path.join(workflowVideoDir, "other-product.mp4");
  const rightVideoPath = path.join(workflowVideoDir, "veo-720p-test.mp4");

  fs.mkdirSync(workflowVideoDir, { recursive: true });
  fs.mkdirSync(sharedVideoDir, { recursive: true });
  fs.writeFileSync(wrongVideoPath, Buffer.alloc(4096, 1));
  fs.writeFileSync(ignoredVideoPath, Buffer.alloc(4096, 3));
  fs.writeFileSync(rightVideoPath, Buffer.alloc(4096, 2));

  const now = new Date();
  fs.utimesSync(wrongVideoPath, now, now);
  fs.utimesSync(ignoredVideoPath, new Date(now.getTime() + 1_000), new Date(now.getTime() + 1_000));
  fs.utimesSync(rightVideoPath, new Date(now.getTime() - 1_000), new Date(now.getTime() - 1_000));

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso, {
    agentId: "media_video",
    videoDirs: [workflowVideoDir],
  });
  assert.equal(result.videoPath, rightVideoPath);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("scanLatestGeneratedMedia strict video scan does not fall back to shared video dir", () => {
  const tmpRoot = path.join(os.tmpdir(), `orchestrator-video-strict-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workflowVideoDir = path.join(openClawHome, "workspace_media_video", "artifacts", "videos", "wf_empty");
  const sharedVideoDir = path.join(openClawHome, "workspace_media_video", "artifacts", "videos");
  const startedAtIso = new Date(Date.now() - 10_000).toISOString();
  const wrongVideoPath = path.join(sharedVideoDir, "veo-720p-other-product.mp4");

  fs.mkdirSync(workflowVideoDir, { recursive: true });
  fs.mkdirSync(sharedVideoDir, { recursive: true });
  fs.writeFileSync(wrongVideoPath, Buffer.alloc(4096, 1));

  const now = new Date();
  fs.utimesSync(wrongVideoPath, now, now);

  const result = scanLatestGeneratedMedia(openClawHome, startedAtIso, {
    agentId: "media_video",
    videoDirs: [workflowVideoDir],
    strictVideoDirs: true,
  });
  assert.equal(result.videoPath, "");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createWorkflowHarness(name) {
  const tmpRoot = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  const openClawHome = path.join(tmpRoot, ".openclaw");
  const workflowDir = path.join(openClawHome, "workspace_phophong", "agent-orchestrator-test");
  const paths = {
    currentFile: path.join(workflowDir, "current-workflow.json"),
    historyDir: path.join(workflowDir, "history"),
  };
  fs.mkdirSync(paths.historyDir, { recursive: true });
  return {
    tmpRoot,
    openClawHome,
    paths,
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

test("continueWorkflow blocked response is UTF-8 clean and hints image retry", async () => {
  const harness = createWorkflowHarness("orchestrator-blocked-utf8");
  try {
    const state = {
      workflow_id: "wf_blocked_utf8",
      stage: "awaiting_content_approval",
      intent: { intent: "CREATE_NEW", media_type_requested: "image" },
      content: {
        productName: "Sản phẩm demo",
        approvedContent: "Nội dung đã viết.",
      },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };

    const result = await continueWorkflow(
      {
        message: "abcxyz",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: { byId: {} },
        options: { timeoutMs: 120_000 },
      },
      state,
    );

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /Đang có workflow pending: Đang chờ duyệt content/);
    assert.match(result.summary, /"Tạo lại ảnh"/);
    assert.doesNotMatch(result.summary, /�|ï¿½|Ã|áº|Ä/);
  } finally {
    harness.cleanup();
  }
});

test("hasAsyncStageExceededGrace stays false before timeout", () => {
  assert.equal(hasAsyncStageExceededGrace(new Date(Date.now() - 1_000).toISOString(), 5_000), false);
  assert.equal(hasAsyncStageExceededGrace("", 5_000), false);
});

test("continueWorkflow keeps generating_video running while worker is still within grace window", async () => {
  const harness = createWorkflowHarness("orchestrator-video-running");
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;

  transport.findLatestWorkflowReplyInHistory = async () => null;
  beClient.createSubAgentConversation = async () => null;

  try {
    const state = {
      workflow_id: "wf_live_video_wait",
      stage: "generating_video",
      intent: { intent: "CREATE_NEW", media_type_requested: "both" },
      video_generating_started_at: new Date().toISOString(),
      content: {
        primaryProductImage: "D:\\images\\product.png",
      },
      media: {
        usedLogoPaths: ["C:\\logos\\logo.png"],
      },
      prompt_package: {
        videoPrompt: "Prompt video test",
      },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };
    fs.writeFileSync(harness.paths.currentFile, JSON.stringify(state, null, 2));

    const result = await continueWorkflow(
      {
        message: "Tao video",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: {
          byId: {
            media_video: { transport: { sessionKey: "agent:media_video:main" } },
          },
        },
        options: {
          timeoutMs: 120_000,
        },
      },
      state,
    );

    assert.equal(result.status, "running");
    assert.equal(result.stage, "generating_video");
    assert.match(result.summary, /render video/i);

    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.stage, "generating_video");
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    harness.cleanup();
  }
});

test("continueWorkflow keeps generating_video running after grace instead of downgrading workflow", async () => {
  const harness = createWorkflowHarness("orchestrator-video-long-running");
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;

  transport.findLatestWorkflowReplyInHistory = async () => null;
  beClient.createSubAgentConversation = async () => null;

  try {
    const state = {
      workflow_id: "wf_live_video_long_running",
      stage: "generating_video",
      intent: { intent: "CREATE_NEW", media_type_requested: "both" },
      video_generating_started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      content: {
        primaryProductImage: "D:\\images\\product.png",
      },
      media: {
        usedLogoPaths: ["C:\\logos\\logo.png"],
      },
      prompt_package: {
        videoPrompt: "Prompt video test",
      },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };
    fs.writeFileSync(harness.paths.currentFile, JSON.stringify(state, null, 2));

    const result = await continueWorkflow(
      {
        message: "Video den dau roi",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: {
          byId: {
            media_video: { transport: { sessionKey: "agent:media_video:main" } },
          },
        },
        options: {
          timeoutMs: 120_000,
        },
      },
      state,
    );

    assert.equal(result.status, "running");
    assert.equal(result.stage, "generating_video");

    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.stage, "generating_video");
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    harness.cleanup();
  }
});

test("continueWorkflow promotes generating_video to awaiting_video_approval when recovered artifact appears", async () => {
  const harness = createWorkflowHarness("orchestrator-video-recover");
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;

  transport.findLatestWorkflowReplyInHistory = async () => null;
  beClient.createSubAgentConversation = async () => null;

  try {
    const workflowVideoDir = path.join(
      harness.openClawHome,
      "workspace_media_video",
      "artifacts",
      "videos",
      "wf_live_video_recover",
    );
    fs.mkdirSync(workflowVideoDir, { recursive: true });
    const videoPath = path.join(workflowVideoDir, "veo-720p-test.mp4");
    fs.writeFileSync(videoPath, Buffer.alloc(4096, 3));

    const state = {
      workflow_id: "wf_live_video_recover",
      stage: "generating_video",
      intent: { intent: "CREATE_NEW", media_type_requested: "both" },
      video_generating_started_at: new Date(Date.now() - 5_000).toISOString(),
      video_output_dir: workflowVideoDir,
      content: {
        primaryProductImage: "D:\\images\\product.png",
      },
      media: {
        generatedImagePath: "D:\\media\\poster.png",
        usedLogoPaths: ["C:\\logos\\logo.png"],
      },
      prompt_package: {
        videoPrompt: "Prompt video recovered",
      },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };
    fs.writeFileSync(harness.paths.currentFile, JSON.stringify(state, null, 2));

    const result = await continueWorkflow(
      {
        message: "Tao video",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: {
          byId: {
            media_video: { transport: { sessionKey: "agent:media_video:main" } },
          },
        },
        options: {
          timeoutMs: 120_000,
        },
      },
      state,
    );

    assert.equal(result.stage, "awaiting_video_approval");
    assert.equal(result.status, "ok");
    assert.match(result.human_message, /MEDIA:/);
    assert.match(result.human_message, /veo-720p-test\.mp4/i);

    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.stage, "awaiting_video_approval");
    assert.equal(persisted.media.generatedVideoPath, videoPath);
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    harness.cleanup();
  }
});

test("continueWorkflow recovers completed content checkpoint and copies review image", async () => {
  const harness = createWorkflowHarness("orchestrator-content-recover");
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;
  const originalPersistMessages = beClient.persistMessages;
  const originalUpdateWorkflowStatus = beClient.updateWorkflowStatus;
  const originalPushAutomationEvent = beClient.pushAutomationEvent;
  const productImage = path.join(harness.tmpRoot, "product.png");
  const pushedEvents = [];

  fs.writeFileSync(productImage, "product");
  const validReply = `
WORKFLOW_META
workflow_id: wf_content_recover
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: ${harness.tmpRoot}
PRIMARY_PRODUCT_IMAGE: ${productImage}
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`;

  transport.findLatestWorkflowReplyInHistory = async () => validReply;
  beClient.createSubAgentConversation = async () => ({
    id: "conv_content_recover",
    sessionKey: "agent:nv_content:automation:wf_content_recover:step_01_content",
  });
  beClient.persistMessages = async () => ({ success: true });
  beClient.updateWorkflowStatus = async () => ({ success: true });
  beClient.pushAutomationEvent = async (event) => {
    pushedEvents.push(event);
    return { success: true };
  };

  try {
    const state = {
      workflow_id: "wf_content_recover",
      stage: "generating_content",
      content_started_at: new Date(Date.now() - 5_000).toISOString(),
      content_step_id: "step_01_content",
      rootConversationId: "root_content_recover",
      intent: { intent: "CREATE_NEW", media_type_requested: "image" },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };
    fs.writeFileSync(harness.paths.currentFile, JSON.stringify(state, null, 2));

    const result = await continueWorkflow(
      {
        message: "Content den dau roi",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: {
          byId: {
            nv_content: { transport: { sessionKey: "agent:nv_content:main" } },
          },
        },
        options: {
          from: "pho_phong",
          timeoutMs: 120_000,
        },
      },
      state,
    );

    assert.equal(result.status, "ok");
    assert.equal(result.stage, "awaiting_content_approval");
    assert.match(result.human_message, /Noi dung chot\./);
    assert.match(result.human_message, /review-assets/);
    assert.equal(pushedEvents.length, 1);
    assert.match(pushedEvents[0].content, /review-assets/);

    const persisted = JSON.parse(fs.readFileSync(harness.paths.currentFile, "utf8"));
    assert.equal(persisted.stage, "awaiting_content_approval");
    assert.equal(persisted.content.primaryProductImage, productImage);
    assert.match(persisted.content.primaryProductReviewImage, /review-assets/);
    assert.equal(fs.existsSync(persisted.content.primaryProductReviewImage), true);
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    beClient.persistMessages = originalPersistMessages;
    beClient.updateWorkflowStatus = originalUpdateWorkflowStatus;
    beClient.pushAutomationEvent = originalPushAutomationEvent;
    harness.cleanup();
  }
});

test("continueWorkflow routes 'Duyet anh, tao video' into the video flow from media approval", async () => {
  const harness = createWorkflowHarness("orchestrator-media-approve-video");

  try {
    const state = {
      workflow_id: "wf_live_media_approve_video",
      stage: "awaiting_media_approval",
      intent: { intent: "CREATE_NEW", media_type_requested: "image" },
      content: {
        approvedContent: "Noi dung bai da duyet.",
        primaryProductImage: "D:\\images\\product.png",
      },
      media: {
        generatedImagePath: "D:\\media\\poster.png",
        imagePrompt: "Prompt anh test",
        usedProductImage: "D:\\images\\product.png",
        usedLogoPaths: ["C:\\logos\\logo.png"],
      },
      prompt_package: {
        imagePrompt: "Prompt anh test",
      },
      notifications: {},
      reject_history: [],
      prompt_versions: [],
      global_guidelines: [],
    };
    fs.writeFileSync(harness.paths.currentFile, JSON.stringify(state, null, 2));

    const result = await continueWorkflow(
      {
        message: "Duyet anh, tao video",
        openClawHome: harness.openClawHome,
        paths: harness.paths,
        registry: {
          byId: {},
        },
        options: {
          timeoutMs: 120_000,
        },
      },
      state,
    );

    assert.equal(result.status, "error");
    assert.match(result.summary, /media_video/i);
    assert.doesNotMatch(result.summary, /Da san sang dang bai/i);
  } finally {
    harness.cleanup();
  }
});

test("parseIntentByKeywords: CREATE_NEW default for normal brief", () => {
  const result = intentParser.parseIntentByKeywords("Tao bai quang cao may nang dien");
  assert.equal(result.intent, "CREATE_NEW");
  assert.equal(result.media_type_requested, "image");
});

test("parseIntentByKeywords: detects video media type", () => {
  const result = intentParser.parseIntentByKeywords("Tao bai quang cao co video may nang");
  assert.equal(result.intent, "CREATE_NEW");
  assert.equal(result.media_type_requested, "video");
});

test("parseIntentByKeywords: detects both media type", () => {
  const result = intentParser.parseIntentByKeywords("Tao bai ca anh va video cho san pham moi");
  assert.equal(result.intent, "CREATE_NEW");
  assert.equal(result.media_type_requested, "both");
});

test("parseIntentByKeywords: EDIT_PUBLISHED", () => {
  const result = intentParser.parseIntentByKeywords("Sua bai da dang hom qua, chinh lai gia");
  assert.equal(result.intent, "EDIT_PUBLISHED");
  assert.equal(result.target_agent, "nv_content");
});

test("parseIntentByKeywords: SCHEDULE", () => {
  const result = intentParser.parseIntentByKeywords("Dat lich dang bai luc 20:00 toi nay");
  assert.equal(result.intent, "SCHEDULE");
});

test("parseIntentByKeywords: TRAIN can target nv_prompt", () => {
  const result = intentParser.parseIntentByKeywords(
    "Nho nhan vien prompt tu gio giu nguyen ket cau san pham",
  );
  assert.equal(result.intent, "TRAIN");
  assert.equal(result.target_agent, "nv_prompt");
});

test("parseIntentByKeywords: EDIT_CONTENT", () => {
  const result = intentParser.parseIntentByKeywords("Sua content, them thong so tai trong");
  assert.equal(result.intent, "EDIT_CONTENT");
  assert.equal(result.target_agent, "nv_content");
});

test("parseIntentByKeywords: EDIT_CONTENT catches shorter rewrite requests", () => {
  const result = intentParser.parseIntentByKeywords("Sua lai bai viet cho ngan lai");
  assert.equal(result.intent, "EDIT_CONTENT");
  assert.equal(result.target_agent, "nv_content");
});

test("parseIntentByKeywords: EDIT_MEDIA can target nv_prompt", () => {
  const result = intentParser.parseIntentByKeywords("Sua prompt, viet lai prompt video");
  assert.equal(result.intent, "EDIT_MEDIA");
  assert.equal(result.target_agent, "nv_prompt");
});

test("parseIntentByKeywords: EDIT_MEDIA can target media_video", () => {
  const result = intentParser.parseIntentByKeywords("Sua video, can chan that hon");
  assert.equal(result.intent, "EDIT_MEDIA");
  assert.equal(result.target_agent, "media_video");
});

test("classifyPendingDecision: content approve", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Duyet content", "awaiting_content_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("ok bai", "awaiting_content_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("cho lam anh", "awaiting_content_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Anh duyet nhe", "awaiting_content_approval"),
    "approve",
  );
});

test("classifyPendingDecision: content reject", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Sua content, viet lai", "awaiting_content_approval"),
    "reject",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Bai chua dat", "awaiting_content_approval"),
    "reject",
  );
});

test("classifyPendingDecision: media approve", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Duyet anh", "awaiting_media_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("dang bai", "awaiting_media_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Duyet nhe", "awaiting_media_approval"),
    "approve",
  );
});

test("classifyPendingDecision: media approval can branch to video", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Duyet anh, tao video", "awaiting_media_approval"),
    "generate_video",
  );
});

test("classifyPendingDecision: media reject", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Sua anh, may sai mau", "awaiting_media_approval"),
    "reject",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Prompt chua dat", "awaiting_media_approval"),
    "reject",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Xau qua lam lai di", "awaiting_media_approval"),
    "reject",
  );
});

test("classifyPendingDecision: publish decision", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Dang ngay", "awaiting_publish_decision"),
    "publish_now",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Hen gio 20:00", "awaiting_publish_decision"),
    "schedule",
  );
});

test("classifyPendingDecision: publish stage can trigger optional video flow", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Tao video", "awaiting_publish_decision"),
    "generate_video",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Khong can video", "awaiting_publish_decision"),
    "skip_video",
  );
});

test("classifyPendingDecision: video approval stage works", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Duyet video", "awaiting_video_approval"),
    "approve",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Sua video, can chan that hon", "awaiting_video_approval"),
    "reject",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Xau qua lam lai di", "awaiting_video_approval"),
    "reject",
  );
});

test("classifyPendingDecision: unknown message", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Xin chao", "awaiting_content_approval"),
    "unknown",
  );
});

test("shouldSupersedePendingWorkflow detects explicit workflow reset", () => {
  const state = { stage: "awaiting_publish_decision" };
  const intent = intentParser.parseIntentByKeywords(
    "Huy workflow cu do, thuc hien workflow moi cho anh",
  );
  assert.equal(
    shouldSupersedePendingWorkflow(
      "Huy workflow cu do, thuc hien workflow moi cho anh",
      state,
      intent,
    ),
    true,
  );
});

test("shouldSupersedePendingWorkflow keeps pending approval replies in current workflow", () => {
  const state = { stage: "awaiting_content_approval" };
  const intent = intentParser.parseIntentByKeywords("Duyet content, tao anh");
  assert.equal(shouldSupersedePendingWorkflow("Duyet content, tao anh", state, intent), false);
});

test("shouldSupersedePendingWorkflow keeps timestamp-prefixed approval replies in current workflow", () => {
  const state = { stage: "awaiting_content_approval" };
  const message = "[Tue 2026-04-14 18:56 PDT] Duyệt content, tạo ảnh";
  const intent = { intent: "CREATE_NEW" };
  assert.equal(shouldSupersedePendingWorkflow(message, state, intent), false);
});

test("shouldSupersedePendingWorkflow keeps natural-language content approval in current workflow", () => {
  const state = { stage: "awaiting_content_approval" };
  const message = "Duyet noi dung bai vua roi va tao anh theo content da duyet";
  const intent = intentParser.parseIntentByKeywords(message);
  assert.equal(shouldSupersedePendingWorkflow(message, state, intent), false);
});

test("shouldSupersedePendingWorkflow prefers a full new product brief over stale pending approvals", () => {
  const state = { stage: "awaiting_media_approval" };
  const message =
    'triển khai quảng cáo cho sản phẩm "Thiết bị kiểm tra góc đặt bánh xe tự động 4 Robot (màu đỏ)" tạo content kèm ảnh đăng bài lên page cho Anh ngay nhé!';
  const intent = intentParser.parseIntentByKeywords(message);
  assert.equal(shouldSupersedePendingWorkflow(message, state, intent), true);
});

test("extractJsonFromText: parses clean JSON", () => {
  const result = intentParser.extractJsonFromText('{"intent":"CREATE_NEW"}');
  assert.deepEqual(result, { intent: "CREATE_NEW" });
});

test("extractJsonFromText: extracts JSON from mixed text", () => {
  const result = intentParser.extractJsonFromText('Day la ket qua: {"intent":"TRAIN"} xong');
  assert.deepEqual(result, { intent: "TRAIN" });
});

test("extractJsonFromText: extracts from code fence", () => {
  const result = intentParser.extractJsonFromText('```json\n{"intent":"SCHEDULE"}\n```');
  assert.deepEqual(result, { intent: "SCHEDULE" });
});

test("validateIntent: fills defaults for missing fields", () => {
  const result = intentParser.validateIntent({}, "test message");
  assert.equal(result.intent, "CREATE_NEW");
  assert.equal(result.media_type_requested, "image");
  assert.equal(result.feedback_or_brief, "test message");
});

test("loadRules returns default when file missing", () => {
  const result = memory.loadRules("test_agent", "/nonexistent/path");
  assert.equal(result.agent_id, "test_agent");
  assert.deepEqual(result.rules, []);
  assert.equal(result.max_rules, 50);
});

test("appendRule adds and deduplicates", () => {
  const tmpDir = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  memory.appendRule("test_agent", tmpDir, "Khong duoc viet gia thap");
  const after1 = memory.loadRules("test_agent", tmpDir);
  assert.equal(after1.rules.length, 1);
  assert.equal(after1.rules[0].text, "Khong duoc viet gia thap");

  memory.appendRule("test_agent", tmpDir, "Khong duoc viet gia thap");
  const after2 = memory.loadRules("test_agent", tmpDir);
  assert.equal(after2.rules.length, 1);

  memory.appendRule("test_agent", tmpDir, "Phai co logo thuong hieu");
  const after3 = memory.loadRules("test_agent", tmpDir);
  assert.equal(after3.rules.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildRulesPromptSection returns empty for no rules", () => {
  const result = memory.buildRulesPromptSection("test_agent", "/nonexistent/path");
  assert.equal(result, "");
});

test("buildRulesPromptSection includes rules", () => {
  const tmpDir = path.join(os.tmpdir(), `orchestrator-test-rules-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  memory.appendRule("test_agent", tmpDir, "Rule A");
  memory.appendRule("test_agent", tmpDir, "Rule B");

  const section = memory.buildRulesPromptSection("test_agent", tmpDir);
  assert.ok(section.includes("QUY TAC KINH NGHIEM"));
  assert.ok(section.includes("[1] Rule A"));
  assert.ok(section.includes("[2] Rule B"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendSuccessExample stores and retrieves approved patterns", () => {
  const tmpDir = path.join(os.tmpdir(), `orchestrator-success-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  memory.appendSuccessExample("nv_prompt", tmpDir, {
    workflow_id: "wf_1",
    kind: "image_prompt_approved",
    brief: "May nang 2 tru",
    approved_result: "Prompt giu dung ket cau may nang 2 tru",
    global_guidelines: ["Tone ban hang gon gang"],
  });

  const section = memory.buildSuccessExamplesPromptSection(
    "nv_prompt",
    tmpDir,
    "Prompt may nang 2 tru",
    2,
  );
  assert.ok(section.includes("SO TAY KINH NGHIEM"));
  assert.ok(section.includes("May nang 2 tru"));
  assert.ok(section.includes("Tone ban hang gon gang"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildWorkflowGuidelinesPromptSection renders workflow guidelines", () => {
  const section = memory.buildWorkflowGuidelinesPromptSection([
    "Nho dung tone hai huoc",
    "Phai giu logo cong ty",
  ]);
  assert.ok(section.includes("GLOBAL GUIDELINE"));
  assert.ok(section.includes("Nho dung tone hai huoc"));
  assert.ok(section.includes("Phai giu logo cong ty"));
});

test("routeMediaType: image returns image", () => {
  const result = mediaAgent.routeMediaType("image");
  assert.equal(result.effectiveType, "image");
  assert.equal(result.fallbackMessage, null);
});

test("routeMediaType: video returns video", () => {
  const result = mediaAgent.routeMediaType("video");
  assert.equal(result.effectiveType, "video");
  assert.equal(result.fallbackMessage, null);
});

test("routeMediaType: both returns both", () => {
  const result = mediaAgent.routeMediaType("both");
  assert.equal(result.effectiveType, "both");
  assert.equal(result.fallbackMessage, null);
});

test("resolveLogoAssetPaths reads logos from .openclaw assets", () => {
  const tmpDir = path.join(os.tmpdir(), `orchestrator-logos-${Date.now()}`);
  const logoDir = path.join(tmpDir, "assets", "logos");
  fs.mkdirSync(logoDir, { recursive: true });
  fs.writeFileSync(path.join(logoDir, "logo-a.png"), "a");
  fs.writeFileSync(path.join(logoDir, "logo-b.webp"), "b");

  const result = mediaAgent.resolveLogoAssetPaths(tmpDir);
  assert.equal(result.length, 2);
  assert.ok(result[0].endsWith("logo-a.png"));
  assert.ok(result[1].endsWith("logo-b.webp"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseImageResult parses valid reply with references", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-image-parse-"));
  const generatedPath = path.join(tmpDir, "test.png");
  fs.writeFileSync(generatedPath, "image");

  const reply = `
WORKFLOW_META:
workflow_id: wf_test
step_id: step_03_media

TRANG_THAI: completed

KET_QUA:
IMAGE_PROMPT_BEGIN
Anh quang cao may nang dien
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: ${generatedPath}
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo-a.png ; C:\\logos\\logo-b.png
COMPANY_GALLERY_SYNCED: true
COMPANY_GALLERY_PATH: D:\\UpTek_FE\\backend\\storage\\images\\UpTek\\Phong_Marketing\\test.png
COMPANY_GALLERY_COMPANY_ID: UpTek
COMPANY_GALLERY_DEPARTMENT_ID: Phong_Marketing
COMPANY_GALLERY_PRODUCT_MODEL: GL-3.2-2E
COMPANY_GALLERY_URL: /storage/images/UpTek/Phong_Marketing/test.png
COMPANY_GALLERY_IMAGE_ID: img_1
COMPANY_GALLERY_MEDIA_FILE_ID: media_1

RUI_RO: khong
DE_XUAT_BUOC_TIEP: cho duyet
`;
  try {
    const result = mediaAgent.parseImageResult(reply);
    assert.equal(result.imagePrompt, "Anh quang cao may nang dien");
    assert.equal(result.generatedImagePath, path.resolve(generatedPath));
    assert.equal(result.mediaType, "image");
    assert.equal(result.usedProductImage, "D:\\images\\product.png");
    assert.deepEqual(result.usedLogoPaths, ["C:\\logos\\logo-a.png", "C:\\logos\\logo-b.png"]);
    assert.equal(result.companyGallerySynced, true);
    assert.equal(result.companyGalleryCompanyId, "UpTek");
    assert.equal(result.companyGalleryDepartmentId, "Phong_Marketing");
    assert.equal(result.companyGalleryProductModel, "GL-3.2-2E");
    assert.equal(result.companyGalleryUrl, "/storage/images/UpTek/Phong_Marketing/test.png");
    assert.equal(result.companyGalleryImageId, "img_1");
    assert.equal(result.companyGalleryMediaFileId, "media_1");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseImageResult repairs malformed .openclaw paths from nv_media reply", () => {
  const fixedGeneratedPath = path.join(
    "C:\\Users\\Administrator\\.openclaw",
    "workspace_media",
    "artifacts",
    "images",
    `test-${Date.now()}.png`,
  );
  const malformedGeneratedPath = fixedGeneratedPath.replace("\\.openclaw", ".openclaw");
  fs.mkdirSync(path.dirname(fixedGeneratedPath), { recursive: true });
  fs.writeFileSync(fixedGeneratedPath, "image");

  const reply = `
WORKFLOW_META:
workflow_id: wf_test
step_id: step_03_media

TRANG_THAI: completed

KET_QUA:
IMAGE_PROMPT_BEGIN
Anh quang cao may nang dien
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: ${malformedGeneratedPath}
USED_PRODUCT_IMAGE: C:\\Users\\Administrator.openclaw\\workspace_content\\artifacts\\references\\product.png
USED_LOGO_PATHS: C:\\Users\\Administrator.openclaw\\assets\\logos\\logo.png
`;
  try {
    const result = mediaAgent.parseImageResult(reply);
    assert.equal(result.generatedImagePath, path.resolve(fixedGeneratedPath));
    assert.equal(
      result.usedProductImage,
      "C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png",
    );
    assert.deepEqual(result.usedLogoPaths, [
      "C:\\Users\\Administrator\\.openclaw\\assets\\logos\\logo.png",
    ]);
  } finally {
    fs.rmSync(fixedGeneratedPath, { force: true });
  }
});

test("normalizeAgentReportedPath repairs malformed search reference slug", () => {
  const slug = `test-a-c-quy-${Date.now()}`;
  const rootDir = path.join(
    "C:\\Users\\Administrator\\.openclaw",
    "workspace_content",
    "artifacts",
    "references",
    "search_product_text",
  );
  const realDir = path.join(rootDir, slug);
  const realPath = path.join(realDir, "image_1920.png");
  const reportedPath = realPath
    .replace("\\.openclaw", ".openclaw")
    .replace(slug, slug.replace("a-c-quy", "a-c_quy"));

  try {
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(realPath, "image");
    assert.equal(mediaAgent.normalizeAgentReportedPath(reportedPath), realPath);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test("parseImageResult keeps empty gallery markers empty when sync fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-gallery-parse-"));
  const generatedPath = path.join(tmpDir, "test.png");
  fs.writeFileSync(generatedPath, "image");

  const reply = `
WORKFLOW_META:
workflow_id: wf_test
step_id: step_03_media

KET_QUA:
IMAGE_PROMPT_BEGIN
Anh quang cao may nang dien
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: ${generatedPath}
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo-a.png
COMPANY_GALLERY_SYNCED: false
COMPANY_GALLERY_PATH:
COMPANY_GALLERY_URL:
COMPANY_GALLERY_IMAGE_ID:
COMPANY_GALLERY_MEDIA_FILE_ID:

RUI_RO:
Gallery sync failed do PayloadTooLargeError.
`;
  try {
    const result = mediaAgent.parseImageResult(reply);
    assert.equal(result.companyGallerySynced, false);
    assert.equal(result.companyGalleryPath, "");
    assert.equal(result.companyGalleryUrl, "");
    assert.equal(result.companyGalleryImageId, "");
    assert.equal(result.companyGalleryMediaFileId, "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseVideoResult parses valid reply", () => {
  const reply = `
VIDEO_PROMPT_BEGIN
Video quang cao san pham
VIDEO_PROMPT_END
GENERATED_VIDEO_PATH: D:\\output\\test.mp4
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo-a.png
`;
  const result = mediaAgent.parseVideoResult(reply);
  assert.equal(result.videoPrompt, "Video quang cao san pham");
  assert.equal(result.generatedVideoPath, "D:\\output\\test.mp4");
  assert.equal(result.mediaType, "video");
  assert.equal(result.usedProductImage, "D:\\images\\product.png");
});

test("parseVideoResult repairs malformed .openclaw paths from media_video reply", () => {
  const reply = `
VIDEO_PROMPT_BEGIN
Video quang cao san pham
VIDEO_PROMPT_END
GENERATED_VIDEO_PATH: C:\\Users\\Administrator.openclaw\\workspace_media_video\\artifacts\\videos\\test.mp4
USED_PRODUCT_IMAGE: C:\\Users\\Administrator.openclaw\\workspace_content\\artifacts\\references\\product.png
USED_LOGO_PATHS: C:\\Users\\Administrator.openclaw\\assets\\logos\\logo.png
`;
  const result = videoAgent.parseVideoResult(reply);
  assert.equal(
    result.generatedVideoPath,
    path.resolve("C:\\Users\\Administrator\\.openclaw\\workspace_media_video\\artifacts\\videos\\test.mp4"),
  );
  assert.equal(
    result.usedProductImage,
    "C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png",
  );
  assert.deepEqual(result.usedLogoPaths, [
    "C:\\Users\\Administrator\\.openclaw\\assets\\logos\\logo.png",
  ]);
});

test("buildMediaSystemPrompt includes direct execution rules", () => {
  const prompt = mediaAgent.buildMediaSystemPrompt("nv_media", "/nonexistent");
  assert.ok(prompt.includes("THUC THI media"));
  assert.ok(prompt.includes("anh san pham goc"));
  assert.ok(prompt.includes("logo cong ty"));
  assert.ok(!prompt.includes("BACKGROUND ONLY"));
});

test("buildMediaGeneratePrompt includes prompt package and references", () => {
  const prompt = mediaAgent.buildMediaGeneratePrompt({
    workflowId: "wf_test",
    stepId: "step_03_media",
    state: {
      original_brief: "Test brief",
      content: {
        approvedContent: "Noi dung test",
        productName: "May nang",
        primaryProductImage: "D:\\images\\product.png",
      },
    },
    mediaType: "image",
    openClawHome: "/nonexistent",
    promptPackage: {
      imagePrompt: "Prompt final image",
    },
    logoPaths: ["C:\\logos\\logo.png"],
  });
  assert.ok(prompt.includes("IMAGE_PROMPT_DUOC_GIAO"));
  assert.ok(prompt.includes("D:\\images\\product.png"));
  assert.ok(prompt.includes("C:\\logos\\logo.png"));
  assert.ok(prompt.includes("khong phai background-only"));
  assert.ok(prompt.includes("skills/generate_flow_image/action.js"));
  assert.ok(prompt.includes('download_resolution="2k"'));
  assert.ok(!prompt.includes("skills/gemini_generate_image/action.js"));
});

test("buildVideoGeneratePrompt uses absolute veo action path and required references", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-video-prompt-"));
  const productImage = path.join(tempDir, "product.png");
  const logoPath = path.join(tempDir, "logo.png");
  fs.writeFileSync(productImage, "product");
  fs.writeFileSync(logoPath, "logo");

  const prompt = videoAgent.buildVideoGeneratePrompt({
    workflowId: "wf_test",
    stepId: "step_06_video_generate",
    state: {
      original_brief: "Test brief",
      content: {
        approvedContent: "Noi dung test",
        productName: "May can chinh",
        primaryProductImage: productImage,
      },
      media: {
        generatedImagePath: "D:\\output\\approved-image.png",
      },
    },
    openClawHome: "/nonexistent",
    promptPackage: {
      videoPrompt: "Prompt video final",
    },
    logoPaths: [logoPath],
  });
  assert.ok(prompt.includes("skills/generate_veo_video/action.js"));
  assert.ok(prompt.includes(productImage));
  assert.ok(prompt.includes(logoPath));
  assert.ok(prompt.includes("Prompt video final"));
  assert.ok(prompt.includes("8 giay"));
  assert.ok(prompt.includes("tieng Viet"));
  assert.ok(prompt.includes(path.join("/nonexistent", "workspace_media_video", "artifacts", "videos", "wf_test")));
  assert.ok(!prompt.includes("D:\\output\\approved-image.png"));
});

test("buildVideoGeneratePrompt fails fast when primaryProductImage is missing", () => {
  assert.throws(
    () =>
      videoAgent.buildVideoGeneratePrompt({
        workflowId: "wf_test",
        stepId: "step_06_video_generate",
        state: {
          original_brief: "Test brief",
          content: {
            approvedContent: "Noi dung test",
            productName: "May can chinh",
            primaryProductImage: "",
          },
        },
        openClawHome: "/nonexistent",
        promptPackage: {
          videoPrompt: "Prompt video final",
        },
        logoPaths: [],
      }),
    /Thieu primaryProductImage/,
  );
});

test("parseVideoResult rejects mismatched product image", () => {
  const reply = `
VIDEO_PROMPT_BEGIN
Video quang cao san pham
VIDEO_PROMPT_END
GENERATED_VIDEO_PATH: D:\\output\\test.mp4
USED_PRODUCT_IMAGE: D:\\images\\wrong-product.png
USED_LOGO_PATHS: C:\\logos\\logo-a.png
`;
  assert.throws(
    () =>
      videoAgent.parseVideoResult(reply, {
        productImage: "D:\\images\\product.png",
        logoPaths: ["C:\\logos\\logo-a.png"],
      }),
    /Sai reference image/,
  );
});

test("parseVideoResult rejects generated video outside expected workflow output dir", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-video-output-"));
  const workflowVideoDir = path.join(tmpRoot, "workspace_media_video", "artifacts", "videos", "wf_current");
  const otherVideoDir = path.join(tmpRoot, "workspace_media_video", "artifacts", "videos", "wf_other");
  const wrongVideoPath = path.join(otherVideoDir, "veo-720p-other-product.mp4");

  fs.mkdirSync(workflowVideoDir, { recursive: true });
  fs.mkdirSync(otherVideoDir, { recursive: true });
  fs.writeFileSync(wrongVideoPath, Buffer.alloc(4096, 1));

  const reply = `
VIDEO_PROMPT_BEGIN
Video quang cao san pham
VIDEO_PROMPT_END
GENERATED_VIDEO_PATH: ${wrongVideoPath}
USED_PRODUCT_IMAGE: ${path.join(tmpRoot, "product.png")}
USED_LOGO_PATHS:
`;

  assert.throws(
    () =>
      videoAgent.parseVideoResult(reply, {
        outputDir: workflowVideoDir,
      }),
    /Sai thu muc video workflow/,
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("buildMediaRevisePrompt includes revised prompt package", () => {
  const prompt = mediaAgent.buildMediaRevisePrompt({
    workflowId: "wf_test",
    stepId: "step_03b_media_revise",
    state: {
      original_brief: "Test brief",
      content: {
        approvedContent: "Noi dung test",
        productName: "May nang",
        primaryProductImage: "D:\\images\\product.png",
      },
      prompt_package: {
        imagePrompt: "Prompt cu",
      },
      media: {
        generatedImagePath: "D:\\output\\old.png",
      },
    },
    feedback: "Sua prompt, nhan manh logo hon",
    mediaType: "image",
    openClawHome: "/nonexistent",
    promptPackage: {
      imagePrompt: "Prompt moi",
    },
    logoPaths: ["C:\\logos\\logo.png"],
  });
  assert.ok(prompt.includes("Prompt moi"));
  assert.ok(prompt.includes("D:\\images\\product.png"));
  assert.ok(prompt.includes("C:\\logos\\logo.png"));
  assert.ok(prompt.includes("generate_flow_image"));
  assert.ok(!prompt.includes("skills/gemini_generate_image/action.js"));
});

test("parseMediaPromptRequest extracts media-owned prompt brief", () => {
  const parsed = mediaAgent.parseMediaPromptRequest(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_prepare

TRANG_THAI
ok

KET_QUA
PROMPT_REQUEST_BEGIN
Can viet prompt anh quang cao cuoi cung, giu nguyen cau truc may that.
PROMPT_REQUEST_END

RUI_RO
khong co

DE_XUAT_BUOC_TIEP
gui nv_prompt
`);
  assert.ok(parsed.request.includes("giu nguyen cau truc may that"));
});

test("parseImageResult rejects placeholder generated image path", () => {
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: KHONG_CO_DO_SKILL_TRA_VE_LOI
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parseImageResult rejects Vietnamese missing generated image marker", () => {
  const missingImageMarker = "ch\u01b0a t\u1ea1o \u0111\u01b0\u1ee3c";
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: ${missingImageMarker}
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parseImageResult preserves reported Flow tool failure when image path is missing", () => {
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: chua tao duoc do skill tra ve loi
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\logo.png

RUI_RO
- Loi that tu tool: FLOW_SUBMIT_FAILED
- Chi tiet loi cot loi: Flow composer did not accept the prompt after submit click
`),
    /nv_media bao tao anh that bai:.*FLOW_SUBMIT_FAILED.*Flow composer did not accept/i,
  );
});

test("parseImageResult rejects explicit non-existing generated image path", () => {
  const missingPath = path.join(os.tmpdir(), `missing-generated-${Date.now()}.png`);
  assert.equal(fs.existsSync(missingPath), false);
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: ${missingPath}
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parseImageResult rejects screenshot fallback generated image path", () => {
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: C:\\Users\\Administrator\\.openclaw\\workspace_media\\artifacts\\images\\gemini-image-screenshot-2026-04-14T09-08-28-808Z.png
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parseImageResult rejects product reference as generated image path", () => {
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png
USED_PRODUCT_IMAGE: C:\\Users\\Administrator\\.openclaw\\workspace_content\\artifacts\\references\\product.png
USED_LOGO_PATHS: C:\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parseImageResult rejects logo reference as generated image path", () => {
  assert.throws(
    () =>
      mediaAgent.parseImageResult(`
WORKFLOW_META
workflow_id: wf_test
step_id: step_03_media

KET_QUA
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: C:\\Users\\Administrator\\.openclaw\\assets\\logos\\logo.png
USED_PRODUCT_IMAGE: C:\\product.png
USED_LOGO_PATHS: C:\\Users\\Administrator\\.openclaw\\assets\\logos\\logo.png
`),
    /thieu duong dan anh that/i,
  );
});

test("parsePromptResult parses image prompt package", () => {
  const reply = `
WORKFLOW_META:
TRANG_THAI:
KET_QUA:
PROMPT_DECISION: image
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
VIDEO_PROMPT_BEGIN
VIDEO_PROMPT_END
`;
  const result = promptAgent.parsePromptResult(reply, "image");
  assert.equal(result.promptDecision, "image");
  assert.equal(result.imagePrompt, "Prompt anh");
});

test("parsePromptResult requires both prompts when requested", () => {
  const reply = `
PROMPT_DECISION: both
IMAGE_PROMPT_BEGIN
Prompt anh
IMAGE_PROMPT_END
VIDEO_PROMPT_BEGIN
Prompt video
VIDEO_PROMPT_END
`;
  const result = promptAgent.parsePromptResult(reply, "both");
  assert.equal(result.imagePrompt, "Prompt anh");
  assert.equal(result.videoPrompt, "Prompt video");
});

test("loadPromptKnowledgeSection reads prompt knowledge files", () => {
  const tmpDir = path.join(os.tmpdir(), `prompt-agent-${Date.now()}`);
  const workspaceDir = path.join(tmpDir, "workspace_prompt");
  const knowledgeDir = path.join(workspaceDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "openclaw.json"),
    JSON.stringify({
      agents: {
        list: [
          {
            id: "nv_prompt",
            workspace: workspaceDir,
          },
        ],
      },
    }),
  );
  fs.writeFileSync(path.join(workspaceDir, "prompt-library.md"), "# Prompt Library\nRule A");
  fs.writeFileSync(path.join(knowledgeDir, "sample.txt"), "Rule B");

  const section = promptAgent.loadPromptKnowledgeSection("nv_prompt", tmpDir);
  assert.ok(section.includes("prompt-library.md"));
  assert.ok(section.includes("sample.txt"));
  assert.ok(section.includes("Rule A"));
  assert.ok(section.includes("Rule B"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ANTI_AI_RULES contains banned phrases", () => {
  assert.ok(contentAgent.ANTI_AI_RULES.includes("Hon bao gio het"));
  assert.ok(contentAgent.ANTI_AI_RULES.includes("Giai phap hoan hao"));
  assert.ok(contentAgent.ANTI_AI_RULES.includes("Nang tam"));
});

test("buildContentSystemPrompt includes anti-AI rules", () => {
  const prompt = contentAgent.buildContentSystemPrompt("nv_content", "/nonexistent");
  assert.ok(prompt.includes("CAM TUYET DOI"));
  assert.ok(prompt.includes("Hon bao gio het"));
  assert.ok(prompt.includes("nv_content"));
});

test("parseContentResult parses valid reply", () => {
  const reply = `
WORKFLOW_META:
workflow_id: wf_test
step_id: step_01

TRANG_THAI: completed

KET_QUA:
PRODUCT_NAME: May nang dien
PRODUCT_URL: https://example.test
IMAGE_DOWNLOAD_DIR: D:\\images
APPROVED_CONTENT_BEGIN
Day la noi dung bai viet test.
APPROVED_CONTENT_END

RUI_RO: khong
DE_XUAT_BUOC_TIEP: cho duyet
`;
  const result = contentAgent.parseContentResult(reply);
  assert.equal(result.productName, "May nang dien");
  assert.equal(result.productUrl, "https://example.test");
  assert.equal(result.approvedContent, "Day la noi dung bai viet test.");
});

test("parseContentResult extracts PRIMARY_PRODUCT_IMAGE", () => {
  const reply = `
KET_QUA:
PRODUCT_NAME: May nang 2.5 tan
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\may-nang-heli.png
APPROVED_CONTENT_BEGIN
Noi dung bai viet.
APPROVED_CONTENT_END
`;
  const result = contentAgent.parseContentResult(reply);
  assert.equal(result.primaryProductImage, "D:\\images\\may-nang-heli.png");
});

test("parseContentResult repairs malformed PRIMARY_PRODUCT_IMAGE reference path", () => {
  const slug = `test-bt900-a-c-quy-${Date.now()}`;
  const rootDir = path.join(
    "C:\\Users\\Administrator\\.openclaw",
    "workspace_content",
    "artifacts",
    "references",
    "search_product_text",
  );
  const realDir = path.join(rootDir, slug);
  const realPath = path.join(realDir, "image_1920.png");
  const reportedPath = realPath
    .replace("\\.openclaw", ".openclaw")
    .replace(slug, slug.replace("a-c-quy", "a-c_quy"));

  const reply = `
KET_QUA:
PRODUCT_NAME: Test
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: ${path.dirname(reportedPath)}
PRIMARY_PRODUCT_IMAGE: ${reportedPath}
APPROVED_CONTENT_BEGIN
Noi dung.
APPROVED_CONTENT_END
`;

  try {
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(realPath, "image");
    const result = contentAgent.parseContentResult(reply);
    assert.equal(result.primaryProductImage, realPath);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test("parseContentResult resolves null primaryProductImage when marker missing", () => {
  const reply = `
KET_QUA:
PRODUCT_NAME: Test
APPROVED_CONTENT_BEGIN
Noi dung.
APPROVED_CONTENT_END
`;
  const result = contentAgent.parseContentResult(reply);
  assert.equal(result.primaryProductImage, "");
});

test("parseContentResult throws on missing content block", () => {
  assert.throws(() => {
    contentAgent.parseContentResult("No content block here");
  }, /APPROVED_CONTENT/);
});

test("buildWorkflowScopedSessionKey isolates workflow runtime from agent main lane", () => {
  assert.equal(
    buildWorkflowScopedSessionKey("nv_content", "wf_test_live", "step_01_content"),
    "agent:nv_content:automation:wf_test_live:step_01_content",
  );
});


test("workflow-scoped session resolver never falls back to an agent main lane", () => {
  assert.equal(
    resolveWorkflowScopedSessionKey({
      agentId: "nv_content",
      workflowId: "wf_parallel_a",
      stepId: "step_01_content",
      sessionKey: "agent:nv_content:main",
    }),
    "agent:nv_content:automation:wf_parallel_a:step_01_content",
  );
  assert.equal(
    resolveWorkflowScopedSessionKey({
      agentId: "nv_content",
      workflowId: "wf_parallel_a",
      stepId: "step_01_content",
      sessionKey: "agent:nv_content:automation:wf_parallel_a:conv_sub",
    }),
    "agent:nv_content:automation:wf_parallel_a:conv_sub",
  );
  assert.equal(
    isWorkflowScopedSessionKey("agent:nv_content:main", "nv_content", "wf_parallel_a"),
    false,

  );
});

test("resolveRootWorkflowBinding adopts backend automation root workflow instead of spawning wf_test sibling", async () => {
  const originalResolveAutomationRootConversation = beClient.resolveAutomationRootConversation;
  beClient.resolveAutomationRootConversation = async () => ({
    workflowId: "wf_live_123",
    rootConversationId: "conv_root_123",
    sessionKey: "agent:pho_phong:automation:wf_live_123:conv_root_123",
  });

  try {
    const binding = await resolveRootWorkflowBinding({
      message: 'triển khai quảng cáo cho sản phẩm "Mễ kê 6 Tấn, chiều cao nâng 382-600 mm (1 đôi)"',
      options: { from: "pho_phong" },
      registry: { byId: { pho_phong: { transport: { sessionKey: "agent:pho_phong:main" } } } },
    });

    assert.equal(binding.workflowId, "wf_live_123");
    assert.equal(binding.rootConversationId, "conv_root_123");
    assert.equal(binding.adoptedExistingRoot, true);
  } finally {
    beClient.resolveAutomationRootConversation = originalResolveAutomationRootConversation;
  }
});

test("validateContentCheckpointReply accepts valid content block with harmless preamble", () => {
  const reply = `
NV Content gui ban nhap moi.

WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung bai viet.
APPROVED_CONTENT_END
`;

  const result = validateContentCheckpointReply({
    reply,
    workflowId: "wf_test_live",
    stepId: "step_01_content",
  });

  assert.equal(result.ok, true);
  assert.equal(result.content.productUrl, "https://example.test/product");
  assert.ok((result.warnings || []).length >= 1);
});

test("validateContentCheckpointReply rejects workflow mismatch with clear reason", () => {
  const reply = `
WORKFLOW_META
workflow_id: wf_test_other
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung bai viet.
APPROVED_CONTENT_END
`;

  const result = validateContentCheckpointReply({
    reply,
    workflowId: "wf_test_live",
    stepId: "step_01_content",
  });

  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /workflow_id mismatch/i);
});

test("waitForValidContentCheckpoint promotes late valid child checkpoint after provisional invalid reply", async () => {
  const invalidReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
APPROVED_CONTENT_BEGIN
Noi dung tam.
APPROVED_CONTENT_END
`;
  const validReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`;

  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  transport.findLatestWorkflowReplyInHistory = async () => validReply;

  try {
    const result = await waitForValidContentCheckpoint({
      agentId: "nv_content",
      openClawHome: "/tmp/openclaw",
      workflowId: "wf_test_live",
      stepId: "step_01_content",
      sessionKey: "agent:nv_content:automation:wf_test_live:step_01_content",
      initialReply: invalidReply,
      graceMs: 3100,
    });

    assert.equal(result.ok, true);
    assert.equal(result.content.approvedContent, "Noi dung chot.");
  } finally {
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
  }
});

test("runContentCheckpointStep persists late valid NV Content checkpoint into sub-agent conversation", async () => {
  const invalidReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
APPROVED_CONTENT_BEGIN
Noi dung tam.
APPROVED_CONTENT_END
`;
  const validReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`;

  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;
  const originalPersistMessages = beClient.persistMessages;
  const originalSendTaskToAgentLane = transport.sendTaskToAgentLane;
  const originalWaitForAgentResponse = transport.waitForAgentResponse;
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  const persistedBatches = [];

  beClient.createSubAgentConversation = async () => ({
    id: "conv_nv_content",
    sessionKey: "agent:nv_content:automation:wf_test_live:step_01_content",
  });
  beClient.persistMessages = async (messages) => {
    persistedBatches.push(messages);
    return { success: true };
  };
  transport.sendTaskToAgentLane = () => ({ id: "task_content" });
  transport.waitForAgentResponse = async () => ({ text: invalidReply });
  transport.findLatestWorkflowReplyInHistory = async () => validReply;

  try {
    const result = await runContentCheckpointStep({
      agentId: "nv_content",
      openClawHome: "/tmp/openclaw",
      workflowId: "wf_test_live",
      stepId: "step_01_content",
      sessionKey: "agent:nv_content:main",
      prompt: "Viet content",
      timeoutMs: 1000,
      graceMs: 3100,
    });

    assert.equal(result.content.approvedContent, "Noi dung chot.");
    assert.equal(persistedBatches.length, 3);
    assert.equal(persistedBatches[0][0].conversationId, "conv_nv_content");
    assert.equal(persistedBatches[0][0].role, "user");
    assert.equal(persistedBatches[0][0].final, true);
    assert.equal(persistedBatches[2][0].conversationId, "conv_nv_content");
    assert.equal(persistedBatches[2][0].role, "assistant");
    assert.match(persistedBatches[2][0].content, /Noi dung chot\./);
  } finally {
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    beClient.persistMessages = originalPersistMessages;
    transport.sendTaskToAgentLane = originalSendTaskToAgentLane;
    transport.waitForAgentResponse = originalWaitForAgentResponse;
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
  }
});

test("runContentCheckpointStep keeps waiting past short content validation grace", async () => {
  const invalidReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
APPROVED_CONTENT_BEGIN
Noi dung tam.
APPROVED_CONTENT_END
`;
  const validReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung chot sau khi research xong.
APPROVED_CONTENT_END
`;

  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;
  const originalPersistMessages = beClient.persistMessages;
  const originalSendTaskToAgentLane = transport.sendTaskToAgentLane;
  const originalWaitForAgentResponse = transport.waitForAgentResponse;
  const originalFindLatestWorkflowReplyInHistory = transport.findLatestWorkflowReplyInHistory;
  let historyPolls = 0;

  beClient.createSubAgentConversation = async () => ({
    id: "conv_nv_content_slow",
    sessionKey: "agent:nv_content:automation:wf_test_live:step_01_content",
  });
  beClient.persistMessages = async () => ({ success: true });
  transport.sendTaskToAgentLane = () => ({ id: "task_content_slow" });
  transport.waitForAgentResponse = async () => ({ text: invalidReply });
  transport.findLatestWorkflowReplyInHistory = async () => {
    historyPolls += 1;
    return historyPolls >= 2 ? validReply : "";
  };

  try {
    const result = await runContentCheckpointStep({
      agentId: "nv_content",
      openClawHome: "/tmp/openclaw",
      workflowId: "wf_test_live",
      stepId: "step_01_content",
      sessionKey: "agent:nv_content:main",
      prompt: "Viet content cham",
      timeoutMs: 7000,
      graceMs: 3100,
    });

    assert.equal(result.content.approvedContent, "Noi dung chot sau khi research xong.");
    assert.equal(historyPolls, 2);
  } finally {
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    beClient.persistMessages = originalPersistMessages;
    transport.sendTaskToAgentLane = originalSendTaskToAgentLane;
    transport.waitForAgentResponse = originalWaitForAgentResponse;
    transport.findLatestWorkflowReplyInHistory = originalFindLatestWorkflowReplyInHistory;
  }
});

test("runContentCheckpointStep isolates two concurrent NV Content workflows by workflow session", async () => {
  const originalCreateSubAgentConversation = beClient.createSubAgentConversation;
  const originalPersistMessages = beClient.persistMessages;
  const originalSendTaskToAgentLane = transport.sendTaskToAgentLane;
  const originalWaitForAgentResponse = transport.waitForAgentResponse;
  const sentTasks = [];
  const persistedBatches = [];

  const buildReply = (workflowId, content) => `
WORKFLOW_META
workflow_id: ${workflowId}
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: San pham ${workflowId}
PRODUCT_URL: https://example.test/${workflowId}
IMAGE_DOWNLOAD_DIR: D:\\images\\${workflowId}
PRIMARY_PRODUCT_IMAGE: D:\\images\\${workflowId}\\product.png
APPROVED_CONTENT_BEGIN
${content}
APPROVED_CONTENT_END
`;

  beClient.createSubAgentConversation = async (params) => ({
    id: `conv_${params.workflowId}`,
    sessionKey: `agent:nv_content:automation:${params.workflowId}:conv_${params.workflowId}`,
  });
  beClient.persistMessages = async (messages) => {
    persistedBatches.push(messages);
    return { success: true };
  };
  transport.sendTaskToAgentLane = (task) => {
    sentTasks.push(task);
    return task;
  };
  transport.waitForAgentResponse = async (task) => ({
    text: buildReply(task.workflowId, `Noi dung rieng cho ${task.workflowId}.`),
  });

  try {
    const [first, second] = await Promise.all([
      runContentCheckpointStep({
        agentId: "nv_content",
        openClawHome: "/tmp/openclaw",
        workflowId: "wf_parallel_a",
        stepId: "step_01_content",
        sessionKey: "agent:nv_content:main",
        prompt: "Viet content A",
        timeoutMs: 1000,
      }),
      runContentCheckpointStep({
        agentId: "nv_content",
        openClawHome: "/tmp/openclaw",
        workflowId: "wf_parallel_b",
        stepId: "step_01_content",
        sessionKey: "agent:nv_content:main",
        prompt: "Viet content B",
        timeoutMs: 1000,
      }),
    ]);

    assert.equal(first.content.approvedContent, "Noi dung rieng cho wf_parallel_a.");
    assert.equal(second.content.approvedContent, "Noi dung rieng cho wf_parallel_b.");
    assert.deepEqual(
      sentTasks.map((task) => task.sessionKey).sort(),
      [
        "agent:nv_content:automation:wf_parallel_a:conv_wf_parallel_a",
        "agent:nv_content:automation:wf_parallel_b:conv_wf_parallel_b",
      ],
    );
    assert.equal(
      sentTasks.some((task) => task.sessionKey === "agent:nv_content:main"),
      false,
    );
    assert.deepEqual(
      persistedBatches.flat().filter((message) => message.role === "assistant").map((message) => message.conversationId).sort(),
      ["conv_wf_parallel_a", "conv_wf_parallel_b"],
    );
  } finally {
    beClient.createSubAgentConversation = originalCreateSubAgentConversation;
    beClient.persistMessages = originalPersistMessages;
    transport.sendTaskToAgentLane = originalSendTaskToAgentLane;
    transport.waitForAgentResponse = originalWaitForAgentResponse;
  }
});

test("buildStageHumanMessage returns sanitized content checkpoint for awaiting_content_approval", () => {
  const rawReply = `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content

TRANG_THAI
completed

KET_QUA
PRODUCT_NAME: May nang 2 tru
PRODUCT_URL: https://example.test/product
IMAGE_DOWNLOAD_DIR: D:\\images
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`;

  const text = buildStageHumanMessage({
    stage: "awaiting_content_approval",
    content: {
      productName: "May nang 2 tru",
      approvedContent: "Noi dung chot.",
      primaryProductImage: "D:\\images\\product.png",
      reply: rawReply,
    },
    reject_history: [],
  });

  assert.match(text, /Noi dung chot\./);
  assert.match(text, /Ảnh gốc sản phẩm để đối chiếu:/);
  assert.match(text, /MEDIA: "D:\/images\/product\.png"/);
  assert.doesNotMatch(text, /PRODUCT_URL:/);
  assert.doesNotMatch(text, /PRIMARY_PRODUCT_IMAGE:/);
  assert.doesNotMatch(text, /APPROVED_CONTENT_BEGIN/);
});

test("buildStageHumanMessage uses copied review image when present", () => {
  const text = buildStageHumanMessage({
    stage: "awaiting_content_approval",
    content: {
      productName: "May nang 2 tru",
      approvedContent: "Noi dung chot.",
      primaryProductImage: "D:\\images\\product.png",
      primaryProductReviewImage: "D:\\review-assets\\wf_test\\primary-product.png",
      reply: "",
    },
    reject_history: [],
  });

  assert.match(text, /MEDIA: "D:\/review-assets\/wf_test\/primary-product\.png"/);
  assert.doesNotMatch(text, /MEDIA: "D:\/images\/product\.png"/);
});

test("buildContentApprovalCheckpointMessage defaults to sanitized root approval message", () => {
  const text = buildContentApprovalCheckpointMessage({
    productName: "May nang 2 tru",
    approvedContent: "Noi dung chot.",
    primaryProductImage: "D:\\images\\product.png",
    primaryProductReviewImage: "D:\\review-assets\\wf_test\\primary-product.png",
    rawReply: `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content
PRODUCT_URL: https://example.test/product
PRIMARY_PRODUCT_IMAGE: D:\\images\\product.png
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`,
    revised: false,
  });

  assert.match(text, /Sản phẩm: May nang 2 tru/);
  assert.match(text, /Ảnh gốc sản phẩm để đối chiếu:/);
  assert.match(text, /MEDIA: "D:\/review-assets\/wf_test\/primary-product\.png"/);
  assert.doesNotMatch(text, /MEDIA: "D:\/images\/product\.png"/);
  assert.doesNotMatch(text, /CHECKPOINT_GOC_TU_NV_CONTENT/);
  assert.doesNotMatch(text, /PRODUCT_URL: https:\/\/example\.test\/product/);
  assert.doesNotMatch(text, /APPROVED_CONTENT_END/);
});

test("buildContentApprovalCheckpointMessage can include raw checkpoint for debug flows", () => {
  const text = buildContentApprovalCheckpointMessage({
    productName: "May nang 2 tru",
    approvedContent: "Noi dung chot.",
    rawReply: `
WORKFLOW_META
workflow_id: wf_test_live
step_id: step_01_content
PRODUCT_URL: https://example.test/product
APPROVED_CONTENT_BEGIN
Noi dung chot.
APPROVED_CONTENT_END
`,
    includeRawCheckpoint: true,
  });

  assert.match(text, /CHECKPOINT_GOC_TU_NV_CONTENT/);
  assert.match(text, /PRODUCT_URL: https:\/\/example\.test\/product/);
  assert.match(text, /APPROVED_CONTENT_END/);
});

test("parseJsonFromOutput handles clean JSON", () => {
  const result = publisherModule.parseJsonFromOutput('{"success":true}');
  assert.deepEqual(result, { success: true });
});

test("parseJsonFromOutput extracts JSON from noisy output", () => {
  const result = publisherModule.parseJsonFromOutput(
    'Some text {"success":true,"data":{}} more text',
  );
  assert.deepEqual(result, { success: true, data: {} });
});

test("parseJsonFromOutput returns null for empty input", () => {
  assert.equal(publisherModule.parseJsonFromOutput(""), null);
  assert.equal(publisherModule.parseJsonFromOutput(null), null);
});

test("extractPostId extracts canonical publish ids from various response shapes", () => {
  assert.equal(publisherModule.extractPostId({ data: { post_id: "123_456" } }), "123_456");
  assert.equal(
    publisherModule.extractPostId({ data: { page_id: "123", raw_fb_response: { id: "789" } } }),
    "123_789",
  );
  assert.equal(publisherModule.extractPostId({}), "");
});

test("extractPostIds supports split image/video publish result", () => {
  assert.deepEqual(
    publisherModule.extractPostIds({ data: { post_ids: ["111_222", "333_444"] } }),
    ["111_222", "333_444"],
  );
  assert.deepEqual(
    publisherModule.extractPostIds({ data: { post_id: "555_666" } }),
    ["555_666"],
  );
});

test("extractCanonicalPublishResult normalizes nested page results into canonical post ids", () => {
  const result = publisherModule.extractCanonicalPublishResult({
    success: true,
    data: {
      image_publish_result: {
        success: true,
        data: {
          results: [
            {
              page_id: "102",
              post_id: "998",
              raw_fb_response: {
                id: "998",
                post_id: "102_998",
                permalink_url: "https://facebook.example/post/102_998",
              },
            },
          ],
        },
      },
      video_publish_result: {
        success: true,
        data: {
          results: [
            {
              page_id: "112",
              post_id: "445",
              raw_fb_response: {
                id: "445",
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.status, "published");
  assert.equal(result.pageId, "102");
  assert.equal(result.postId, "102_998");
  assert.deepEqual(result.postIds, ["102_998", "112_445"]);
  assert.equal(result.permalink, "https://facebook.example/post/102_998");
});

test("splitMediaPathsByType separates images and videos", () => {
  const result = publisherModule.splitMediaPathsByType([
    "D:/media/poster.png",
    "D:/media/clip.mp4",
    "D:/media/cover.jpg",
  ]);
  assert.deepEqual(result.imagePaths, ["D:/media/poster.png", "D:/media/cover.jpg"]);
  assert.deepEqual(result.videoPaths, ["D:/media/clip.mp4"]);
});

test("DEFAULT_VIDEO_PROMPT_TEMPLATE keeps exact company logo phrase", () => {
  assert.ok(
    promptAgent.DEFAULT_VIDEO_PROMPT_TEMPLATE.includes("Tân Phát Etek - Hội Tụ Tinh Hoa Giải Pháp"),
  );
  assert.ok(promptAgent.DEFAULT_VIDEO_PROMPT_TEMPLATE.includes("Không có Text"));
});

test("buildHumanMessage creates natural messages", () => {
  const msg = logger.buildHumanMessage("pho_phong", "nv_content", "content_draft", "Test brief");
  assert.ok(msg.includes("Test brief"));
  assert.ok(msg.includes("Content"));
});

test("buildHumanMessage supports prompt handoff", () => {
  const msg = logger.buildHumanMessage("pho_phong", "nv_prompt", "prompt_draft", "image");
  assert.ok(msg.includes("NV Prompt"));
  assert.ok(msg.includes("image"));
});

test("buildHumanMessage supports media-owned prompt flow", () => {
  const msg = logger.buildHumanMessage("nv_media", "nv_prompt", "prompt_from_media", "image");
  assert.ok(msg.includes("NV Media"));
  assert.ok(msg.includes("NV Prompt"));
});

test("buildHumanMessage supports video-owned prompt flow", () => {
  const msg = logger.buildHumanMessage("media_video", "nv_prompt", "prompt_from_video", "video");
  assert.ok(msg.includes("Media_Video"));
  assert.ok(msg.includes("NV Prompt"));
});

test("buildHumanMessage fallback for unknown action", () => {
  const msg = logger.buildHumanMessage("A", "B", "unknown_action", "details");
  assert.ok(msg.includes("A"));
  assert.ok(msg.includes("B"));
});

test("DEFAULT_LOGO_PATH is exported", () => {
  assert.ok(mediaAgent.DEFAULT_LOGO_PATH);
  assert.ok(mediaAgent.DEFAULT_LOGO_PATH.includes("logo.png"));
});

test("compositeImage3Layers is exported as async function", () => {
  assert.equal(typeof mediaAgent.compositeImage3Layers, "function");
});

test("compositeImage3Layers rejects with invalid background path", async () => {
  await assert.rejects(
    () =>
      mediaAgent.compositeImage3Layers({
        backgroundPath: "/nonexistent/bg.png",
        productImagePath: "/nonexistent/product.png",
      }),
    /Anh nen khong ton tai|sharp/i,
  );
});
