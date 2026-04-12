/**
 * orchestrator.js — Bộ điều phối trung tâm v2.
 *
 * Nâng cấp từ state-machine tuyến tính cố định sang Multi-Agent tự trị:
 * - Dynamic Routing qua LLM intent parsing
 * - Long-term Memory (rules.json self-learning)
 * - Human-in-the-Loop bắt buộc tại mọi checkpoint
 * - Video placeholder + fallback
 * - Publish / Schedule / Edit Published
 * - Human-readable logging (không in raw JSON)
 *
 * Backward compatible: giữ nguyên exports cũ cho test.
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const {
  normalizeText,
  resolveOpenClawHome,
  loadOpenClawConfig,
} = require("../../agent-orchestrator/scripts/common");
const { discoverRegistry } = require("../../agent-orchestrator/scripts/registry");
const transport = require("../../agent-orchestrator/scripts/transport");

const intentParser = require("./intent_parser");
const contentAgent = require("./content_agent");
const promptAgent = require("./prompt_agent");
const mediaAgent = require("./media_agent");
const publisher = require("./publisher");
const memory = require("./memory");
const logger = require("./logger");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAX_REJECT_PER_STAGE = 5;

// ─── CLI Argument Parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    json: false,
    from: "pho_phong",
    openClawHome: null,
    message: "",
    messageFile: null,
    reset: false,
    timeoutMs: 900000,
    dryRun: false,
    useLLMIntent: false, // Tắt mặc định — LLM intent gửi prompt vào lane phó phòng gây lộ nội dung. Dùng keyword matching.
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") { options.json = true; continue; }
    if (token === "--from") { options.from = argv[index + 1] || options.from; index += 1; continue; }
    if (token === "--openclaw-home") { options.openClawHome = argv[index + 1] || null; index += 1; continue; }
    if (token === "--message-file") { options.messageFile = argv[index + 1] || null; index += 1; continue; }
    if (token === "--reset") { options.reset = true; continue; }
    if (token === "--dry-run") { options.dryRun = true; continue; }
    if (token === "--no-llm-intent") { options.useLLMIntent = false; continue; }
    if (token === "--timeout-ms") { options.timeoutMs = Number(argv[index + 1] || options.timeoutMs); index += 1; continue; }
    positional.push(token);
  }

  options.message = positional.join(" ").trim();
  return options;
}

function loadMessage(options) {
  if (options.messageFile) {
    return fs.readFileSync(options.messageFile, "utf8").replace(/^\uFEFF/, "").trim();
  }
  return String(options.message || "").trim();
}

// ─── Workspace & State Helpers ───────────────────────────────────────

function getPhoPhongWorkspace(config, openClawHome) {
  const workspace =
    config?.agents?.list?.find((agent) => agent?.id === "pho_phong")?.workspace ||
    path.join(openClawHome, "workspace_phophong");
  return path.resolve(workspace);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function getMediaTimeoutMs(baseTimeoutMs) {
  const numeric = Number(baseTimeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return 900000;
  return Math.max(numeric, 900000);
}

function buildPaths(workspaceDir) {
  const baseDir = path.join(workspaceDir, "agent-orchestrator-test");
  const historyDir = path.join(baseDir, "history");
  const currentFile = path.join(baseDir, "current-workflow.json");
  ensureDir(baseDir);
  ensureDir(historyDir);
  return { baseDir, historyDir, currentFile };
}

// ─── Result Builders ─────────────────────────────────────────────────

function buildResult(params) {
  return {
    workflow_id: params.workflowId || null,
    stage: params.stage || null,
    status: params.status || "ok",
    summary: params.summary || "",
    human_message: params.humanMessage || params.summary || "",
    data: params.data || {},
  };
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // Human-readable mode: chỉ in summary
  console.log(result.human_message || result.summary || JSON.stringify(result, null, 2));
}

// ─── Workflow State Management ───────────────────────────────────────

function archiveWorkflow(paths, state) {
  if (!state?.workflow_id) return;
  const targetPath = path.join(paths.historyDir, `${state.workflow_id}.json`);
  writeJson(targetPath, state);
  if (fs.existsSync(paths.currentFile)) {
    fs.unlinkSync(paths.currentFile);
  }
}

function saveWorkflow(paths, state) {
  const payload = { ...state, updated_at: nowIso() };
  writeJson(paths.currentFile, payload);
  return payload;
}

/**
 * Migrate state cũ nếu thiếu trường mới.
 */
function migrateState(state) {
  if (!state) return state;
  if (!state.intent) {
    state.intent = { intent: "CREATE_NEW", media_type_requested: "image" };
  }
  if (!state.reject_history) {
    state.reject_history = [];
  }
  if (!state.prompt_versions) {
    state.prompt_versions = [];
  }
  if (!Object.prototype.hasOwnProperty.call(state, "prompt_package")) {
    state.prompt_package = null;
  }
  return state;
}

// ─── Reply Validation ────────────────────────────────────────────────

function validateCommonReply(reply, workflowId, stepId) {
  const text = String(reply || "").trim();
  if (!text) throw new Error("Agent reply is empty.");

  // Soft validation — chỉ warn nếu thiếu token, không crash.
  // Agent LLM có thể viết hơi khác (thêm dấu, space, format) nhưng nội dung đúng.
  const requiredTokens = [
    "WORKFLOW_META", "TRANG_THAI", "KET_QUA",
  ];
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      logger.log("warn", `⚠️ Agent reply thiếu token "${token}" — tiếp tục xử lý.`);
    }
  }
  return text;
}

// ─── Agent Communication ─────────────────────────────────────────────

async function runAgentStep(params) {
  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: params.sessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    timeoutMs: params.timeoutMs,
  });
  const response = await transport.waitForAgentResponse(task);
  return validateCommonReply(response.text, params.workflowId, params.stepId);
}

function isPromptFocusedFeedback(feedback) {
  const normalized = normalizeText(feedback || "");
  return [
    "sua prompt",
    "viet lai prompt",
    "prompt chua on",
    "prompt chua dat",
    "chinh prompt",
    "prompt can sua",
  ].some((token) => normalized.includes(token));
}

function isExplicitWorkflowResetMessage(message) {
  const normalized = normalizeText(message || "");
  return [
    "huy workflow cu",
    "huy workflow nay",
    "huy workflow",
    "workflow moi",
    "reset workflow",
    "lam workflow moi",
    "tao workflow moi",
    "thuc hien workflow moi",
  ].some((token) => normalized.includes(token));
}

function looksLikeFreshWorkflowBrief(message, parsedIntent) {
  if (parsedIntent?.intent !== "CREATE_NEW") {
    return false;
  }

  const raw = String(message || "").trim();
  const normalized = normalizeText(raw);
  const strongSignals = [
    "trien khai",
    "quang cao cho san pham",
    "tao content",
    "tao bai",
    "san pham",
  ];

  const strongSignalCount = strongSignals.filter((token) => normalized.includes(token)).length;
  const hasQuotedProduct = /["“”].+["“”]/.test(raw);
  const longEnough = normalized.length >= 40;
  const hasStructuredBrief = raw.includes("\n") || raw.includes(":");

  return longEnough && (strongSignalCount >= 2 || (hasQuotedProduct && strongSignalCount >= 1) || hasStructuredBrief);
}

function shouldSupersedePendingWorkflow(message, state, parsedIntent) {
  if (!state) {
    return false;
  }

  if (isExplicitWorkflowResetMessage(message)) {
    return true;
  }

  if (looksLikeFreshWorkflowBrief(message, parsedIntent)) {
    return true;
  }

  const pendingDecision = intentParser.classifyPendingDecision(message, state.stage);
  if (pendingDecision !== "unknown") {
    return false;
  }

  return false;
}

function collectMediaPaths(media) {
  const result = [];
  if (media?.generatedImagePath) result.push(media.generatedImagePath);
  if (media?.generatedVideoPath) result.push(media.generatedVideoPath);
  return result;
}

function buildPromptPreview(promptPackage) {
  const parts = [];
  if (promptPackage?.imagePrompt) {
    parts.push("PROMPT ANH DA DUNG:");
    parts.push(promptPackage.imagePrompt);
  }
  if (promptPackage?.videoPrompt) {
    if (parts.length > 0) parts.push("");
    parts.push("PROMPT VIDEO DA DUNG:");
    parts.push(promptPackage.videoPrompt);
  }
  return parts.join("\n");
}

function buildMediaApprovalSummary(params) {
  const { media, promptPackage, route } = params;
  const mediaPaths = collectMediaPaths(media);
  const previewFile = media?.generatedImagePath || media?.generatedVideoPath || "";
  const fileLink = previewFile ? `file:///${previewFile.replace(/\\/g, "/")}` : "";
  const promptPreview = buildPromptPreview(promptPackage);
  const referenceText = [
    media?.usedProductImage ? `Anh san pham goc da dung: ${media.usedProductImage}` : "",
    Array.isArray(media?.usedLogoPaths) && media.usedLogoPaths.length > 0
      ? `Logo da dung: ${media.usedLogoPaths.join(" ; ")}`
      : "",
  ].filter(Boolean).join("\n");

  return [
    `🎨 NV Media da tao xong media (${route.effectiveType}), dang cho Sep duyet.`,
    mediaPaths.length > 0 ? `Media tao ra: ${mediaPaths.join(" ; ")}` : "",
    fileLink ? `Xem nhanh: ${fileLink}` : "",
    referenceText,
    "",
    promptPreview,
    "",
    '👉 Duyet va sang buoc tiep: "Duyet anh va dang bai" hoac "Duyet media"',
    '👉 Sua tiep: "Sua anh, <nhan xet>" hoac "Sua prompt, <nhan xet>"',
  ].filter(Boolean).join("\n");
}

function selectLatestArtifactPath(dirPath, extensions, sinceMs, excludePatterns = []) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return "";
    }

    const files = fs.readdirSync(dirPath)
      .filter((name) => {
        if (!extensions.includes(path.extname(name).toLowerCase())) {
          return false;
        }
        if (excludePatterns.some((pattern) => pattern.test(name))) {
          return false;
        }
        const fullPath = path.join(dirPath, name);
        const mtimeMs = fs.statSync(fullPath).mtimeMs;
        return !Number.isFinite(sinceMs) || sinceMs <= 0 || mtimeMs >= sinceMs;
      })
      .map((name) => ({
        fullPath: path.join(dirPath, name),
        mtimeMs: fs.statSync(path.join(dirPath, name)).mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return files[0]?.fullPath || "";
  } catch {
    return "";
  }
}

function scanLatestGeneratedMedia(openClawHome, startedAtIso) {
  const workspaceDir = memory.resolveAgentWorkspace("nv_media", openClawHome);
  const sinceMs = startedAtIso ? new Date(startedAtIso).getTime() : 0;

  const imagePath = selectLatestArtifactPath(
    path.join(workspaceDir, "artifacts", "images"),
    [".png", ".jpg", ".jpeg", ".webp"],
    sinceMs,
    [/before/i, /screenshot/i, /test_/i],
  );

  const videoDirs = [
    path.join(workspaceDir, "artifacts", "videos"),
    path.join(workspaceDir, "outputs", "veo_videos"),
    path.join(workspaceDir, "outputs", "videos"),
  ];
  const videoPath = videoDirs
    .map((dirPath) => selectLatestArtifactPath(dirPath, [".mp4", ".mov", ".webm"], sinceMs))
    .find(Boolean) || "";

  return { imagePath, videoPath };
}

// ─── Content Dedup Check ─────────────────────────────────────────────

function isDuplicateContent(historyDir, newContent) {
  try {
    if (!fs.existsSync(historyDir)) return false;
    const files = fs.readdirSync(historyDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 5);

    const normalizedNew = normalizeText(newContent).slice(0, 200);
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(historyDir, file), "utf8").replace(/^\uFEFF/, ""),
        );
        const oldContent = normalizeText(data?.content?.approvedContent || "").slice(0, 200);
        if (oldContent && normalizedNew === oldContent) return true;
      } catch {
        // skip
      }
    }
  } catch {
    // no history
  }
  return false;
}

// ─── WORKFLOW ACTIONS ────────────────────────────────────────────────

/**
 * Tạo workflow mới — giao nv_content viết bài.
 */
async function startNewWorkflow(context) {
  const workflowId = `wf_test_${randomUUID()}`;
  const stepId = "step_01_content";
  const intent = context.intent;

  logger.logPhase("TẠO BÀI MỚI", `Sếp giao brief: "${context.message.slice(0, 100)}..."`);
  logger.logHandoff(
    "Phó phòng", "NV Content",
    logger.buildHumanMessage("pho_phong", "nv_content", "content_draft", context.message.slice(0, 80)),
  );

  const prompt = contentAgent.buildContentDraftPrompt({
    workflowId,
    stepId,
    brief: context.message,
    openClawHome: context.openClawHome,
  });

  const contentReply = await runAgentStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });

  const content = contentAgent.parseContentResult(contentReply);

  // Content dedup check
  if (isDuplicateContent(context.paths.historyDir, content.approvedContent)) {
    logger.log("info", "⚠️ Nội dung này có thể trùng với bài đã đăng gần đây.");
  }

  const state = saveWorkflow(context.paths, {
    workflow_id: workflowId,
    created_at: nowIso(),
    status: "pending",
    stage: "awaiting_content_approval",
    intent,
    original_brief: context.message,
    content,
    prompt_package: null,
    media: null,
    publish: null,
    reject_history: [],
    prompt_versions: [],
  });

  const summary = [
    context.supersededWorkflowId ? `Da archive workflow cu: ${context.supersededWorkflowId}` : "",
    "📝 NV Content đã viết xong bài nháp, đang chờ Sếp duyệt.",
    content.productName ? `Sản phẩm: ${content.productName}` : "",
    "",
    "━━━ NỘI DUNG CHỜ DUYỆT ━━━",
    content.approvedContent,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "👉 Sếp muốn duyệt? Nói: \"Duyệt content, tạo ảnh\"",
    "👉 Muốn sửa? Ghi rõ nhận xét, ví dụ: \"Sửa content, thêm giá\"",
  ].filter(Boolean).join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  return buildResult({
    workflowId,
    stage: state.stage,
    summary,
    humanMessage: summary,
    data: { content, next_expected_action: "content_approval" },
  });
}

/**
 * Sửa content khi bị reject.
 */
async function reviseContent(context, state) {
  const stepId = "step_01b_content_revise";

  logger.logRejected("content", context.message);

  // Memory learning: rút quy tắc từ feedback
  const feedbackRule = memory.learnFromFeedbackSync("nv_content", context.openClawHome, context.message);
  if (feedbackRule) {
    const latestRule = feedbackRule.rules[feedbackRule.rules.length - 1];
    logger.logLearning("nv_content", latestRule?.text || context.message);
  }

  // Track reject history
  state.reject_history = state.reject_history || [];
  state.reject_history.push({
    stage: "content",
    agent: "nv_content",
    feedback: context.message,
    timestamp: nowIso(),
  });

  // Smart retry guard
  const contentRejects = state.reject_history.filter((r) => r.stage === "content").length;
  if (contentRejects > MAX_REJECT_PER_STAGE) {
    logger.logError("content", `NV Content đã bị từ chối ${contentRejects} lần. Cần xem lại brief.`);
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `⚠️ NV Content đã bị từ chối ${contentRejects} lần liên tiếp. Có thể brief cần bổ sung hoặc nhân viên cần training thêm.`,
      data: { reject_count: contentRejects },
    });
  }

  logger.logHandoff(
    "Phó phòng", "NV Content",
    logger.buildHumanMessage("pho_phong", "nv_content", "content_revise", context.message.slice(0, 80)),
  );

  const prompt = contentAgent.buildContentRevisePrompt({
    workflowId: state.workflow_id,
    stepId,
    originalBrief: state.original_brief,
    feedback: context.message,
    oldContent: state.content.approvedContent,
    openClawHome: context.openClawHome,
  });

  const reply = await runAgentStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });

  const content = contentAgent.parseContentResult(reply);
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_content_approval",
    content,
  });

  const summary = [
    "📝 NV Content đã sửa lại bài theo nhận xét, đang chờ Sếp duyệt lại.",
    "",
    "━━━ NỘI DUNG ĐÃ SỬA ━━━",
    content.approvedContent,
    "━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "👉 Duyệt: \"Duyệt content, tạo ảnh\"",
    "👉 Sửa tiếp: ghi rõ nhận xét",
  ].join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { content, next_expected_action: "content_approval" },
  });
}

/**
 * Tạo media (ảnh hoặc video).
 */
async function generateMedia(context, state) {
  const stepId = "step_02_media";
  const mediaType = state.intent?.media_type_requested || "image";

  // Route media type (video fallback)
  const route = mediaAgent.routeMediaType(mediaType);
  if (route.fallbackMessage) {
    logger.log("video", route.fallbackMessage);
  }

  logger.logPhase("TẠO MEDIA", `Loại: ${route.effectiveType}`);
  logger.logHandoff(
    "Phó phòng", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_generate", ""),
  );

  const prompt = mediaAgent.buildMediaGeneratePrompt({
    workflowId: state.workflow_id,
    stepId,
    state,
    mediaType: route.effectiveType,
    openClawHome: context.openClawHome,
  });

  // ─── LOCK: Lưu stage 'generating_media' TRƯỚC khi gọi agent ────────────
  // Thẩm quyền này ngăn orchestrator bị loop không hởi NV Media lần 2
  // nếu nó crash sau khi NV Media đã trả ảnh nhưng trước khi save state.
  saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_started_at: nowIso(),
  });
  let mediaReply;
  const MAX_TRANSPORT_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      mediaReply = await runAgentStep({
        agentId: "nv_media",
        sessionKey: context.registry.byId.nv_media.transport.sessionKey,
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stepId,
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        prompt,
      });
      break; // Thành công
    } catch (transportErr) {
      logger.logError("transport", `Lần ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= MAX_TRANSPORT_RETRIES) {
        // Khi transport lỗi, khôi phục stage về awaiting_content_approval
        saveWorkflow(context.paths, {
          ...state,
          stage: "awaiting_content_approval",
          last_error: `media_generate transport error: ${transportErr.message || transportErr}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "awaiting_content_approval",
          status: "error",
          summary: [
            "❌ Tạo ảnh không thành công sau 2 lần thử.",
            `Lỗi: ${transportErr.message || "Kết nối tới NV Media bị ngắt."}`,
            "",
            "👉 Thử lại: \"Duyệt content, tạo ảnh\"",
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `🔃 Thử lại lần ${attempt + 1}...`);
    }
  }

  // ─── Parse kết quả ────────────────────────────────────────────
  let media;
  try {
    media = mediaAgent.parseMediaResult(mediaReply, route.effectiveType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
      last_error: `parse_media error: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: [
        "❌ NV Media đã tạo ảnh nhưng hệ thống không đọc được kết quả.",
        `Lỗi: ${parseErr.message}`,
        "",
        "👉 Thử lại: \"Duyệt content, tạo ảnh\"",
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // ─── Lưu background path ngay sau khi parse — trước composite ────────────
  // Nếu composite crash, recovery sử dụng đường dẫn này thay vì scan thư mục.
  saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_bg_image_path: media.generatedImagePath || "",
    generating_product_image_path: state.content?.primaryProductImage || "",
  });

  // ─── PIPELINE GHÉP 3 LỚP ──────────────────────────────────────────
  // Nếu có ảnh sản phẩm thật → ghép: Background AI + Product thật + Logo
  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (
    route.effectiveType === "image" &&
    media.generatedImagePath &&
    state.content?.primaryProductImage
  ) {
    try {
      logger.log("media", "🔧 Đang ghép 3 lớp: Nền AI + Sản phẩm thật + Logo...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(
          /(\.[a-z]+)$/i,
          "_final$1",
        ),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `✅ Ghép ảnh 3 lớp thành công: ${compositePath}`);
    } catch (compErr) {
      process.stderr.write(`[COMPOSITE_ERROR] ${compErr.stack || compErr.message || compErr}\n`);
      logger.logError("composite", compErr);
      logger.log("info", "⚠️ Sử dụng ảnh nền AI gốc (chưa ghép sản phẩm).");
      media.composited = false;
    }
  }

  // Track prompt version
  mediaAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
    type: route.effectiveType,
    prompt: media.imagePrompt || media.videoPrompt,
    path: finalMediaPath,
    composited: media.composited || false,
  });

  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_media_approval",
    media,
  });

  // Tạo file:// link để phó phòng hiển thị ảnh trong chat
  const fileLink = finalMediaPath
    ? `file:///${finalMediaPath.replace(/\\/g, "/")}`
    : "";

  const summary = [
    `🎨 NV Media đã tạo ${route.effectiveType === "video" ? "video" : "ảnh"} xong, đang chờ Sếp duyệt.`,
    media.composited ? "✅ Đã ghép: Nền AI + Sản phẩm thật + Logo" : "",
    route.fallbackMessage ? `ℹ️ ${route.fallbackMessage}` : "",
    "",
    finalMediaPath ? `🖼️ Xem ảnh: ${fileLink}` : "",
    `File: ${finalMediaPath}`,
    "",
    "👉 Duyệt và đăng bài: \"Duyệt ảnh và đăng bài\"",
    "👉 Sửa ảnh: ghi rõ nhận xét, ví dụ: \"Sửa ảnh, nền chưa đẹp\"",
  ].filter(Boolean).join("\n");

  logger.logApprovalWait("awaiting_media_approval", `File: ${finalMediaPath}`);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { media, approved_content: state.content.approvedContent, next_expected_action: "media_approval" },
  });
}

/**
 * Sửa media khi bị reject.
 */
async function reviseMedia(context, state) {
  const stepId = "step_02b_media_revise";
  const mediaType = state.media?.mediaType || state.intent?.media_type_requested || "image";

  logger.logRejected("media", context.message);

  // Memory learning
  const feedbackRule = memory.learnFromFeedbackSync("nv_media", context.openClawHome, context.message);
  if (feedbackRule) {
    const latestRule = feedbackRule.rules[feedbackRule.rules.length - 1];
    logger.logLearning("nv_media", latestRule?.text || context.message);
  }

  // Track reject
  state.reject_history = state.reject_history || [];
  state.reject_history.push({
    stage: "media",
    agent: "nv_media",
    feedback: context.message,
    timestamp: nowIso(),
  });

  const mediaRejects = state.reject_history.filter((r) => r.stage === "media").length;
  if (mediaRejects > MAX_REJECT_PER_STAGE) {
    logger.logError("media", `NV Media đã bị từ chối ${mediaRejects} lần.`);
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `⚠️ NV Media đã bị từ chối ${mediaRejects} lần liên tiếp. Prompt có thể cần được thiết kế lại.`,
      data: { reject_count: mediaRejects },
    });
  }

  logger.logHandoff(
    "Phó phòng", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_revise", context.message.slice(0, 80)),
  );

  const prompt = mediaAgent.buildMediaRevisePrompt({
    workflowId: state.workflow_id,
    stepId,
    state,
    feedback: context.message,
    mediaType,
    openClawHome: context.openClawHome,
  });

  // ─── LOCK: Lưu stage 'revising_media' TRƯỚC khi gọi agent ─────────────
  saveWorkflow(context.paths, {
    ...state,
    stage: "revising_media",
    revising_started_at: nowIso(),
    revising_feedback: context.message,
  });

  // ─── Gọi NV Media với retry ──────────────────────────────────────
  let reply;
  const MAX_TRANSPORT_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      reply = await runAgentStep({
        agentId: "nv_media",
        sessionKey: context.registry.byId.nv_media.transport.sessionKey,
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stepId,
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        prompt,
      });
      break;
    } catch (transportErr) {
      logger.logError("transport", `Lần ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= MAX_TRANSPORT_RETRIES) {
        saveWorkflow(context.paths, {
          ...state,
          stage: "awaiting_media_approval",
          last_error: `media_revise transport: ${transportErr.message}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "awaiting_media_approval",
          status: "error",
          summary: [
            "❌ Sửa ảnh không thành công.",
            `Lỗi: ${transportErr.message || "Kết nối bị ngắt."}`,
            "",
            "👉 Thử lại: nhắn lại nhận xét sửa ảnh",
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `🔃 Thử lại lần ${attempt + 1}...`);
    }
  }

  // ─── Parse kết quả ────────────────────────────────────────────
  let media;
  try {
    media = mediaAgent.parseMediaResult(reply, mediaType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_media_approval",
      last_error: `parse_media: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary: [
        "❌ NV Media đã tạo ảnh mới nhưng hệ thống không đọc được kết quả.",
        `Lỗi: ${parseErr.message}`,
        "",
        "👉 Thử lại: nhắn lại nhận xét sửa ảnh",
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // ─── PIPELINE GHÉP 3 LỚP (giống generateMedia) ────────────────────
  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (
    mediaType === "image" &&
    media.generatedImagePath &&
    state.content?.primaryProductImage
  ) {
    try {
      logger.log("media", "🔧 Đang ghép lại 3 lớp với nền mới...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(
          /(\.[a-z]+)$/i,
          "_final$1",
        ),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `✅ Ghép ảnh 3 lớp thành công: ${compositePath}`);
    } catch (compErr) {
      logger.logError("composite", compErr);
      logger.log("info", "⚠️ Sử dụng ảnh nền AI gốc (chưa ghép sản phẩm).");
      media.composited = false;
    }
  }

  // Track prompt version
  mediaAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
    type: mediaType,
    prompt: media.imagePrompt || media.videoPrompt,
    path: finalMediaPath,
    revision: true,
    feedback: context.message,
    composited: media.composited || false,
  });

  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_media_approval",
    media,
  });

  // Tạo file:// link để phó phòng hiển thị ảnh trong chat
  const fileLink = finalMediaPath
    ? `file:///${finalMediaPath.replace(/\\/g, "/")}`
    : "";

  const summary = [
    "🎨 NV Media đã sửa lại theo nhận xét, đang chờ Sếp duyệt.",
    media.composited ? "✅ Đã ghép lại: Nền AI mới + Sản phẩm thật + Logo" : "",
    "",
    finalMediaPath ? `🖼️ Xem ảnh: ${fileLink}` : "",
    `File mới: ${finalMediaPath}`,
    "",
    "👉 Duyệt: \"Duyệt ảnh và đăng bài\"",
    "👉 Sửa tiếp: ghi rõ nhận xét",
  ].filter(Boolean).join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { media, next_expected_action: "media_approval" },
  });
}

/**
 * Bước trung gian: Hỏi sếp muốn đăng ngay hay hẹn giờ.
 */
async function generateMediaFlow(context, state) {
  const mediaRequestStepId = "step_02_media_prepare";
  const promptStepId = "step_02_prompt";
  const mediaStepId = "step_03_media";
  const mediaType = state.intent?.media_type_requested || "image";
  const route = mediaAgent.routeMediaType(mediaType);
  const logoPaths = mediaAgent.resolveLogoAssetPaths(context.openClawHome);

  logger.logPhase("TAO MEDIA", `Loai: ${route.effectiveType}`);
  logger.logHandoff(
    "Pho phong", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_prepare_prompt", route.effectiveType),
  );

  let mediaRequestBrief;
  try {
    const mediaPrepareReply = await runAgentStep({
      agentId: "nv_media",
      sessionKey: context.registry.byId.nv_media.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: mediaRequestStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: mediaAgent.buildMediaPromptRequestPrompt({
        workflowId: state.workflow_id,
        stepId: mediaRequestStepId,
        state,
        mediaType: route.effectiveType,
        openClawHome: context.openClawHome,
        logoPaths,
      }),
    });
    mediaRequestBrief = mediaAgent.parseMediaPromptRequest(mediaPrepareReply).request;
  } catch (mediaPrepareErr) {
    logger.logError("media_prepare_prompt", mediaPrepareErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
      last_error: `media_prepare_prompt error: ${mediaPrepareErr.message || mediaPrepareErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: [
        "NV Media chua tong hop duoc brief de gui NV Prompt.",
        `Loi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        'Thu lai: "Duyet content, tao anh"',
      ].join("\n"),
      data: { error: mediaPrepareErr.message || String(mediaPrepareErr) },
    });
  }

  logger.logHandoff(
    "NV Media", "NV Prompt",
    logger.buildHumanMessage("nv_media", "nv_prompt", "prompt_from_media", route.effectiveType),
  );

  let promptPackage;
  let promptVersion;
  try {
    const promptReply = await runAgentStep({
      agentId: "nv_prompt",
      sessionKey: context.registry.byId.nv_prompt.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: promptStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: promptAgent.buildPromptDraftPrompt({
        workflowId: state.workflow_id,
        stepId: promptStepId,
        state,
        mediaType: route.effectiveType,
        openClawHome: context.openClawHome,
        logoPaths,
        mediaRequestBrief,
      }),
    });
    promptPackage = promptAgent.parsePromptResult(promptReply, route.effectiveType);
    promptVersion = promptAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
      type: route.effectiveType,
      mode: "draft",
      imagePrompt: promptPackage.imagePrompt || "",
      videoPrompt: promptPackage.videoPrompt || "",
      promptDecision: promptPackage.promptDecision,
      product_image: state.content?.primaryProductImage || "",
      logo_paths: logoPaths,
      media_request_brief: mediaRequestBrief,
    });
  } catch (promptErr) {
    logger.logError("prompt_draft", promptErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
      last_error: `prompt_draft error: ${promptErr.message || promptErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: [
        "Khong the tao prompt media tu NV Prompt.",
        `Loi: ${promptErr.message || promptErr}`,
        "",
        'Thu lai: "Duyet content, tao anh"',
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt", "NV Media",
    logger.buildHumanMessage("nv_prompt", "nv_media", "prompt_back_to_media", route.effectiveType),
  );

  const generatingState = saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_started_at: nowIso(),
    generating_route: route.effectiveType,
    generating_logo_paths: logoPaths,
    media_request_brief: mediaRequestBrief,
    prompt_package: promptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
  });

  logger.logHandoff(
    "NV Prompt", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_generate", route.effectiveType),
  );

  const prompt = mediaAgent.buildMediaGeneratePrompt({
    workflowId: state.workflow_id,
    stepId: mediaStepId,
    state: generatingState,
    mediaType: route.effectiveType,
    openClawHome: context.openClawHome,
    promptPackage,
    logoPaths,
  });

  let mediaReply;
  const maxTransportRetries = 2;
  for (let attempt = 1; attempt <= maxTransportRetries; attempt += 1) {
    try {
      mediaReply = await runAgentStep({
        agentId: "nv_media",
        sessionKey: context.registry.byId.nv_media.transport.sessionKey,
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stepId: mediaStepId,
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        prompt,
      });
      break;
    } catch (transportErr) {
      logger.logError("transport", `Lan ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= maxTransportRetries) {
        saveWorkflow(context.paths, {
          ...generatingState,
          stage: "awaiting_content_approval",
          last_error: `media_generate transport error: ${transportErr.message || transportErr}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "awaiting_content_approval",
          status: "error",
          summary: [
            "Khong the tao media sau 2 lan thu.",
            `Loi: ${transportErr.message || "Ket noi toi NV Media bi ngat."}`,
            "",
            'Thu lai: "Duyet content, tao anh"',
          ].join("\n"),
          data: { error: transportErr.message || String(transportErr) },
        });
      }
      logger.log("info", `Thu lai lan ${attempt + 1}...`);
    }
  }

  let media;
  try {
    media = mediaAgent.parseMediaResult(mediaReply, route.effectiveType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    saveWorkflow(context.paths, {
      ...generatingState,
      stage: "awaiting_content_approval",
      last_error: `parse_media error: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: [
        "NV Media da tao media nhung he thong khong doc duoc ket qua.",
        `Loi: ${parseErr.message}`,
        "",
        'Thu lai: "Duyet content, tao anh"',
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  const nextState = saveWorkflow(context.paths, {
    ...generatingState,
    stage: "awaiting_media_approval",
    generating_started_at: null,
    media,
    prompt_package: promptPackage,
  });

  const summary = buildMediaApprovalSummary({
    media,
    promptPackage,
    route,
  });

  logger.logApprovalWait("awaiting_media_approval", summary);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: {
      media,
      prompt_package: promptPackage,
      approved_content: state.content.approvedContent,
      next_expected_action: "media_approval",
    },
  });
}

async function reviseMediaFlow(context, state) {
  const mediaRequestStepId = "step_03a_media_prepare_revise";
  const promptStepId = "step_03_prompt_revise";
  const mediaStepId = "step_03b_media_revise";
  const mediaType =
    state.prompt_package?.promptDecision ||
    state.media?.mediaType ||
    state.intent?.media_type_requested ||
    "image";
  const route = mediaAgent.routeMediaType(mediaType);
  const logoPaths = mediaAgent.resolveLogoAssetPaths(context.openClawHome);
  const promptFocused = isPromptFocusedFeedback(context.message);

  logger.logRejected("media", context.message);

  const feedbackRule = memory.learnFromFeedbackSync("nv_media", context.openClawHome, context.message);
  if (feedbackRule) {
    const latestRule = feedbackRule.rules[feedbackRule.rules.length - 1];
    logger.logLearning("nv_media", latestRule?.text || context.message);
  }
  if (promptFocused) {
    const promptRule = memory.learnFromFeedbackSync("nv_prompt", context.openClawHome, context.message);
    if (promptRule) {
      const latestPromptRule = promptRule.rules[promptRule.rules.length - 1];
      logger.logLearning("nv_prompt", latestPromptRule?.text || context.message);
    }
  }

  state.reject_history = state.reject_history || [];
  state.reject_history.push({
    stage: "media",
    agent: "nv_media",
    feedback: context.message,
    timestamp: nowIso(),
  });
  if (promptFocused) {
    state.reject_history.push({
      stage: "prompt",
      agent: "nv_prompt",
      feedback: context.message,
      timestamp: nowIso(),
    });
  }

  const mediaRejects = state.reject_history.filter((entry) => entry.stage === "media").length;
  if (mediaRejects > MAX_REJECT_PER_STAGE) {
    logger.logError("media", `NV Media da bi tu choi ${mediaRejects} lan.`);
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `NV Media da bi tu choi ${mediaRejects} lan lien tiep. Can xem lai prompt package hoac yeu cau duyet.`,
      data: { reject_count: mediaRejects },
    });
  }

  logger.logHandoff(
    "Pho phong", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_prepare_revise", context.message.slice(0, 80)),
  );

  let mediaRequestBrief;
  try {
    const mediaPrepareReply = await runAgentStep({
      agentId: "nv_media",
      sessionKey: context.registry.byId.nv_media.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: mediaRequestStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: mediaAgent.buildMediaPromptReviseRequestPrompt({
        workflowId: state.workflow_id,
        stepId: mediaRequestStepId,
        state,
        mediaType: route.effectiveType,
        feedback: context.message,
        openClawHome: context.openClawHome,
        logoPaths,
      }),
    });
    mediaRequestBrief = mediaAgent.parseMediaPromptRequest(mediaPrepareReply).request;
  } catch (mediaPrepareErr) {
    logger.logError("media_prepare_prompt_revise", mediaPrepareErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_media_approval",
      last_error: `media_prepare_prompt_revise error: ${mediaPrepareErr.message || mediaPrepareErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary: [
        "NV Media chua tong hop duoc yeu cau prompt moi.",
        `Loi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
      ].join("\n"),
      data: { error: mediaPrepareErr.message || String(mediaPrepareErr) },
    });
  }

  logger.logHandoff(
    "NV Media", "NV Prompt",
    logger.buildHumanMessage("nv_media", "nv_prompt", "prompt_from_media", route.effectiveType),
  );

  let promptPackage;
  let promptVersion;
  try {
    const promptReply = await runAgentStep({
      agentId: "nv_prompt",
      sessionKey: context.registry.byId.nv_prompt.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: promptStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: promptAgent.buildPromptRevisePrompt({
        workflowId: state.workflow_id,
        stepId: promptStepId,
        state,
        mediaType: route.effectiveType,
        feedback: context.message,
        openClawHome: context.openClawHome,
        logoPaths,
        mediaRequestBrief,
      }),
    });
    promptPackage = promptAgent.parsePromptResult(promptReply, route.effectiveType);
    promptVersion = promptAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
      type: route.effectiveType,
      mode: "revise",
      imagePrompt: promptPackage.imagePrompt || "",
      videoPrompt: promptPackage.videoPrompt || "",
      promptDecision: promptPackage.promptDecision,
      product_image: state.content?.primaryProductImage || "",
      logo_paths: logoPaths,
      feedback: context.message,
      media_request_brief: mediaRequestBrief,
    });
  } catch (promptErr) {
    logger.logError("prompt_revise", promptErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_media_approval",
      last_error: `prompt_revise error: ${promptErr.message || promptErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary: [
        "Khong the sua prompt media.",
        `Loi: ${promptErr.message || promptErr}`,
        "",
        "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt", "NV Media",
    logger.buildHumanMessage("nv_prompt", "nv_media", "prompt_back_to_media", route.effectiveType),
  );

  const revisingState = saveWorkflow(context.paths, {
    ...state,
    stage: "revising_media",
    revising_started_at: nowIso(),
    revising_feedback: context.message,
    revising_route: route.effectiveType,
    revising_logo_paths: logoPaths,
    media_request_brief: mediaRequestBrief,
    prompt_package: promptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
  });

  logger.logHandoff(
    "NV Prompt", "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_revise", context.message.slice(0, 80)),
  );

  const prompt = mediaAgent.buildMediaRevisePrompt({
    workflowId: state.workflow_id,
    stepId: mediaStepId,
    state: revisingState,
    feedback: context.message,
    mediaType: route.effectiveType,
    openClawHome: context.openClawHome,
    promptPackage,
    logoPaths,
  });

  let reply;
  const maxTransportRetries = 2;
  for (let attempt = 1; attempt <= maxTransportRetries; attempt += 1) {
    try {
      reply = await runAgentStep({
        agentId: "nv_media",
        sessionKey: context.registry.byId.nv_media.transport.sessionKey,
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stepId: mediaStepId,
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        prompt,
      });
      break;
    } catch (transportErr) {
      logger.logError("transport", `Lan ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= maxTransportRetries) {
        saveWorkflow(context.paths, {
          ...revisingState,
          stage: "awaiting_media_approval",
          last_error: `media_revise transport: ${transportErr.message || transportErr}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "awaiting_media_approval",
          status: "error",
          summary: [
            "Khong the sua media.",
            `Loi: ${transportErr.message || "Ket noi bi ngat."}`,
            "",
            "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
          ].join("\n"),
          data: { error: transportErr.message || String(transportErr) },
        });
      }
      logger.log("info", `Thu lai lan ${attempt + 1}...`);
    }
  }

  let media;
  try {
    media = mediaAgent.parseMediaResult(reply, route.effectiveType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    saveWorkflow(context.paths, {
      ...revisingState,
      stage: "awaiting_media_approval",
      last_error: `parse_media: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary: [
        "NV Media da tao media moi nhung he thong khong doc duoc ket qua.",
        `Loi: ${parseErr.message}`,
        "",
        "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  const nextState = saveWorkflow(context.paths, {
    ...revisingState,
    stage: "awaiting_media_approval",
    revising_started_at: null,
    media,
    prompt_package: promptPackage,
  });

  const summary = buildMediaApprovalSummary({
    media,
    promptPackage,
    route,
  });

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { media, prompt_package: promptPackage, next_expected_action: "media_approval" },
  });
}

function askPublishDecision(context, state) {
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_publish_decision",
  });

  const summary = [
    "✅ Sếp đã duyệt cả content và media!",
    "",
    "👉 Đăng ngay: \"Đăng ngay\" hoặc \"Publish\"",
    "👉 Hẹn giờ: \"Hẹn giờ 20:00 hôm nay\" hoặc \"Schedule 2026-04-10T20:00:00+07:00\"",
  ].join("\n");

  logger.logApprovalWait("awaiting_publish_decision", "Sếp chọn Đăng ngay hay Hẹn giờ?");

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { next_expected_action: "publish_decision" },
  });
}

/**
 * Đăng bài ngay.
 */
function publishNowAction(context, state) {
  logger.logPhase("ĐĂNG BÀI", "Đang đăng bài lên Fanpage...");

  const mediaPaths = [];
  if (state.media?.generatedImagePath) mediaPaths.push(state.media.generatedImagePath);
  if (state.media?.generatedVideoPath) mediaPaths.push(state.media.generatedVideoPath);

  const publishResult = publisher.publishNow({
    content: state.content.approvedContent,
    mediaPaths,
  });

  const postId = publisher.extractPostId(publishResult);

  const publishState = {
    ...state,
    status: "completed",
    stage: "published",
    publish: publishResult,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, publishState);

  logger.logPublished(postId);

  const summary = [
    "📤 Bài viết đã được đăng thành công lên Fanpage!",
    postId ? `Post ID: ${postId}` : "",
    `Media: ${mediaPaths.join(", ") || "không có"}`,
  ].filter(Boolean).join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "published",
    summary,
    humanMessage: summary,
    data: { post_id: postId, media_paths: mediaPaths, publish_result: publishResult },
  });
}

/**
 * Hẹn giờ đăng bài.
 */
function schedulePostAction(context, state) {
  const scheduleTime = state.intent?.schedule_time || context.scheduleTime || context.message;

  logger.logPhase("HẸN GIỜ", `Đang hẹn giờ đăng bài: ${scheduleTime}`);

  const mediaPaths = [];
  if (state.media?.generatedImagePath) mediaPaths.push(state.media.generatedImagePath);
  if (state.media?.generatedVideoPath) mediaPaths.push(state.media.generatedVideoPath);

  const scheduleResult = publisher.schedulePost({
    content: state.content.approvedContent,
    mediaPaths,
    scheduleTime,
  });

  const postId = publisher.extractPostId(scheduleResult);

  const schedState = {
    ...state,
    status: "completed",
    stage: "scheduled",
    publish: scheduleResult,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, schedState);

  logger.logScheduled(scheduleTime);

  const summary = [
    "📅 Bài viết đã được hẹn giờ đăng thành công!",
    `Thời gian: ${scheduleTime}`,
    postId ? `Post ID: ${postId}` : "",
  ].filter(Boolean).join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "scheduled",
    summary,
    humanMessage: summary,
    data: { post_id: postId, schedule_time: scheduleTime, schedule_result: scheduleResult },
  });
}

/**
 * Sửa bài đã đăng (EDIT_PUBLISHED intent).
 */
async function editPublishedFlow(context) {
  const workflowId = `wf_edit_${randomUUID()}`;
  const stepId = "step_edit_content";
  const postId = context.intent?.post_id;

  if (!postId) {
    return buildResult({
      status: "blocked",
      summary: "⚠️ Cần cung cấp Post ID của bài viết muốn sửa. Ví dụ: \"Sửa bài đã đăng, post ID: 643048852218433_123456\"",
    });
  }

  logger.logPhase("SỬA BÀI ĐÃ ĐĂNG", `Post ID: ${postId}`);
  logger.logHandoff(
    "Phó phòng", "NV Content",
    logger.buildHumanMessage("pho_phong", "nv_content", "edit_post", context.message.slice(0, 80)),
  );

  const prompt = contentAgent.buildContentRevisePrompt({
    workflowId,
    stepId,
    originalBrief: context.message,
    feedback: context.message,
    oldContent: "(Bài cũ trên Facebook — viết mới theo yêu cầu sếp)",
    openClawHome: context.openClawHome,
  });

  const reply = await runAgentStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });

  const content = contentAgent.parseContentResult(reply);

  // Lưu state chờ duyệt nội dung mới trước khi update lên FB
  const state = saveWorkflow(context.paths, {
    workflow_id: workflowId,
    created_at: nowIso(),
    status: "pending",
    stage: "awaiting_edit_approval",
    intent: context.intent,
    original_brief: context.message,
    content,
    post_id: postId,
    reject_history: [],
    prompt_versions: [],
  });

  const summary = [
    "✏️ NV Content đã viết nội dung mới cho bài đã đăng, đang chờ Sếp duyệt.",
    `Post ID sẽ cập nhật: ${postId}`,
    "",
    "━━━ NỘI DUNG MỚI ━━━",
    content.approvedContent,
    "━━━━━━━━━━━━━━━━━━━━━",
    "",
    "👉 Duyệt: \"Duyệt content\" — nội dung sẽ được cập nhật lên Facebook",
    "👉 Sửa: ghi rõ nhận xét",
  ].join("\n");

  logger.logApprovalWait("awaiting_edit_approval", content.approvedContent);

  return buildResult({
    workflowId,
    stage: state.stage,
    summary,
    humanMessage: summary,
    data: { content, post_id: postId, next_expected_action: "edit_approval" },
  });
}

/**
 * Xử lý approve cho bài edit → gọi facebook_edit_post.
 */
function applyEditToPublished(context, state) {
  const postId = state.post_id;

  logger.logPhase("CẬP NHẬT BÀI ĐÃ ĐĂNG", `Đang cập nhật post ${postId}...`);

  const editResult = publisher.editPublishedPost({
    postId,
    newContent: state.content.approvedContent,
  });

  const editState = {
    ...state,
    status: "completed",
    stage: "edited",
    publish: editResult,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, editState);

  logger.logEdited(postId);

  const summary = [
    "✏️ Bài viết trên Facebook đã được cập nhật thành công!",
    `Post ID: ${postId}`,
  ].join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "edited",
    summary,
    humanMessage: summary,
    data: { post_id: postId, edit_result: editResult },
  });
}

/**
 * Xử lý intent TRAIN — ghi quy tắc thủ công.
 */
function handleTrainIntent(context) {
  const feedback = context.intent?.feedback_or_brief || context.message;
  const targetAgent = context.intent?.target_agent;

  logger.logPhase("TRAINING", `Sếp dạy quy tắc mới`);

  const results = [];

  // Ghi rule cho agent được chỉ định, hoặc cả hai nếu "self"
  const agents = targetAgent === "nv_content"
    ? ["nv_content"]
    : targetAgent === "nv_media"
      ? ["nv_media"]
      : targetAgent === "nv_prompt"
        ? ["nv_prompt"]
        : ["nv_content", "nv_prompt", "nv_media"];

  for (const agentId of agents) {
    memory.appendRule(agentId, context.openClawHome, feedback);
    logger.logLearning(agentId, feedback);
    results.push(agentId);
  }

  const summary = [
    "🧠 Đã ghi nhớ quy tắc mới!",
    `Áp dụng cho: ${results.join(", ")}`,
    `Nội dung: "${feedback.slice(0, 200)}"`,
    "",
    "Quy tắc này sẽ tự động được nhúng vào prompt mỗi khi nhân viên làm việc.",
  ].join("\n");

  return buildResult({
    status: "ok",
    stage: "trained",
    summary,
    humanMessage: summary,
    data: { trained_agents: results, rule: feedback },
  });
}

// ─── MAIN ROUTING ────────────────────────────────────────────────────

/**
 * Xử lý workflow đang pending.
 */
async function continueWorkflow(context, state) {
  state = migrateState(state);
  const decision = intentParser.classifyPendingDecision(context.message, state.stage);

  if (state.stage === "revising_media") {
    const recoveredArtifacts = scanLatestGeneratedMedia(context.openClawHome, state.revising_started_at);
    const recoveredMedia = {
      ...(state.media || {}),
      generatedImagePath: recoveredArtifacts.imagePath || state.media?.generatedImagePath || "",
      generatedVideoPath: recoveredArtifacts.videoPath || state.media?.generatedVideoPath || "",
      mediaType: state.revising_route || state.media?.mediaType || state.intent?.media_type_requested || "image",
      imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
      videoPrompt: state.prompt_package?.videoPrompt || state.media?.videoPrompt || "",
      usedProductImage: state.content?.primaryProductImage || state.media?.usedProductImage || "",
      usedLogoPaths: state.revising_logo_paths || state.media?.usedLogoPaths || [],
    };

    if (collectMediaPaths(recoveredMedia).length > 0) {
      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });
      const summary = buildMediaApprovalSummary({
        media: recoveredMedia,
        promptPackage: state.prompt_package || {},
        route: mediaAgent.routeMediaType(recoveredMedia.mediaType),
      });
      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: {
          media: recoveredMedia,
          prompt_package: state.prompt_package || {},
          next_expected_action: "media_approval",
        },
      });
    }

    saveWorkflow(context.paths, { ...state, stage: "awaiting_media_approval" });
    const summary = [
      "Buoc sua media bi ngat giua chung, chua co media moi.",
      "",
      "Gui lai nhan xet de thu sua media lan nua.",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary,
      humanMessage: summary,
    });
  }

  if (state.stage === "generating_media") {
    const recoveredArtifacts = scanLatestGeneratedMedia(context.openClawHome, state.generating_started_at);
    const recoveredMedia = {
      generatedImagePath: recoveredArtifacts.imagePath || "",
      generatedVideoPath: recoveredArtifacts.videoPath || "",
      mediaType: state.generating_route || state.intent?.media_type_requested || "image",
      imagePrompt: state.prompt_package?.imagePrompt || "",
      videoPrompt: state.prompt_package?.videoPrompt || "",
      usedProductImage: state.content?.primaryProductImage || "",
      usedLogoPaths: state.generating_logo_paths || [],
    };

    if (collectMediaPaths(recoveredMedia).length > 0) {
      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });
      const summary = buildMediaApprovalSummary({
        media: recoveredMedia,
        promptPackage: state.prompt_package || {},
        route: mediaAgent.routeMediaType(recoveredMedia.mediaType),
      });
      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: {
          media: recoveredMedia,
          prompt_package: state.prompt_package || {},
          next_expected_action: "media_approval",
        },
      });
    }

    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
    });
    const summary = [
      "Buoc tao media bi ngat giua chung, chua co file media nao.",
      "",
      'Thu lai: "Duyet content, tao anh"',
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary,
      humanMessage: summary,
    });
  }

  if (state.stage === "revising_media") {
    // Phục hồi sau crash của reviseMedia: tìm ảnh mới nhất (không phải screenshot/final cũ)
    const imagesDir = path.join(context.openClawHome, "workspace_media", "artifacts", "images");
    const currentBg = state.media?.generatedImagePath || "";
    let latestImage = "";
    try {
      if (fs.existsSync(imagesDir)) {
        const files = fs.readdirSync(imagesDir)
          .filter((f) => {
            if (f.includes("-before-") || f.includes("-after-") || f.includes("_final")) return false;
            if (!(/\.(png|jpg|jpeg|webp)$/i.test(f))) return false;
            // Bỏ file cũ nếu đượng dẫn khớp với nền cũ (trước khi revise)
            const fullPath = path.join(imagesDir, f);
            if (currentBg && path.resolve(fullPath) === path.resolve(currentBg)) return false;
            return true;
          })
          .map((f) => ({ f, t: fs.statSync(path.join(imagesDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) latestImage = path.join(imagesDir, files[0].f);
      }
    } catch { /* ignore */ }

    if (latestImage) {
      logger.log("media", `✅ Phục hồi ảnh sửa từ lượt trước: ${latestImage}`);
      let finalPath = latestImage;
      if (state.content?.primaryProductImage) {
        try {
          const compositePath = await mediaAgent.compositeImage3Layers({
            backgroundPath: latestImage,
            productImagePath: state.content.primaryProductImage,
            outputPath: latestImage.replace(/(\.[a-z]+)$/i, "_final$1"),
          });
          finalPath = compositePath;
        } catch (e) { logger.logError("composite", e); }
      }
      const recoveredMedia = {
        generatedImagePath: finalPath,
        mediaType: "image",
        imagePrompt: state.media?.imagePrompt || "(phục hồi sau sửa)",
        composited: finalPath !== latestImage,
      };
      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });
      const finalLink = `file:///${finalPath.replace(/\\/g, "/")}`;
      const summary = [
        "🎨 Đã phục hồi ảnh sửa từ lượt trước, đang chờ Sếp duyệt.",
        recoveredMedia.composited ? "✅ Đã ghép: Nền AI mới + Sản phẩm thật + Logo" : "",
        "",
        `🖼️ Xem ảnh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        "👉 Duyệt và đăng bài: \"Duyệt ảnh và đăng bài\"",
        "👉 Sửa tiếp: ghi rõ nhận xét",
      ].filter(Boolean).join("\n");
      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { media: recoveredMedia, next_expected_action: "media_approval" },
      });
    }

    // Không có ảnh mới — quay lại awaiting_media_approval với ảnh cũ
    saveWorkflow(context.paths, { ...state, stage: "awaiting_media_approval" });
    const summary = [
      "❌ Bước sửa ảnh bị ngắt giữa chừng, chưa có ảnh mới.",
      "",
      "👉 Nhắn lại nhận xét để thử sửa ảnh lần nữa",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary,
      humanMessage: summary,
    });
  }

  // generating_media — Đang tạo ảnh, chặn loop.
  // Stage này được set ngay trước khi gọi NV Media. Nếu orchestrator
  // crash sau khi có ảnh nhưng trước khi save, lần sau sẽ vào bộ này.
  if (state.stage === "generating_media") {
    // Ưu tiên dùng đường dẫn đã lưu trong state (chính xác, không nhầm workflow cũ)
    const savedBg = state.generating_bg_image_path || "";
    const savedProduct = state.generating_product_image_path || state.content?.primaryProductImage || "";

    let bgImagePath = "";
    if (savedBg && fs.existsSync(savedBg)) {
      bgImagePath = savedBg;
      logger.log("media", `✅ Dùng path nền đã lưu trong state: ${bgImagePath}`);
    } else {
      // Fallback: scan thư mục, chỉ lấy ảnh được tạo sau khi bắt đầu workflow
      const imagesDir = path.join(context.openClawHome, "workspace_media", "artifacts", "images");
      const startedAt = state.generating_started_at ? new Date(state.generating_started_at).getTime() : 0;
      try {
        if (fs.existsSync(imagesDir)) {
          const files = fs.readdirSync(imagesDir)
            .filter((f) => {
              if (f.includes("-before-") || f.includes("-after-") || f.includes("_final")) return false;
              if (!(/\.(png|jpg|jpeg|webp)$/i.test(f))) return false;
              const fullPath = path.join(imagesDir, f);
              const mtime = fs.statSync(fullPath).mtimeMs;
              return mtime >= startedAt; // chỉ lấy file mới hơn thời điểm bắt đầu
            })
            .map((f) => ({ f, t: fs.statSync(path.join(imagesDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          if (files.length > 0) bgImagePath = path.join(imagesDir, files[0].f);
        }
      } catch { /* ignore */ }
    }

    if (bgImagePath) {
      logger.log("media", `✅ Phục hồi: chạy lại composite với nền: ${bgImagePath}`);
      let finalPath = bgImagePath;
      if (savedProduct && fs.existsSync(savedProduct)) {
        try {
          const compositePath = await mediaAgent.compositeImage3Layers({
            backgroundPath: bgImagePath,
            productImagePath: savedProduct,
            outputPath: bgImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
          });
          finalPath = compositePath;
          logger.log("media", `✅ Ghép 3 lớp thành công: ${compositePath}`);
        } catch (compErr) {
          process.stderr.write(`[COMPOSITE_RECOVERY_ERROR] ${compErr.stack || compErr.message}\n`);
          logger.logError("composite", compErr);
          logger.log("info", "⚠️ Dùng ảnh nền gốc (composite thất bại).");
        }
      }

      const recoveredMedia = {
        generatedImagePath: finalPath,
        mediaType: "image",
        imagePrompt: state.media?.imagePrompt || "(phục hồi)",
        composited: finalPath !== bgImagePath,
      };

      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });

      const finalLink = `file:///${finalPath.replace(/\\/g, "/")}`;
      const summary = [
        "🎨 Đã ghép xong ảnh, đang chờ Sếp duyệt.",
        recoveredMedia.composited ? "✅ Đã ghép: Nền AI + Sản phẩm thật + Logo" : "⚠️ Chỉ có ảnh nền AI (chưa ghép sản phẩm).",
        "",
        `🖼️ Xem ảnh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        "👉 Duyệt và đăng bài: \"Duyệt ảnh và đăng bài\"",
        "👉 Sửa ảnh: ghi rõ nhận xét",
      ].filter(Boolean).join("\n");

      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { media: recoveredMedia, next_expected_action: "media_approval" },
      });
    }

    // Không tìm thấy ảnh nào — quay về step trước, cho phép re-trigger
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
    });
    const noImgSummary = [
      "❌ Bước tạo ảnh bị ngắt giữa chừng, chưa có file ảnh nào.",
      "",
      "👉 Thử lại: \"Duyệt content, tạo ảnh\"",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: noImgSummary,
      humanMessage: noImgSummary,
    });
  }

  // awaiting_content_approval
  if (state.stage === "awaiting_content_approval") {
    if (decision === "approve") {
      logger.logApproved("content");
      return generateMediaFlow(context, state);
    }
    if (decision === "reject") {
      return reviseContent(context, state);
    }
    // Unknown — thử parse intent nếu là lệnh mới hoàn toàn
    return buildBlockedResult(state, context.message);
  }

  // awaiting_media_approval
  if (state.stage === "awaiting_media_approval") {
    if (decision === "approve") {
      logger.logApproved("media");
      return askPublishDecision(context, state);
    }
    if (decision === "reject") {
      return reviseMediaFlow(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  // awaiting_publish_decision
  if (state.stage === "awaiting_publish_decision") {
    if (decision === "publish_now") {
      return publishNowAction(context, state);
    }
    if (decision === "schedule") {
      // Trích schedule time từ message
      const timeMatch = context.message.match(
        /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2})?)/,
      );
      context.scheduleTime = timeMatch ? timeMatch[1] : context.message;
      return schedulePostAction(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  // awaiting_edit_approval
  if (state.stage === "awaiting_edit_approval") {
    if (decision === "approve" || intentParser.classifyPendingDecision(context.message, "awaiting_content_approval") === "approve") {
      return applyEditToPublished(context, state);
    }
    if (decision === "reject" || intentParser.classifyPendingDecision(context.message, "awaiting_content_approval") === "reject") {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
    }
    return buildBlockedResult(state, context.message);
  }

  // Unknown stage — archive and restart
  archiveWorkflow(context.paths, state);
  return startNewWorkflow(context);
}

function buildBlockedResult(state, message) {
  const stageLabels = {
    awaiting_content_approval: "đang chờ duyệt content",
    awaiting_media_approval: "đang chờ duyệt media",
    awaiting_publish_decision: "đang chờ quyết định đăng bài",
    awaiting_edit_approval: "đang chờ duyệt nội dung sửa",
    generating_media: "đang tạo ảnh (vui lòng đợi)",
  };
  const stageLabel = stageLabels[state?.stage] || "đang chờ xử lý";

  return buildResult({
    workflowId: state?.workflow_id || null,
    stage: state?.stage || null,
    status: "blocked",
    summary: [
      `⏳ Đang có workflow pending: ${stageLabel}.`,
      `Tin nhắn "${message.slice(0, 100)}" chưa được nhận diện rõ.`,
      "",
      "Gợi ý lệnh phù hợp:",
      state?.stage === "awaiting_content_approval"
        ? '  • "Duyệt content" / "Sửa content, <nhận xét>"'
        : state?.stage === "awaiting_media_approval"
          ? '  • "Duyệt ảnh" / "Sửa ảnh, <nhận xét>" / "Sửa prompt, <nhận xét>"'
          : state?.stage === "awaiting_publish_decision"
            ? '  • "Đăng ngay" / "Hẹn giờ <thời gian>"'
            : '  • "Duyệt" / "Sửa"',
    ].join("\n"),
    data: { expected_stage: state?.stage || null },
  });
}

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const workspaceDir = getPhoPhongWorkspace(config, openClawHome);
  const paths = buildPaths(workspaceDir);

  // Reset command
  if (options.reset) {
    if (fs.existsSync(paths.currentFile)) {
      const current = readJsonIfExists(paths.currentFile, {});
      archiveWorkflow(paths, current);
    }
    printResult(
      buildResult({
        status: "reset",
        summary: "🔄 Đã reset workflow pending của agent-orchestrator-test.",
        humanMessage: "🔄 Đã reset workflow pending.",
      }),
      options.json,
    );
    return;
  }

  const message = loadMessage(options);
  if (!message) {
    throw new Error("Missing task message.");
  }

  const registry = discoverRegistry({ openClawHome });
  if (!registry.byId.pho_phong || !registry.byId.nv_content || !registry.byId.nv_prompt || !registry.byId.nv_media) {
    throw new Error("Missing required agents pho_phong / nv_content / nv_prompt / nv_media in runtime registry.");
  }

  const currentState = readJsonIfExists(paths.currentFile, null);

  // Parse intent nếu không có workflow pending
  let intent = null;
  if (!currentState) {
    intent = await intentParser.parseIntent({
      message,
      openClawHome,
      registry,
      timeoutMs: options.timeoutMs,
      useLLM: options.useLLMIntent,
    });
    logger.logIntent(intent);
  } else {
    intent = intentParser.parseIntentByKeywords(message);
  }

  const context = {
    message,
    options,
    openClawHome,
    registry,
    paths,
    intent,
  };

  let result;

  if (currentState && shouldSupersedePendingWorkflow(message, currentState, intent)) {
    logger.log("info", `Phat hien brief moi, archive workflow cu ${currentState.workflow_id}.`);
    archiveWorkflow(paths, currentState);
    result = await startNewWorkflow({
      ...context,
      intent,
      supersededWorkflowId: currentState.workflow_id,
    });
  } else if (currentState) {
    // Workflow đang pending — tiếp tục
    result = await continueWorkflow(context, currentState);
  } else {
    // Không có workflow pending — dispatch theo intent
    switch (intent.intent) {
      case "CREATE_NEW":
        result = await startNewWorkflow(context);
        break;
      case "EDIT_CONTENT":
        // Không có workflow pending nhưng muốn sửa content → tạo workflow mới
        result = await startNewWorkflow(context);
        break;
      case "EDIT_MEDIA":
        // Không có workflow nên create new
        result = await startNewWorkflow(context);
        break;
      case "EDIT_PUBLISHED":
        result = await editPublishedFlow(context);
        break;
      case "SCHEDULE":
        // Schedule nhưng không có workflow — cần tạo content trước
        result = await startNewWorkflow(context);
        break;
      case "TRAIN":
        result = handleTrainIntent(context);
        break;
      default:
        result = await startNewWorkflow(context);
    }
  }

  printResult(result, options.json);
}

if (require.main === module) {
  runCli().catch((error) => {
    logger.logError("orchestrator", error);
    console.error(
      JSON.stringify(
        buildResult({
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
        }),
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

// ─── BACKWARD-COMPATIBLE EXPORTS ─────────────────────────────────────
// Giữ nguyên exports cũ cho test file hiện tại.

function extractBlock(text, startMarker, endMarker) {
  const source = String(text || "");
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) return "";
  const fromStart = source.slice(startIndex + startMarker.length);
  const endIndex = fromStart.indexOf(endMarker);
  return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
}

function extractField(text, label) {
  const match = String(text || "").match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
  return match?.[1]?.trim() || "";
}

function classifyContentDecision(message) {
  return intentParser.classifyPendingDecision(message, "awaiting_content_approval");
}

function classifyMediaDecision(message) {
  return intentParser.classifyPendingDecision(message, "awaiting_media_approval");
}

function parseContentReply(reply) {
  return contentAgent.parseContentResult(reply);
}

function parseMediaReply(reply) {
  return mediaAgent.parseImageResult(reply);
}

module.exports = {
  classifyContentDecision,
  classifyMediaDecision,
  extractBlock,
  extractField,
  parseContentReply,
  parseMediaReply,
  shouldSupersedePendingWorkflow,
};
