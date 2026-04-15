const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  classifyContentDecision,
  classifyMediaDecision,
  extractBlock,
  extractField,
  parseContentReply,
  parseMediaReply,
  scanLatestGeneratedMedia,
  shouldSupersedePendingWorkflow,
} = require("./orchestrator");
const intentParser = require("./intent_parser");
const memory = require("./memory");
const mediaAgent = require("./media_agent");
const videoAgent = require("./video_agent");
const promptAgent = require("./prompt_agent");
const contentAgent = require("./content_agent");
const publisherModule = require("./publisher");
const logger = require("./logger");

test("classifyContentDecision detects approval", () => {
  assert.equal(classifyContentDecision("Duyet content, tao anh"), "approve");
});

test("classifyContentDecision detects rejection", () => {
  assert.equal(classifyContentDecision("Sua content, bai chua dat"), "reject");
});

test("classifyMediaDecision detects publish approval", () => {
  assert.equal(classifyMediaDecision("Duyet anh va dang bai"), "approve");
});

test("classifyMediaDecision detects prompt rejection keywords", () => {
  assert.equal(classifyMediaDecision("Sua prompt, prompt chua on"), "reject");
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
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo.png

RUI_RO:
- khong co

DE_XUAT_BUOC_TIEP:
- cho user duyet
`;
  const parsed = parseMediaReply(reply);
  assert.equal(parsed.imagePrompt, "Prompt tieng Viet");
  assert.equal(parsed.generatedImagePath, "D:\\output\\image.png");
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

test("classifyPendingDecision: media reject", () => {
  assert.equal(
    intentParser.classifyPendingDecision("Sua anh, may sai mau", "awaiting_media_approval"),
    "reject",
  );
  assert.equal(
    intentParser.classifyPendingDecision("Prompt chua dat", "awaiting_media_approval"),
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
  const reply = `
WORKFLOW_META:
workflow_id: wf_test
step_id: step_03_media

TRANG_THAI: completed

KET_QUA:
IMAGE_PROMPT_BEGIN
Anh quang cao may nang dien
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: D:\\output\\test.png
USED_PRODUCT_IMAGE: D:\\images\\product.png
USED_LOGO_PATHS: C:\\logos\\logo-a.png ; C:\\logos\\logo-b.png

RUI_RO: khong
DE_XUAT_BUOC_TIEP: cho duyet
`;
  const result = mediaAgent.parseImageResult(reply);
  assert.equal(result.imagePrompt, "Anh quang cao may nang dien");
  assert.equal(result.generatedImagePath, path.resolve("D:\\output\\test.png"));
  assert.equal(result.mediaType, "image");
  assert.equal(result.usedProductImage, "D:\\images\\product.png");
  assert.deepEqual(result.usedLogoPaths, ["C:\\logos\\logo-a.png", "C:\\logos\\logo-b.png"]);
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
  assert.ok(prompt.includes("skills/gemini_generate_image/action.js"));
});

test("buildVideoGeneratePrompt uses absolute veo action path and required references", () => {
  const prompt = videoAgent.buildVideoGeneratePrompt({
    workflowId: "wf_test",
    stepId: "step_06_video_generate",
    state: {
      original_brief: "Test brief",
      content: {
        approvedContent: "Noi dung test",
        productName: "May can chinh",
        primaryProductImage: "D:\\images\\product.png",
      },
      media: {
        generatedImagePath: "D:\\output\\approved-image.png",
      },
    },
    openClawHome: "/nonexistent",
    promptPackage: {
      videoPrompt: "Prompt video final",
    },
    logoPaths: ["C:\\logos\\logo.png"],
  });
  assert.ok(prompt.includes("skills/generate_veo_video/action.js"));
  assert.ok(prompt.includes("D:\\images\\product.png"));
  assert.ok(prompt.includes("C:\\logos\\logo.png"));
  assert.ok(prompt.includes("Prompt video final"));
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

test("extractPostId extracts from various response shapes", () => {
  assert.equal(publisherModule.extractPostId({ data: { post_id: "123_456" } }), "123_456");
  assert.equal(publisherModule.extractPostId({ data: { raw_fb_response: { id: "789" } } }), "789");
  assert.equal(publisherModule.extractPostId({}), "");
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
