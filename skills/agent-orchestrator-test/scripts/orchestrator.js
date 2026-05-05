/**
 * orchestrator.js â€�? Bá»™ Ä‘iá»�?u phá»‘i trung tÃ¢m v2.
 *
 * NÃ¢ng cáº¥p tá»« state-machine tuyáº¿n tÃ­nh cá»‘ Ä‘á»‹nh sang Multi-Agent tá»± trá»‹:
 * - Dynamic Routing qua LLM intent parsing
 * - Long-term Memory (rules.json self-learning)
 * - Human-in-the-Loop báº¯t buá»™c táº¡i má»�?i checkpoint
 * - Video placeholder + fallback
 * - Publish / Schedule / Edit Published
 * - Human-readable logging (khÃ´ng in raw JSON)
 *
 * Backward compatible: giá»¯ nguyÃªn exports cÅ© cho test.
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const {
  normalizeText,
  resolveOpenClawHome,
  loadOpenClawConfig,
} = require("../../agent-orchestrator/scripts/common");
const { discoverRegistry } = require("../../agent-orchestrator/scripts/registry");
const transport = require("./transport");
const beClient = require("./be-client");

const intentParser = require("./intent_parser");
const contentAgent = require("./content_agent");
const promptAgent = require("./prompt_agent");
const mediaAgent = require("./media_agent");
const videoAgent = require("./video_agent");
const publisher = require("./publisher");
const memory = require("./memory");
const logger = require("./logger");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAX_REJECT_PER_STAGE = 5;
const DEFAULT_CONTENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MEDIA_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_AUTO_NOTIFY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_VIDEO_PROMPT_TEMPLATE = promptAgent.DEFAULT_VIDEO_PROMPT_TEMPLATE;

// â�?€â�?€â�?€ CLI Argument Parsing â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

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
    noCompanyLogo: true,
    useLLMIntent: false, // Táº¯t máº·c Ä‘á»‹nh â€�? LLM intent gá»­i prompt vÃ o lane phÃ³ phÃ²ng gÃ¢y lá»™ ná»™i dung. DÃ¹ng keyword matching.
    autoNotifyWatch: false,
    notifySessionKey: "",
    notifyWorkflowId: "",
    notifyStage: "",
    managerInstanceId: null,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--from") {
      options.from = argv[index + 1] || options.from;
      index += 1;
      continue;
    }
    if (token === "--openclaw-home") {
      options.openClawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--message-file") {
      options.messageFile = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--reset") {
      options.reset = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--no-company-logo" || token === "--no-logo") {
      options.noCompanyLogo = true;
      continue;
    }
    if (token === "--with-company-logo" || token === "--logo") {
      options.noCompanyLogo = false;
      continue;
    }
    if (token === "--no-llm-intent") {
      options.useLLMIntent = false;
      continue;
    }
    if (token === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] || options.timeoutMs);
      index += 1;
      continue;
    }
    if (token === "--auto-notify-watch") {
      options.autoNotifyWatch = true;
      continue;
    }
    if (token === "--notify-session-key") {
      options.notifySessionKey = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--notify-workflow-id") {
      options.notifyWorkflowId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--notify-stage") {
      options.notifyStage = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--manager-instance-id") {
      options.managerInstanceId = argv[index + 1] || null;
      index += 1;
      continue;
    }
    positional.push(token);
  }

  options.message = positional.join(" ").trim();
  return options;
}

function loadMessage(options) {
  if (options.messageFile) {
    return fs
      .readFileSync(options.messageFile, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  }
  return String(options.message || "").trim();
}

// â�?€â�?€â�?€ Workspace & State Helpers â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

function getPhoPhongWorkspace(config, openClawHome) {
  const workspace =
    config?.agents?.list?.find((agent) => agent?.id === "pho_phong")?.workspace ||
    path.join(openClawHome, "workspace_phophong");
  return path.resolve(workspace);
}

function ensureDir(dirPath) {
  if (!dirPath) return;
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
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MEDIA_TIMEOUT_MS;
  return Math.max(numeric, DEFAULT_MEDIA_TIMEOUT_MS);
}

function getContentTimeoutMs(baseTimeoutMs) {
  const numeric = Number(baseTimeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_CONTENT_TIMEOUT_MS;
  return Math.max(numeric, DEFAULT_CONTENT_TIMEOUT_MS);
}

function isAsyncStepStillRunningError(error) {
  const message = String(error?.message || error || "")
    .trim()
    .toLowerCase();
  if (!message) return false;
  return (
    message.includes("timed out waiting") ||
    message.includes("process still running") ||
    message.includes("still running") ||
    message.includes("timeout")
  );
}

function buildAsyncWaitingSummary(kind) {
  if (kind === "video") {
    return [
      "Hệ thống vẫn đang render video, chưa có kết quả cuối cùng.",
      "",
      "Tôi sẽ gửi video ngay khi Media Video trả kết quả.",
    ].join("\n");
  }
  return [
    "Hệ thống vẫn đang render media, chưa có kết quả cuối cùng.",
    "",
    "Tôi sẽ gửi media ngay khi NV Media trả kết quả.",
  ].join("\n");
}

function startContentApprovalAutoNotifyWatcher(context, workflowId, sessionKey) {
  startWorkflowStageAutoNotifyWatcher({
    openClawHome: context.openClawHome,
    workflowId,
    stage: "awaiting_content_approval",
    sessionKey,
    timeoutMs: getContentTimeoutMs(context.options?.timeoutMs),
  });
}

function getAsyncStageElapsedMs(startedAtIso) {
  if (!startedAtIso) return null;
  const startedAtMs = new Date(startedAtIso).getTime();
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return null;
  }
  return Math.max(0, Date.now() - startedAtMs);
}

function hasAsyncStageExceededGrace(startedAtIso, timeoutMs) {
  const elapsedMs = getAsyncStageElapsedMs(startedAtIso);
  if (elapsedMs === null) return false;
  return elapsedMs >= timeoutMs;
}

function buildRecoveredAsyncStageResult(state) {
  const summary = buildStageHumanMessage(state);
  const nextExpectedAction =
    state.stage === "awaiting_video_approval"
      ? "video_approval"
      : state.stage === "awaiting_media_approval"
        ? "media_approval"
        : null;

  return buildResult({
    workflowId: state.workflow_id,
    stage: state.stage,
    summary,
    humanMessage: summary,
    data: {
      media: state.media || {},
      prompt_package: state.prompt_package || {},
      ...(nextExpectedAction ? { next_expected_action: nextExpectedAction } : {}),
    },
  });
}

function extractWorkflowGuidelines(message) {
  const raw = String(message || "").trim();
  if (!raw) return [];
  const normalized = normalizeText(raw);
  const isStatusQuery = ["den dau roi", "toi dau roi", "xong chua", "tien do", "bao gio xong"].some(
    (token) => normalized.includes(token),
  );
  if (isStatusQuery) {
    return [];
  }

  const guidelineSignals = [
    "nho",
    "luu y",
    "tu gio",
    "bat buoc",
    "tone",
    "giong",
    "phong cach",
    "luon",
  ];
  if (!guidelineSignals.some((token) => normalized.includes(token))) {
    return [];
  }

  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) => line.length >= 8);
}

function mergeWorkflowGuidelines(existingGuidelines, message) {
  return [
    ...new Set([
      ...(existingGuidelines || []).map((item) => String(item || "").trim()).filter(Boolean),
      ...extractWorkflowGuidelines(message),
    ]),
  ];
}

function rememberApprovedContent(state, openClawHome) {
  if (!state?.content?.approvedContent) return;
  memory.appendSuccessExample("nv_content", openClawHome, {
    workflow_id: state.workflow_id,
    kind: "content_approved",
    brief: state.original_brief || "",
    approved_result: state.content.approvedContent,
    content: state.content.approvedContent,
    product_name: state.content.productName || "",
    global_guidelines: state.global_guidelines || [],
  });
}

function rememberApprovedPrompt(state, openClawHome, mediaKind) {
  const prompt =
    mediaKind === "video"
      ? state?.prompt_package?.videoPrompt || state?.media?.videoPrompt || ""
      : state?.prompt_package?.imagePrompt || state?.media?.imagePrompt || "";
  if (!prompt) return;

  memory.appendSuccessExample("nv_prompt", openClawHome, {
    workflow_id: state.workflow_id,
    kind: `${mediaKind}_prompt_approved`,
    brief: state.original_brief || "",
    approved_result: prompt,
    prompt,
    content: state.content?.approvedContent || "",
    product_name: state.content?.productName || "",
    media_type: mediaKind,
    global_guidelines: state.global_guidelines || [],
  });
}

function normalizeMediaPathForDirective(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/([A-Za-z]:\\Users\\Administrator)\.openclaw(?=\\|$)/gi, "$1\\.openclaw")
    .replace(/([A-Za-z]:\/Users\/Administrator)\.openclaw(?=\/|$)/gi, "$1/.openclaw")
    .replace(/\\/g, "/");
}

function buildMediaDirective(filePath) {
  const normalized = normalizeMediaPathForDirective(filePath);
  return normalized ? `MEDIA: "${normalized}"` : "";
}

function copyReviewMediaAttachment(paths, sourcePath, workflowId, label = "media") {
  const source = mediaAgent.normalizeAgentReportedPath(sourcePath);
  if (!source) return "";
  try {
    const resolvedSource = path.resolve(source);
    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
      return source;
    }
    const safeWorkflowId = String(workflowId || "workflow").replace(/[^A-Za-z0-9._-]/g, "_");
    const safeLabel = String(label || "media").replace(/[^A-Za-z0-9._-]/g, "_");
    const ext = path.extname(resolvedSource) || ".png";
    const baseDir = paths?.baseDir || (paths?.currentFile ? path.dirname(paths.currentFile) : "");
    if (!baseDir) return source;
    const targetDir = path.join(baseDir, "review-assets", safeWorkflowId);
    ensureDir(targetDir);
    const targetPath = path.join(targetDir, `${safeLabel}${ext}`);
    if (path.resolve(targetPath) !== resolvedSource) {
      fs.copyFileSync(resolvedSource, targetPath);
    }
    return targetPath;
  } catch {
    return source;
  }
}

function enrichContentReviewMedia(paths, workflowId, content) {
  if (!content) return content;
  const primaryProductReviewImage = copyReviewMediaAttachment(
    paths,
    content.primaryProductImage,
    workflowId,
    "primary-product",
  );
  return {
    ...content,
    primaryProductReviewImage: primaryProductReviewImage || content.primaryProductImage || "",
  };
}

function getContentReviewImage(content) {
  return String(content?.primaryProductReviewImage || content?.primaryProductImage || "").trim();
}

function buildVideoChatPayload(videoPath) {
  const normalized = normalizeMediaPathForDirective(videoPath);
  if (!normalized) {
    return { data: {}, artifacts: [] };
  }
  return {
    data: {
      relative_video_path: normalized,
      absolute_video_path: normalized,
      video_path: normalized,
      reply_mode: "show_video_in_chat",
    },
    artifacts: [
      { type: "generated_video", path: normalized },
      { type: "chat_video", path: normalized },
    ],
  };
}

function summarizeReferenceUsage(media) {
  const logoCount = Array.isArray(media?.usedLogoPaths)
    ? media.usedLogoPaths.filter(Boolean).length
    : 0;
  return [
    media?.usedProductImage ? "Đã dùng ảnh gốc sản phẩm làm tham chiếu." : "",
    logoCount > 0 ? `Đã dùng ${logoCount} logo công ty.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveWorkflowLogoPaths(context) {
  if (context?.options?.noCompanyLogo || process.env.OPENCLAW_NO_COMPANY_LOGO === "1") {
    return [];
  }
  return mediaAgent.resolveLogoAssetPaths(context.openClawHome);
}

function normalizePublishedSummaryText(message) {
  return String(message || "")
    .replaceAll("📤 Bài viết đã được đăng thành công lên Fanpage!")
    .replaceAll("không có", "không có");
}

function normalizePublishedSummaryText(message) {
  return String(message || "")
    .replaceAll("📤 Bài viết đã được đăng thành công lên Fanpage!")
    .replaceAll("không có", "không có")
    .replaceAll("không có", "không có");
}

function buildPublishSuccessSummary(action, canonicalResult, scheduleTime = "") {
  const postIds = canonicalResult.postIds || [];
  const postId = canonicalResult.postId || "";
  return [
    action === "schedule"
      ? "Bài viết đã được hẹn giờ đăng thành công."
      : "Bài viết đã được đăng thành công lên Fanpage.",
    scheduleTime ? `Thời gian: ${scheduleTime}` : "",
    canonicalResult.pageIds?.length > 0 ? `ID page: ${canonicalResult.pageIds.join(", ")}` : "",
    postIds.length > 1
      ? `ID bài viết: ${postIds.join(", ")}`
      : postId
        ? `ID bài viết: ${postId}`
        : "",
    canonicalResult.permalink ? `Đường dẫn bài viết: ${canonicalResult.permalink}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFrontendApprovalMessage(params) {
  const reviewImage = params.primaryProductReviewImage || params.primaryProductImage;
  const lines = [
    params.revised
      ? "NV Content đã sửa lại bài theo nhận xét, đang chờ Sếp duyệt lại."
      : "NV Content đã viết xong bài nháp, đang chờ Sếp duyệt.",
    params.productName ? `Sản phẩm: ${params.productName}` : "",
    "----- NỘI DUNG CHỜ DUYỆT -----",
    params.approvedContent || "",
    "------------------------------",
    'Sếp muốn duyệt? Nói: "Duyệt content, tạo ảnh"',
    'Muốn sửa? Ghi rõ nhận xét, ví dụ: "Sửa content, thêm giá"',
    reviewImage ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
    buildMediaDirective(reviewImage),
  ];

  return lines.filter(Boolean).join("\n");
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function buildPaths(workspaceDir, managerInstanceId = null) {
  const managerSegment = sanitizePathSegment(managerInstanceId);
  const baseDir = managerSegment
    ? path.join(workspaceDir, "agent-orchestrator-test", "managers", managerSegment)
    : path.join(workspaceDir, "agent-orchestrator-test");
  const historyDir = path.join(baseDir, "history");
  const currentFile = path.join(baseDir, "current-workflow.json");
  ensureDir(baseDir);
  ensureDir(historyDir);
  return { baseDir, historyDir, currentFile, managerInstanceId: managerSegment || null };
}

// â�?€â�?€â�?€ Result Builders â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

function buildResult(params) {
  return {
    workflow_id: params.workflowId || null,
    stage: params.stage || null,
    status: params.status || "ok",
    summary: params.summary || "",
    human_message: params.humanMessage || params.summary || "",
    data: params.data || {},
    artifacts: Array.isArray(params.artifacts) ? params.artifacts : [],
  };
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // Human-readable mode: chá»‰ in summary
  console.log(result.human_message || result.summary || JSON.stringify(result, null, 2));
}

// â�?€â�?€â�?€ Workflow State Management â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

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

function hasWorkflowStageNotification(state, stage) {
  return Boolean(state?.notifications?.[stage]);
}

function markWorkflowStageNotified(paths, workflowId, stage, delivery = "sync") {
  const current = readJsonIfExists(paths.currentFile, null);
  if (!current || current.workflow_id !== workflowId || current.stage !== stage) {
    return current;
  }
  return saveWorkflow(paths, {
    ...current,
    notifications: {
      ...(current.notifications || {}),
      [stage]: {
        at: nowIso(),
        delivery,
      },
    },
  });
}

/**
 * Migrate state cÅ© náº¿u thiáº¿u trÆ°á»�?ng má»›i.
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
  if (!Array.isArray(state.global_guidelines)) {
    state.global_guidelines = [];
  }
  if (state.media?.generatedImagePath) {
    const referencePaths = [
      state.media.usedProductImage,
      ...(Array.isArray(state.media.usedLogoPaths) ? state.media.usedLogoPaths : []),
    ].filter(Boolean);
    const sanitizedImagePath = sanitizeImageMediaPath(state.media.generatedImagePath, referencePaths);
    if (!sanitizedImagePath) {
      state.media = {
        ...(state.media || {}),
        generatedImagePath: "",
      };
      if (state.stage === "awaiting_media_approval" && !sanitizeVideoMediaPath(state.media.generatedVideoPath)) {
        state.stage = "awaiting_content_approval";
        state.last_error =
          state.last_error ||
          "Media image output is missing or invalid; rerun the media generation step.";
        if (state.notifications?.awaiting_media_approval) {
          state.notifications = { ...(state.notifications || {}) };
          delete state.notifications.awaiting_media_approval;
        }
      }
    } else if (sanitizedImagePath !== state.media.generatedImagePath) {
      state.media = {
        ...(state.media || {}),
        generatedImagePath: sanitizedImagePath,
      };
    }
  }
  if (state.media?.generatedVideoPath) {
    const sanitizedVideoPath = sanitizeVideoMediaPath(state.media.generatedVideoPath);
    if (!sanitizedVideoPath) {
      state.media = {
        ...(state.media || {}),
        generatedVideoPath: "",
      };
      if (state.stage === "awaiting_video_approval") {
        state.stage = "awaiting_publish_decision";
        if (state.notifications?.awaiting_video_approval) {
          state.notifications = { ...(state.notifications || {}) };
          delete state.notifications.awaiting_video_approval;
        }
      }
    }
  }
  return state;
}

// â�?€â�?€â�?€ Reply Validation â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

function validateCommonReply(reply, workflowId, stepId) {
  const text = String(reply || "").trim();
  if (!text) throw new Error("Agent reply is empty.");

  // Soft validation â€�? chá»‰ warn náº¿u thiáº¿u token, khÃ´ng crash.
  // Agent LLM cÃ³ thá»ƒ viáº¿t hÆ¡i khÃ¡c (thÃªm dáº¥u, space, format) nhÆ°ng ná»™i dung Ä‘Ãºng.
  const requiredTokens = ["WORKFLOW_META", "TRANG_THAI", "KET_QUA"];
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      logger.log("warn", ` Agent reply thiếu token "${token}" ấn�? tiếp tục xử lý.`);
    }
  }
  return text;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkflowScopedSessionKey(agentId, workflowId, stepId = "lane") {
  const safeAgentId = String(agentId || "").trim() || "unknown";
  const safeWorkflowId = String(workflowId || "").trim() || `wf_runtime_${Date.now()}`;
  const safeStepId = String(stepId || "").trim() || "lane";
  return `agent:${safeAgentId}:automation:${safeWorkflowId}:${safeStepId}`;
}


function isWorkflowScopedSessionKey(sessionKey, agentId, workflowId) {
  const value = String(sessionKey || "").trim();
  const safeAgentId = String(agentId || "").trim();
  const safeWorkflowId = String(workflowId || "").trim();
  if (!value || !safeAgentId || !safeWorkflowId) {
    return false;
  }
  return value.startsWith(`agent:${safeAgentId}:automation:${safeWorkflowId}:`);
}

function resolveWorkflowScopedSessionKey(params) {
  const provided = String(params.sessionKey || "").trim();
  if (isWorkflowScopedSessionKey(provided, params.agentId, params.workflowId)) {
    return provided;
  }
  return buildWorkflowScopedSessionKey(params.agentId, params.workflowId, params.stepId);

}

async function resolveRootWorkflowBinding(context) {
  const managerId = String(context?.options?.from || "pho_phong").trim() || "pho_phong";
  const explicitManagerInstanceId = String(context?.options?.managerInstanceId || "").trim() || null;
  const brief = normalizeText(context?.message || "");
  const fallbackWorkflowId = `wf_test_${randomUUID()}`;

  try {
    const resolved = await beClient.resolveAutomationRootConversation({
      agentId: managerId,
      employeeId: managerId,
      brief,
      sessionKey: context?.registry?.byId?.pho_phong?.transport?.sessionKey || null,

      rootConversationId: context?.rootConversationId || context?.parentConversationId || null,

    });

    const workflowId =
      String(resolved?.workflowId || resolved?.rootConversation?.workflowId || "").trim() ||
      fallbackWorkflowId;
    const rootConversationId =
      String(resolved?.rootConversationId || resolved?.rootConversation?.id || "").trim() || null;
    const rootSessionKey =
      String(resolved?.sessionKey || resolved?.rootConversation?.sessionKey || "").trim() || null;
    const managerInstanceId =
      String(
        resolved?.managerInstanceId ||
          resolved?.rootConversation?.managerInstanceId ||
          explicitManagerInstanceId ||
          "",
      ).trim() || null;

    if (rootConversationId) {
      logger.log(
        "info",
        `[workflow-binding] adopted root=${rootConversationId} workflow=${workflowId} for ${managerId}`,
      );
      return {
        workflowId,
        rootConversationId,
        rootSessionKey,
        managerInstanceId,
        adoptedExistingRoot: true,
      };
    }
  } catch (err) {
    logger.logError(
      "beClient",
      `Khong resolve duoc automation root conversation: ${err.message || err}`,
    );
  }

  logger.log(
    "info",
    `[workflow-binding] fallback workflow=${fallbackWorkflowId} for ${managerId} (khong tim thay root automation tu backend)`,
  );
  return {
    workflowId: fallbackWorkflowId,
    rootConversationId: null,
    rootSessionKey: null,
    managerInstanceId: explicitManagerInstanceId,
    adoptedExistingRoot: false,
  };
}

async function resolveWorkflowSessionContext(params) {

  let actualSessionKey = resolveWorkflowScopedSessionKey(params);

  let subConv = null;

  try {
    subConv = await beClient.createSubAgentConversation({
      workflowId: params.workflowId,
      taskId,
      stepId: params.stepId,
      managerInstanceId: params.managerInstanceId || null,
      agentId: params.agentId,

      employeeId: params.employeeId || undefined,

      parentConversationId: params.rootConversationId || null,
      title: `[AUTO] ${params.agentId} • ${params.stepId}`,
    });
    if (subConv?.sessionKey) {
      actualSessionKey = subConv.sessionKey;
    }
  } catch (err) {
    logger.logError(
      "beClient",
      `Loi tao sub-agent conversation DB, fallback session workflow-scoped: ${err.message}`,
    );
  }

  return {
    sessionKey: actualSessionKey,
    subConv,
    taskId,
  };
}

function buildContentApprovalCheckpointMessage(params) {
  // Root/manager conversation should show the review-ready approval summary.
  // Keep the raw child checkpoint only for explicit debug/tracing flows.
  if (!params?.includeRawCheckpoint) {
    return buildFrontendApprovalMessage(params);
  }

  const intro = params.revised
    ? "NV Content đã sửa lại bài theo nhận xét. �?ang ch�? phó phòng duyệt lại."
    : "NV Content đã hoàn tất content. �?ang ch�? phó phòng duyệt.";
  const rawReply = String(params.rawReply || "").trim();
  if (!rawReply) {
    return buildFrontendApprovalMessage(params);
  }
  return [intro, "", "CHECKPOINT_GOC_TU_NV_CONTENT:", rawReply].join("\n");
}

function validateContentCheckpointReply(params) {
  const rawReply = String(params.reply || "").trim();
  if (!rawReply) {
    return { ok: false, reason: "empty reply", content: null, reply: "", warnings: [] };
  }

  const correlation = transport.correlateByWorkflowIdAndStepId({
    workflowId: params.workflowId,
    stepId: params.stepId,
    text: rawReply,
  });
  if (!correlation.ok) {
    return {
      ok: false,
      reason: correlation.reason || "workflow_id mismatch",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings: [],
    };
  }

  const warnings = [];
  if (correlation.reason === "preamble_before_workflow_meta") {
    warnings.push("content reply co preamble truoc WORKFLOW_META");
  }

  let parsed;
  try {
    parsed = contentAgent.parseContentResult(correlation.matchedText || rawReply);
  } catch (error) {
    const message = String(error?.message || error || "");
    return {
      ok: false,
      reason: message.includes("APPROVED_CONTENT")
        ? "missing APPROVED_CONTENT_BEGIN/END"
        : message || "content checkpoint parse failed",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings,
    };
  }

  if (!parsed.productName) {
    return {
      ok: false,
      reason: "missing PRODUCT_NAME",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings,
    };
  }
  if (!parsed.productUrl) {
    return {
      ok: false,
      reason: "missing PRODUCT_URL",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings,
    };
  }
  if (!parsed.primaryProductImage) {
    return {
      ok: false,
      reason: "missing PRIMARY_PRODUCT_IMAGE",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings,
    };
  }
  if (!parsed.approvedContent) {
    return {
      ok: false,
      reason: "missing APPROVED_CONTENT_BEGIN/END",
      content: null,
      reply: correlation.matchedText || rawReply,
      warnings,
    };
  }

  return {
    ok: true,
    reason: null,
    content: parsed,
    reply: correlation.matchedText || rawReply,
    warnings,
  };
}

function logCheckpointValidation(agentId, workflowId, stepId, validation, sessionKey) {
  if (validation.ok) {
    for (const warning of validation.warnings || []) {
      logger.log(
        "warn",
        `[checkpoint-warning] agent=${agentId} workflow=${workflowId} step=${stepId} session=${sessionKey} ${warning}`,
      );
    }
    return;
  }

  logger.log(
    "warn",
    `[checkpoint-reject] agent=${agentId} workflow=${workflowId} step=${stepId} session=${sessionKey} reason=${validation.reason}`,
  );
}

async function waitForValidContentCheckpoint(params) {
  let validation = validateContentCheckpointReply({
    reply: params.initialReply,
    workflowId: params.workflowId,
    stepId: params.stepId,
  });
  logCheckpointValidation(
    params.agentId,
    params.workflowId,
    params.stepId,
    validation,
    params.sessionKey,
  );
  if (validation.ok) {
    return validation;
  }

  const waitBudgetMs = Number.isFinite(Number(params.validationTimeoutMs))
    ? Number(params.validationTimeoutMs)
    : Number.isFinite(Number(params.timeoutMs))
      ? Number(params.timeoutMs)
      : Number(params.graceMs) || 20000;
  const maxWaitMs =
    Number.isFinite(Number(params.validationTimeoutMs)) || Number.isFinite(Number(params.timeoutMs))
      ? Math.min(Math.max(waitBudgetMs, 3000), MAX_AUTO_NOTIFY_TIMEOUT_MS)
      : Math.min(Math.max(waitBudgetMs, 3000), 60000);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await waitMs(3000);
    const historyReply = await transport.findLatestWorkflowReplyInHistory({
      openClawHome: params.openClawHome,
      sessionKey: params.sessionKey,
      workflowId: params.workflowId,
      stepId: params.stepId,
      timeoutMs: 20000,
      limit: 60,
    });
    if (!historyReply) {
      continue;
    }
    validation = validateContentCheckpointReply({
      reply: historyReply,
      workflowId: params.workflowId,
      stepId: params.stepId,
    });
    logCheckpointValidation(
      params.agentId,
      params.workflowId,
      params.stepId,
      validation,
      params.sessionKey,
    );
    if (validation.ok) {
      return validation;
    }
  }

  throw new Error(
    `${params.agentId} chua tra ve checkpoint duyet content hop le. Ly do cuoi: ${validation.reason || "unknown"}.`,
  );
}

// â�?€â�?€â�?€ Agent Communication â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

function buildSubAgentRuntimeMessageId(params, suffix) {
  const safeAgent = String(params.agentId || "agent").replace(/[^A-Za-z0-9._-]/g, "_");
  const safeWorkflow = String(params.workflowId || "workflow").replace(/[^A-Za-z0-9._-]/g, "_");
  const safeStep = String(params.stepId || "step").replace(/[^A-Za-z0-9._-]/g, "_");
  const safeSuffix = String(suffix || "message").replace(/[^A-Za-z0-9._-]/g, "_");
  return `msg_${safeWorkflow}_${safeStep}_${safeAgent}_${safeSuffix}`;
}

async function persistSubAgentRuntimeMessage(params) {
  if (!params?.subConv?.id || !String(params.content || "").trim()) {
    return;
  }
  try {
    await beClient.persistMessages([
      {
        id: params.id,
        conversationId: params.subConv.id,
        role: params.role,
        type: params.type || "regular",
        content: params.content,
        timestamp: params.timestamp || Date.now(),
        final: params.final !== false,
      },
    ]);
  } catch (err) {
    logger.logError("beClient", "Loi dong bo transcript nhan vien DB: " + (err.message || err));
  }
}

function startSubAgentRuntimeMirror(params) {
  if (!params?.subConv?.id || !params.sessionKey) {
    return () => {};
  }

  let stopped = false;
  let lastText = "";
  let timer = null;

  const poll = async () => {
    if (stopped) return;
    const text = await transport.findLatestAssistantTextInHistory({
      openClawHome: params.openClawHome,
      sessionKey: params.sessionKey,
      timeoutMs: 12000,
      limit: 12,
    });
    if (!stopped && text && text !== lastText) {
      lastText = text;
      await persistSubAgentRuntimeMessage({
        subConv: params.subConv,
        id: params.replyMessageId,
        role: "assistant",
        content: text,
        final: false,
        timestamp: Date.now(),
      });
    }
    if (!stopped) {
      timer = setTimeout(poll, 4000);
    }
  };

  timer = setTimeout(poll, 2500);
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function runAgentStepDetailed(params) {

  const { sessionKey: actualSessionKey, subConv } = await resolveWorkflowSessionContext(params);
  const promptMessageId = buildSubAgentRuntimeMessageId(params, "prompt");
  const replyMessageId = buildSubAgentRuntimeMessageId(params, "reply");
  if (subConv) {
    await persistSubAgentRuntimeMessage({
      subConv,
      id: promptMessageId,
      role: "user",
      content: params.prompt,
      final: true,
      timestamp: Date.now(),
    });
  }

  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    workerAgentId: params.workerAgentId || params.agentId,
    managerInstanceId: params.managerInstanceId || null,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    taskId,
    timeoutMs: params.timeoutMs,
  });
  if (typeof params.onTaskStarted === "function") {
    try {
      params.onTaskStarted({ sessionKey: actualSessionKey, subConv, task });
    } catch (error) {
      logger.logError("workflow_watcher", error);
    }
  }
  const stopRuntimeMirror = startSubAgentRuntimeMirror({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    subConv,
    replyMessageId,
  });
  let response;
  try {
    response = await transport.waitForAgentResponse(task);
  } finally {
    stopRuntimeMirror();
  }
  const finalReply = validateCommonReply(response.text, params.workflowId, params.stepId);

  if (subConv) {

    await persistSubAgentRuntimeMessage({
      subConv,
      id: replyMessageId,
      role: "assistant",
      content: finalReply,
      final: true,
      timestamp: Date.now(),
    });

  }


  return {
    reply: finalReply,
    sessionKey: actualSessionKey,
    subConv,
    taskId,
  };
}

async function runAgentStep(params) {

  let actualSessionKey = resolveWorkflowScopedSessionKey(params);

  let subConv;

  try {
    // 1. Táº¡o/Reuse conversation qua BE Ä‘á»ƒ láº¥y sessionKey chuáº©n (cÃ´ láº­p tiáº¿n trÃ¬nh)
    subConv = await beClient.createSubAgentConversation({
      workflowId: params.workflowId,
      taskId,
      stepId: params.stepId,
      managerInstanceId: params.managerInstanceId || null,
      agentId: params.agentId,
      workerAgentId: params.workerAgentId || params.agentId,
      parentConversationId: params.rootConversationId || null,
      title: `[AUTO] ${params.agentId} - ${params.stepId}`,
    });
    if (subConv && subConv.sessionKey) {
      actualSessionKey = subConv.sessionKey;
    }
  } catch (err) {
    logger.logError("beClient", "Lỗi tạo sub-agent conversation DB: " + err.message);
  }

  const promptMessageId = buildSubAgentRuntimeMessageId(params, "prompt");
  const replyMessageId = buildSubAgentRuntimeMessageId(params, "reply");
  if (subConv) {
    await persistSubAgentRuntimeMessage({
      subConv,
      id: promptMessageId,
      role: "user",
      content: params.prompt,
      final: true,
      timestamp: Date.now(),
    });
  }

  // 2. Gá»i cho Gateway bÃ¬nh thÆ°á» ng
  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    workerAgentId: params.workerAgentId || params.agentId,
    managerInstanceId: params.managerInstanceId || null,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    taskId,
    timeoutMs: params.timeoutMs,
  });
  const stopRuntimeMirror = startSubAgentRuntimeMirror({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    subConv,
    replyMessageId,
  });
  let response;
  try {
    response = await transport.waitForAgentResponse(task);
  } finally {
    stopRuntimeMirror();
  }
  const finalReply = validateCommonReply(response.text, params.workflowId, params.stepId);

  // 3. Persist final reply; prompt was already persisted before dispatch.
  if (subConv) {
    await persistSubAgentRuntimeMessage({
      subConv,
      id: replyMessageId,
      role: "assistant",
      content: finalReply,
      final: true,
      timestamp: Date.now(),
    });
  }


  return finalReply;
}

async function runContentCheckpointStep(params) {
  const result = await runAgentStepDetailed(params);
  const validation = await waitForValidContentCheckpoint({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    workflowId: params.workflowId,
    stepId: params.stepId,
    sessionKey: result.sessionKey,
    initialReply: result.reply,
    graceMs: params.graceMs,
    validationTimeoutMs: params.validationTimeoutMs || params.timeoutMs,
  });

  if (result.subConv && validation.reply && validation.reply !== result.reply) {
    try {
      const now = Date.now();
      await beClient.persistMessages([
        {

          id: `msg_${now}_${params.stepId}_validated_checkpoint`,
          conversationId: result.subConv.id,

          role: "assistant",
          content: validation.reply,
          timestamp: now,
        },
      ]);
    } catch (err) {
      logger.logError("beClient", "Loi luu checkpoint hop le cua NV Content DB: " + err.message);
    }
  }

  return {
    reply: validation.reply,
    content: {
      ...validation.content,
      reply: validation.reply,
    },
    sessionKey: result.sessionKey,
  };
}

async function recoverContentCheckpointFromHistory(params) {
  const result = await resolveWorkflowSessionContext(params);
  const historyReply = await transport.findLatestWorkflowReplyInHistory({
    openClawHome: params.openClawHome,
    sessionKey: result.sessionKey,
    workflowId: params.workflowId,
    stepId: params.stepId,
    timeoutMs: params.historyTimeoutMs || 20000,
    limit: params.historyLimit || 80,
  });
  if (!historyReply) {
    return null;
  }

  const validation = validateContentCheckpointReply({
    reply: historyReply,
    workflowId: params.workflowId,
    stepId: params.stepId,
  });
  logCheckpointValidation(
    params.agentId,
    params.workflowId,
    params.stepId,
    validation,
    result.sessionKey,
  );
  if (!validation.ok) {
    return null;
  }

  if (result.subConv) {
    try {
      await beClient.persistMessages([
        {
          id: `msg_${params.workflowId}_${params.stepId}_recovered_checkpoint`,
          conversationId: result.subConv.id,
          role: "assistant",
          content: validation.reply,
          timestamp: Date.now(),
        },
      ]);
    } catch (err) {
      logger.logError("beClient", "Loi luu checkpoint content recover DB: " + err.message);
    }
  }

  return {
    reply: validation.reply,
    content: {
      ...validation.content,
      reply: validation.reply,
    },
    sessionKey: result.sessionKey,
    recovered: true,
  };
}

async function syncApprovalCheckpoint(params) {
  const managerId = params.managerId || "pho_phong";
  const timestamp = Date.now();
  let delivered = false;

  try {
    await beClient.updateWorkflowStatus(
      params.workflowId,
      params.stage || "awaiting_content_approval",
    );
  } catch (err) {
    logger.logError("beClient", "Loi dong bo workflow status: " + err.message);
  }

  try {
    await beClient.pushAutomationEvent({
      workflowId: params.workflowId,
      taskId: params.taskId || buildWorkflowTaskId(params.workflowId, params.stage || "approval"),
      stepId: params.stepId || params.stage || "approval",
      managerInstanceId: params.managerInstanceId || null,
      employeeId: managerId,
      agentId: managerId,
      workerAgentId: params.workerAgentId || managerId,
      conversationId: params.rootConversationId || null,
      title: params.title || `[AUTO] ${managerId} • ${params.workflowId}`,
      role: "assistant",
      type: "approval_request",
      content: params.content,
      timestamp,
      status: params.stage || "awaiting_content_approval",
      conversationRole: "root",
      injectToGateway: false,
      eventId:
        params.eventId ||
        `${params.workflowId}:${params.stage || "awaiting_content_approval"}:approval`,
    });
    delivered = true;
  } catch (err) {
    logger.logError("beClient", "Loi day approval message ve FE: " + err.message);
  }

  if (delivered && params.paths && params.workflowId && params.stage) {
    markWorkflowStageNotified(params.paths, params.workflowId, params.stage, "sync");
  }

  return delivered;
}

async function syncRootConversationMessage(params) {
  const managerId = params.managerId || "pho_phong";
  const workflowId = String(params.workflowId || "").trim();
  const content = String(params.content || "").trim();
  if (!workflowId || !content) {
    return false;
  }

  const timestamp = Date.now();
  let delivered = false;

  try {
    await beClient.updateWorkflowStatus(params.workflowId, params.stage || "active");
  } catch (err) {
    logger.logError("beClient", "Loi dong bo workflow status: " + err.message);
  }

  try {
    await beClient.pushAutomationEvent({
      workflowId,
      taskId: params.taskId || buildWorkflowTaskId(workflowId, params.stage || "root"),
      stepId: params.stepId || params.stage || "root",
      managerInstanceId: params.managerInstanceId || null,
      employeeId: managerId,
      agentId: managerId,
      workerAgentId: params.workerAgentId || managerId,
      conversationId: params.rootConversationId || null,
      title: params.title || `[AUTO] ${managerId} • ${workflowId}`,
      role: "assistant",
      type: params.type || "regular",
      content,
      timestamp,
      status: params.conversationStatus || params.stage || "active",
      conversationRole: "root",
      sessionKey: params.sessionKey || null,
      injectToGateway: params.injectToGateway === true,
      eventId:
        params.eventId || `${workflowId}:${params.stage || "active"}:${params.type || "regular"}`,
    });
    delivered = true;
  } catch (err) {
    logger.logError("beClient", "Loi day root message ve FE: " + err.message);
  }

  return delivered;
}

function readWorkflowStateForSync(paths, workflowId) {
  const current = readJsonIfExists(paths?.currentFile, null);
  if (current?.workflow_id === workflowId) {
    return migrateState(current);
  }
  if (!workflowId || !paths?.historyDir) {
    return null;
  }
  return migrateState(readJsonIfExists(path.join(paths.historyDir, `${workflowId}.json`), null));
}

function isRootSyncableErrorStatus(status) {
  return ["error", "failed", "blocked"].includes(String(status || "").trim().toLowerCase());
}

function buildRootSyncPayloadFromResult(context, result) {
  const workflowId = String(result?.workflow_id || result?.workflowId || "").trim();
  const stage = String(result?.stage || "").trim();
  const status = String(result?.status || "ok")
    .trim()
    .toLowerCase();
  if (!workflowId || !stage) {
    return null;
  }

  // Do not persist transient blocked/running placeholders as real manager checkpoints.
  const isErrorStatus = isRootSyncableErrorStatus(status);
  if (stage.startsWith("awaiting_") && status !== "ok" && !isErrorStatus) {
    return null;
  }

  const stageSpecs = {
    awaiting_media_approval: {
      type: "approval_request",
      eventId: `${workflowId}:awaiting_media_approval:checkpoint`,
    },
    awaiting_video_approval: {
      type: "approval_request",
      eventId: `${workflowId}:awaiting_video_approval:checkpoint`,
    },
    awaiting_publish_decision: {
      type: "approval_request",
      eventId: `${workflowId}:awaiting_publish_decision:checkpoint`,
    },
    published: {
      type: "regular",
      eventId: `${workflowId}:published:result`,
    },
    scheduled: {
      type: "regular",
      eventId: `${workflowId}:scheduled:result`,
    },
  };

  const stageSpec = isErrorStatus
    ? {
        type: "regular",
        eventId: `${workflowId}:${stage}:error`,
        conversationStatus: "error",
      }
    : stageSpecs[stage];
  if (!stageSpec) {
    return null;
  }

  const workflowState = readWorkflowStateForSync(context.paths, workflowId);
  const content = String(
    result?.human_message || result?.summary || buildStageHumanMessage(workflowState) || "",
  ).trim();
  if (!content) {
    return null;
  }

  return {
    workflowId,
    stage,
    type: stageSpec.type,
    eventId: stageSpec.eventId,
    conversationStatus: stageSpec.conversationStatus || stage,
    content,
    rootConversationId: workflowState?.rootConversationId || context.parentConversationId || null,
    ...(
      workflowState?.managerInstanceId || context.managerInstanceId
        ? { managerInstanceId: workflowState?.managerInstanceId || context.managerInstanceId }
        : {}
    ),
  };
}

async function syncRootMessageFromResult(context, result) {
  const payload = buildRootSyncPayloadFromResult(context, result);
  if (!payload) {
    return false;
  }
  const delivered = await syncRootConversationMessage({
    ...payload,
    managerInstanceId: payload.managerInstanceId || context.managerInstanceId || null,
    managerId: context.options?.from || "pho_phong",
    title: `[AUTO] ${context.options?.from || "pho_phong"} • ${payload.workflowId}`,
  });
  if (delivered && payload.type === "approval_request") {
    markWorkflowStageNotified(context.paths, payload.workflowId, payload.stage, "sync");
  }
  return delivered;
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
  const hasQuotedProduct = /["â€œâ€�?].+["â€œâ€�?]/.test(raw);
  const longEnough = normalized.length >= 40;
  const hasStructuredBrief = raw.includes("\n") || raw.includes(":");
  const hasStructuredBriefWithStrongSignals = hasStructuredBrief && strongSignalCount >= 1;

  return (
    longEnough &&
    (strongSignalCount >= 2 ||
      (hasQuotedProduct && strongSignalCount >= 1) ||
      hasStructuredBriefWithStrongSignals)
  );
}

function shouldSupersedePendingWorkflow(message, state, parsedIntent) {
  if (!state) {
    return false;
  }

  if (isExplicitWorkflowResetMessage(message)) {
    return true;
  }

  const freshBrief = looksLikeFreshWorkflowBrief(message, parsedIntent);
  const pendingDecision = intentParser.classifyPendingDecision(message, state.stage);

  if (pendingDecision !== "unknown" && !freshBrief) {
    return false;
  }

  if (freshBrief) {
    return true;
  }

  return false;
}

function collectMediaPaths(media) {
  const result = [];
  if (media?.generatedImagePath) result.push(media.generatedImagePath);
  if (media?.generatedVideoPath) result.push(media.generatedVideoPath);
  return result;
}

function normalizeMediaPathForCompare(value) {
  const normalized = mediaAgent.normalizeAgentReportedPath(value);
  if (!normalized) return "";
  try {
    return path.resolve(normalized).replace(/\\/g, "/").toLowerCase();
  } catch {
    return normalized.replace(/\\/g, "/").toLowerCase();
  }
}

function computeExistingFileHash(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return "";
    return require("crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

function buildBlockedMediaArtifactSet(pathsToBlock = []) {
  const normalizedPaths = new Set();
  const hashes = new Set();
  for (const item of pathsToBlock || []) {
    const normalized = normalizeMediaPathForCompare(item);
    if (normalized) normalizedPaths.add(normalized);
    const hash = computeExistingFileHash(item);
    if (hash) hashes.add(hash);
  }
  return { normalizedPaths, hashes };
}

function isUsableRecoveredArtifact(filePath, options = {}) {
  const normalized = normalizeMediaPathForCompare(filePath);
  if (!normalized) return false;
  const blocked = options.blocked || buildBlockedMediaArtifactSet(options.blockedPaths || []);
  if (blocked.normalizedPaths.has(normalized)) return false;

  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    const sinceMs = options.startedAtIso ? new Date(options.startedAtIso).getTime() : 0;
    if (Number.isFinite(sinceMs) && sinceMs > 0 && stats.mtimeMs < sinceMs) return false;
  } catch {
    return false;
  }

  if (mediaAgent.isReferenceGeneratedImagePath(filePath, options.referencePaths || [])) return false;
  const hash = computeExistingFileHash(filePath);
  if (hash && blocked.hashes.has(hash)) return false;
  return true;
}

function routeExpectsImage(route) {
  return mediaAgent.routeMediaType(route || "image").effectiveType !== "video";
}

function routeExpectsVideo(route) {
  return mediaAgent.routeMediaType(route || "image").effectiveType !== "image";
}

function normalizeIncomingMediaForAsyncStage(incomingMedia, state, spec) {
  if (!incomingMedia) return null;
  const referencePaths = [
    state.content?.primaryProductImage,
    state.media?.usedProductImage,
    ...(state.media?.usedLogoPaths || []),
  ].filter(Boolean);
  const blocked = buildBlockedMediaArtifactSet([
    ...collectMediaPaths(state.media),
    state.generating_bg_image_path,
    state.revising_bg_image_path,
    ...referencePaths,
  ]);
  const normalized = { ...incomingMedia };

  if (normalized.generatedImagePath) {
    normalized.generatedImagePath = isUsableRecoveredArtifact(normalized.generatedImagePath, {
      startedAtIso: spec.startedAt,
      referencePaths,
      blocked,
    })
      ? normalized.generatedImagePath
      : "";
  }
  if (normalized.generatedVideoPath) {
    normalized.generatedVideoPath = isUsableRecoveredArtifact(normalized.generatedVideoPath, {
      startedAtIso: spec.startedAt,
      referencePaths,
      blocked,
    })
      ? normalized.generatedVideoPath
      : "";
  }

  if (spec.kind === "video") {
    return normalized.generatedVideoPath ? normalized : null;
  }
  if (routeExpectsImage(spec.route) && !normalized.generatedImagePath) return null;
  if (routeExpectsVideo(spec.route) && !normalized.generatedVideoPath) return null;
  return collectMediaPaths(normalized).length > 0 ? normalized : null;
}

function buildPromptPreview(promptPackage) {
  const shortenPrompt = (value, maxLength = 420) => {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return "";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength).trimEnd()}...`;
  };

  const parts = [];
  if (promptPackage?.imagePrompt) {
    parts.push("PROMPT ANH DA DUNG:");
    parts.push(shortenPrompt(promptPackage.imagePrompt));
  }
  if (promptPackage?.videoPrompt) {
    if (parts.length > 0) parts.push("");
    parts.push("PROMPT VIDEO DA DUNG:");
    parts.push(shortenPrompt(promptPackage.videoPrompt));
  }
  return parts.join("\n");
}

function compactMediaFailureReply(reply) {
  let text = String(reply || "").trim();
  if (!text) return "";

  const shortenBlock = (value, maxLength = 900) => {
    const normalized = String(value || "").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength).trimEnd()}\n...`;
  };

  for (const [startMarker, endMarker] of [
    ["IMAGE_PROMPT_BEGIN", "IMAGE_PROMPT_END"],
    ["VIDEO_PROMPT_BEGIN", "VIDEO_PROMPT_END"],
  ]) {
    const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, "g");
    text = text.replace(pattern, (block) => {
      const inner = block
        .slice(startMarker.length, block.length - endMarker.length)
        .trim();
      return `${startMarker}\n${shortenBlock(inner)}\n${endMarker}`;
    });
  }

  return shortenBlock(text, 3200);
}

function buildMediaParseFailureSummary(params) {
  const { reply, error, title, retryHint } = params;
  const compactReply = compactMediaFailureReply(reply);
  return [
    title,
    `Lỗi đọc kết quả: ${error?.message || String(error || "không rõ lỗi")}`,
    compactReply ? "Thông tin thật từ NV Media:" : "",
    compactReply,
    "",
    retryHint,
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeUniquePaths(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function sanitizeVideoMediaPath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return videoAgent.isPlaceholderGeneratedPath(normalized) ? "" : normalized;
}

function sanitizeImageMediaPath(value, referencePaths = []) {
  const normalized = mediaAgent.normalizeAgentReportedPath(value);
  if (!normalized) return "";
  if (
    mediaAgent.isPlaceholderGeneratedPath(normalized) ||
    mediaAgent.isTransientGeneratedImagePath(normalized) ||
    mediaAgent.isReferenceGeneratedImagePath(normalized, referencePaths)
  ) {
    return "";
  }
  return [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(normalized).toLowerCase())
    ? normalized
    : "";
}

function mergeMediaData(existingMedia, incomingMedia, content = {}) {
  const merged = {
    ...(existingMedia || {}),
    ...(incomingMedia || {}),
  };

  merged.generatedImagePath =
    incomingMedia?.generatedImagePath || existingMedia?.generatedImagePath || "";
  merged.generatedVideoPath =
    sanitizeVideoMediaPath(incomingMedia?.generatedVideoPath) ||
    sanitizeVideoMediaPath(existingMedia?.generatedVideoPath) ||
    "";
  merged.imagePrompt = incomingMedia?.imagePrompt || existingMedia?.imagePrompt || "";
  merged.videoPrompt = incomingMedia?.videoPrompt || existingMedia?.videoPrompt || "";
  merged.usedProductImage =
    incomingMedia?.usedProductImage ||
    existingMedia?.usedProductImage ||
    content?.primaryProductImage ||
    "";
  merged.usedLogoPaths = mergeUniquePaths([
    ...(existingMedia?.usedLogoPaths || []),
    ...(incomingMedia?.usedLogoPaths || []),
  ]);

  if (merged.generatedImagePath && merged.generatedVideoPath) {
    merged.mediaType = "both";
  } else if (merged.generatedVideoPath) {
    merged.mediaType = "video";
  } else {
    merged.mediaType = "image";
  }

  return merged;
}

function buildMediaApprovalSummary(params) {
  const { media, route } = params;
  const referenceText = summarizeReferenceUsage(media);

  return [
    `NV Media đã tạo xong media (${route.effectiveType}), đang chờ Sếp duyệt.`,
    media?.generatedImagePath ? "Ảnh media vừa tạo:" : "",
    buildMediaDirective(media?.generatedImagePath),
    media?.generatedVideoPath ? "Video media vừa tạo:" : "",
    buildMediaDirective(media?.generatedVideoPath),
    referenceText,
    "",
    'Duyệt ảnh, tạo video: "Duyệt ảnh, tạo video"',
    'Duyệt và đăng bài: "Duyệt ảnh và đăng bài" hoặc "Duyệt media"',
    'Sửa tiếp: "Sửa ảnh, <nhận xét>" hoặc "Sửa prompt, <nhận xét>"',
  ]
    .filter(Boolean)
    .join("\n");
}

function buildVideoApprovalSummary(params) {
  const { media } = params;
  const referenceText = summarizeReferenceUsage(media);

  return [
    "Media Video đã tạo xong video quảng cáo, đang ch�? Sếp duyệt.",
    media?.generatedVideoPath ? "Video quảng cáo vừa tạo:" : "",
    buildMediaDirective(media?.generatedVideoPath),
    media?.generatedImagePath ? "Ảnh quảng cáo đã duyệt để đối chiếu:" : "",
    buildMediaDirective(media?.generatedImagePath),
    referenceText,
    "",
    'Duyệt video: "Duyệt video"',
    'Sửa video: "Sửa video, <nhận xét>" hoặc "Sửa prompt video, <nhận xét>"',
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPublishDecisionSummary(state) {
  const hasImage = Boolean(state.media?.generatedImagePath);
  const hasVideo = Boolean(state.media?.generatedVideoPath);
  const offerVideo = !hasVideo && !state.video_offer_declined;

  return [
    hasVideo
      ? "Sếp đã duyệt content, ảnh và video. Đã sẵn sàng đăng bài."
      : "Sếp đã duyệt content và ảnh. Đã sẵn sàng đăng bài.",
    hasImage ? "Ảnh sẽ đăng:" : "",
    buildMediaDirective(state.media?.generatedImagePath),
    hasVideo ? "Video sẽ đăng trong lượt này:" : "",
    hasVideo ? buildMediaDirective(state.media?.generatedVideoPath) : "",
    offerVideo ? "Có muốn tạo thêm video quảng cáo cho sản phẩm này rồi đăng lên page không?" : "",
    offerVideo ? 'Tạo video: "Tạo video"' : "",
    'Đăng ngay: "Đăng ngay" hoặc "Publish"',
    'Hẹn giờ: "Hẹn giờ 20:00 hôm nay" hoặc "Schedule 2026-04-10T20:00:00+07:00"',
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStageHumanMessage(state) {
  if (!state) return "";
  if (state.stage === "awaiting_content_approval") {
    return buildContentApprovalCheckpointMessage({
      productName: state.content?.productName || "",
      approvedContent: state.content?.approvedContent || "",
      primaryProductImage: state.content?.primaryProductImage || "",
      primaryProductReviewImage: state.content?.primaryProductReviewImage || "",
      rawReply: state.content?.reply || "",
      revised: Array.isArray(state.reject_history) && state.reject_history.length > 0,
    });
  }
  if (state.stage === "awaiting_media_approval") {
    return buildMediaApprovalSummary({
      media: state.media || {},
      promptPackage: state.prompt_package || {},
      route: mediaAgent.routeMediaType(
        state.media?.mediaType ||
          state.generating_route ||
          state.intent?.media_type_requested ||
          "image",
      ),
    });
  }
  if (state.stage === "awaiting_video_approval") {
    return buildVideoApprovalSummary({
      media: state.media || {},
      promptPackage: state.prompt_package || {},
    });
  }
  if (state.stage === "awaiting_publish_decision") {
    return buildPublishDecisionSummary(state);
  }
  if (state.stage === "awaiting_edit_approval") {
    return buildContentApprovalCheckpointMessage({
      productName: state.content?.productName || "",
      approvedContent: state.content?.approvedContent || "",
      primaryProductImage: state.content?.primaryProductImage || "",
      primaryProductReviewImage: state.content?.primaryProductReviewImage || "",
      rawReply: state.content?.reply || "",
      revised: true,
    });
  }
  return "";
}

function getAsyncStageSpec(state) {
  if (!state) return null;
  if (state.stage === "generating_content") {
    return {
      agentId: "nv_content",
      stepId: state.content_step_id || "step_01_content",
      targetStage: "awaiting_content_approval",
      kind: "content",
      startedAt: state.content_started_at,
    };
  }
  if (state.stage === "generating_media") {
    return {
      agentId: "nv_media",
      stepId: "step_03_media",
      targetStage: "awaiting_media_approval",
      kind: "media",
      startedAt: state.generating_started_at,
      route: state.generating_route || state.intent?.media_type_requested || "image",
    };
  }
  if (state.stage === "revising_media") {
    return {
      agentId: "nv_media",
      stepId: "step_03b_media_revise",
      targetStage: "awaiting_media_approval",
      kind: "media",
      startedAt: state.revising_started_at,
      route:
        state.revising_route ||
        state.prompt_package?.promptDecision ||
        state.media?.mediaType ||
        state.intent?.media_type_requested ||
        "image",
    };
  }
  if (state.stage === "generating_video") {
    return {
      agentId: "media_video",
      stepId: "step_06_video_generate",
      targetStage: "awaiting_video_approval",
      kind: "video",
      startedAt: state.video_generating_started_at,
    };
  }
  if (state.stage === "revising_video") {
    return {
      agentId: "media_video",
      stepId: "step_06c_video_revise",
      targetStage: "awaiting_video_approval",
      kind: "video",
      startedAt: state.video_revising_started_at,
    };
  }
  return null;
}

async function tryRecoverAsyncStageState(params) {
  const { openClawHome, state, paths, registry } = params;
  const spec = getAsyncStageSpec(state);
  if (!spec) {
    return null;
  }


  let workerSessionKey = resolveWorkflowScopedSessionKey({
    agentId: spec.agentId,
    workflowId: state.workflow_id,
    stepId: spec.stepId,
    sessionKey: registry?.byId?.[spec.agentId]?.transport?.sessionKey || "",
  });


  // Ưu tiên session key do BE sinh (per-workflow) thay vì fixed registry key
  try {
    const subConv = await beClient.createSubAgentConversation({
      workflowId: state.workflow_id,
      taskId: buildWorkflowTaskId(state.workflow_id, spec.stepId),
      stepId: spec.stepId,
      managerInstanceId: state.managerInstanceId || null,
      agentId: spec.agentId,
      workerAgentId: spec.agentId,
    });
    if (subConv?.sessionKey) {
      workerSessionKey = subConv.sessionKey;
    }
  } catch {
    // giữ fallback từ registry
  }

  let recoveredMedia = null;

  try {
    const historyReply = await transport.findLatestWorkflowReplyInHistory({
      openClawHome,
      sessionKey: workerSessionKey,
      workflowId: state.workflow_id,
      stepId: spec.stepId,
      timeoutMs: 15000,
      limit: 50,
    });
    if (historyReply) {
      if (spec.kind === "content") {
        const validation = validateContentCheckpointReply({
          reply: historyReply,
          workflowId: state.workflow_id,
          stepId: spec.stepId,
        });
        logCheckpointValidation(
          spec.agentId,
          state.workflow_id,
          spec.stepId,
          validation,
          workerSessionKey,
        );
        if (validation.ok) {
          const content = enrichContentReviewMedia(paths, state.workflow_id, {
            ...validation.content,
            reply: validation.reply,
          });
          return saveWorkflow(paths, {
            ...state,
            stage: spec.targetStage,
            content_started_at: null,
            content,
          });
        }
        return null;
      }
      if (spec.kind === "video") {
        const parsed = videoAgent.parseVideoResult(historyReply, {
          productImage: state.content?.primaryProductImage || "",
          outputDir:
            state.video_output_dir || videoAgent.resolveVideoOutputDir(openClawHome, state.workflow_id),
          logoPaths:
            state.video_generating_logo_paths ||
            state.video_revising_logo_paths ||
            state.media?.usedLogoPaths ||
            mediaAgent.resolveLogoAssetPaths(openClawHome),
        });
        const guarded = normalizeIncomingMediaForAsyncStage(parsed, state, spec);
        recoveredMedia = guarded ? mergeMediaData(state.media, guarded, state.content) : null;
      } else {
        const parsed = mediaAgent.parseMediaResult(historyReply, spec.route);
        const guarded = normalizeIncomingMediaForAsyncStage(parsed, state, spec);
        recoveredMedia = guarded ? mergeMediaData(state.media, guarded, state.content) : null;
      }
    }
  } catch {
    // fall through to artifact scan
  }

  if (spec.kind === "content") {
    return null;
  }

  if (!recoveredMedia) {
    const workflowVideoOutputDir =
      spec.kind === "video"
        ? state.video_output_dir || videoAgent.resolveVideoOutputDir(openClawHome, state.workflow_id)
        : "";
    const workflowImageOutputDir =
      spec.kind === "media"
        ? state.generating_output_dir ||
          state.revising_output_dir ||
          mediaAgent.resolveMediaOutputDir(openClawHome, state.workflow_id, spec.stepId)
        : "";
    const recoveredArtifacts = scanLatestGeneratedMedia(openClawHome, spec.startedAt, {
      agentId: spec.agentId,
      imageDirs: workflowImageOutputDir ? [workflowImageOutputDir] : [],
      strictImageDirs: Boolean(workflowImageOutputDir),
      videoDirs: workflowVideoOutputDir ? [workflowVideoOutputDir] : [],
      strictVideoDirs: spec.kind === "video",
      referencePaths: [
        state.content?.primaryProductImage,
        state.media?.usedProductImage,
        ...(state.media?.usedLogoPaths || []),
      ].filter(Boolean),
      blockedPaths: [
        ...collectMediaPaths(state.media),
        state.generating_bg_image_path,
        state.revising_bg_image_path,
      ].filter(Boolean),
    });
    if (spec.kind === "video" && recoveredArtifacts.videoPath) {
      const guarded = normalizeIncomingMediaForAsyncStage(
        {
          generatedVideoPath: recoveredArtifacts.videoPath,
          videoPrompt: state.prompt_package?.videoPrompt || state.media?.videoPrompt || "",
          usedProductImage:
            state.content?.primaryProductImage || state.media?.usedProductImage || "",
          usedLogoPaths:
            state.video_generating_logo_paths ||
            state.video_revising_logo_paths ||
            state.media?.usedLogoPaths ||
            [],
        },
        state,
        spec,
      );
      recoveredMedia = guarded
        ? mergeMediaData(
        state.media,
        guarded,
        state.content,
      )
        : null;
    }
    if (spec.kind === "media" && (recoveredArtifacts.imagePath || recoveredArtifacts.videoPath)) {
      const guarded = normalizeIncomingMediaForAsyncStage(
        {
          generatedImagePath: recoveredArtifacts.imagePath || "",
          generatedVideoPath: recoveredArtifacts.videoPath || "",
          mediaType: spec.route,
          imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
          videoPrompt: state.prompt_package?.videoPrompt || state.media?.videoPrompt || "",
          usedProductImage:
            state.content?.primaryProductImage || state.media?.usedProductImage || "",
          usedLogoPaths:
            state.generating_logo_paths ||
            state.revising_logo_paths ||
            state.media?.usedLogoPaths ||
            [],
        },
        state,
        spec,
      );
      recoveredMedia = guarded
        ? mergeMediaData(
        state.media,
        guarded,
        state.content,
      )
        : null;
    }
  }

  if (!recoveredMedia || collectMediaPaths(recoveredMedia).length === 0) {
    return null;
  }

  return saveWorkflow(paths, {
    ...state,
    stage: spec.targetStage,
    media: recoveredMedia,
    generating_started_at: spec.kind === "media" ? null : state.generating_started_at,
    revising_started_at: spec.kind === "media" ? null : state.revising_started_at,
    video_generating_started_at: spec.kind === "video" ? null : state.video_generating_started_at,
    video_revising_started_at: spec.kind === "video" ? null : state.video_revising_started_at,
  });
}

function startWorkflowStageAutoNotifyWatcher(params) {
  const sessionKey = String(params.sessionKey || "").trim();
  const workflowId = String(params.workflowId || "").trim();
  const stage = String(params.stage || "").trim();
  if (!sessionKey || !workflowId || !stage) {
    return;
  }

  const args = [
    __filename,
    "--auto-notify-watch",
    "--openclaw-home",
    params.openClawHome,
    "--notify-session-key",
    sessionKey,
    "--notify-workflow-id",
    workflowId,
    "--notify-stage",
    stage,
    "--timeout-ms",
    String(params.timeoutMs || DEFAULT_MEDIA_TIMEOUT_MS),
  ];

  const openClawHome = resolveOpenClawHome(params.openClawHome);
  const logDir = path.join(openClawHome, "logs", "agent-orchestrator-test");
  const logPath = path.join(logDir, "auto-notify.log");
  ensureDir(logDir);

  let logHandle = null;
  try {
    logHandle = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
      },
      stdio: ["ignore", logHandle, logHandle],
      windowsHide: true,
    });
    if (typeof child.pid === "number" && child.pid > 0) {
      fs.appendFileSync(
        logPath,
        `[${nowIso()}] spawn pid=${child.pid} workflow=${workflowId} stage=${stage} session=${sessionKey}\n`,
      );
    }
    child.unref();
  } catch (error) {
    logger.logError("auto_notify_spawn", error);
    try {
      fs.appendFileSync(
        logPath,
        `[${nowIso()}] spawn_error workflow=${workflowId} stage=${stage}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
      );
    } catch {}
  } finally {
    if (logHandle !== null) {
      try {
        fs.closeSync(logHandle);
      } catch {}
    }
  }
}

async function runAutoNotifyWatcher(options) {
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const workspaceDir = getPhoPhongWorkspace(config, openClawHome);
  const paths = buildPaths(workspaceDir, options.managerInstanceId);
  const registry = discoverRegistry({ openClawHome });
  const targetWorkflowId = String(options.notifyWorkflowId || "").trim();
  const targetStage = String(options.notifyStage || "").trim();
  const targetSessionKey = String(options.notifySessionKey || "").trim();
  const deadline =
    Date.now() + Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_MEDIA_TIMEOUT_MS, 30000), MAX_AUTO_NOTIFY_TIMEOUT_MS);

  while (Date.now() <= deadline) {
    let state = readJsonIfExists(paths.currentFile, null);
    if (!state || state.workflow_id !== targetWorkflowId) {
      return;
    }
    const stateBeforeMigration = JSON.stringify(state);
    state = migrateState(state);
    if (JSON.stringify(state) !== stateBeforeMigration) {
      state = saveWorkflow(paths, state);
    }
    if (state.stage !== targetStage) {
      const recoveredState = await tryRecoverAsyncStageState({
        openClawHome,
        state,
        paths,
        registry,
      });
      if (recoveredState?.stage === targetStage) {
        state = recoveredState;
      }
    }
    if (state.stage === targetStage) {
      if (hasWorkflowStageNotification(state, targetStage)) {
        return;
      }
      const humanMessage = buildStageHumanMessage(state);
      if (!humanMessage) {
        return;
      }
      try {
        const delivered = await syncRootConversationMessage({
          workflowId: targetWorkflowId,
          stage: targetStage,
          type: targetStage.startsWith("awaiting_") ? "approval_request" : "regular",
          content: humanMessage,
          managerId: "pho_phong",
          rootConversationId: state.rootConversationId || null,
          sessionKey: targetSessionKey,
          title: `[AUTO] pho_phong • ${targetWorkflowId}`,
          eventId: `${targetWorkflowId}:${targetStage}:checkpoint`,
          injectToGateway: true,
        });
        if (!delivered) {
          throw new Error("backend_sync_failed");
        }
      } catch (error) {
        logger.logError("auto_notify_inject", error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      markWorkflowStageNotified(paths, targetWorkflowId, targetStage, "auto");
      return;
    }
    if (["published", "scheduled", "cancelled"].includes(String(state.stage || ""))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function scoreGeneratedImageArtifact(fullPath) {
  const fileName = path.basename(fullPath || "").toLowerCase();
  if (!fileName) return -1;
  if (/^gemini_generated_image_/i.test(fileName)) return 4;
  if (/[_-]final\./i.test(fileName)) return 3;
  if (/generated|download/i.test(fileName)) return 2;
  if (/^gemini-(before|after)-/i.test(fileName)) return -1;
  return 1;
}

function isLikelyFinalGeneratedVideoPath(fullPath) {
  const fileName = path.basename(fullPath || "").toLowerCase();
  if (!fileName) return false;
  if (!/^veo-/.test(fileName)) return false;
  try {
    const stats = fs.statSync(fullPath);
    return stats.isFile() && stats.size >= 1024;
  } catch {
    return false;
  }
}

function selectLatestFinalGeneratedVideoAcrossDirs(dirPaths, extensions, sinceMs) {
  const candidates = [];
  for (const dirPath of dirPaths) {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) continue;
      for (const name of fs.readdirSync(dirPath)) {
        if (!extensions.includes(path.extname(name).toLowerCase())) continue;
        const fullPath = path.join(dirPath, name);
        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) continue;
        if (Number.isFinite(sinceMs) && sinceMs > 0 && stats.mtimeMs < sinceMs) continue;
        if (!isLikelyFinalGeneratedVideoPath(fullPath)) continue;
        candidates.push({ fullPath, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // Ignore unreadable artifact dirs.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.fullPath || "";
}

function scanLatestGeneratedMedia(openClawHome, startedAtIso, overrides = {}) {
  const agentId = overrides.agentId || "nv_media";
  const workspaceDir =
    overrides.workspaceDir ||
    memory.resolveAgentWorkspace(agentId, openClawHome) ||
    path.join(
      openClawHome,
      agentId === "media_video" ? "workspace_media_video" : "workspace_media",
    );
  const sinceMs = startedAtIso ? new Date(startedAtIso).getTime() : 0;
  const repoRoot = path.resolve(overrides.repoRoot || REPO_ROOT);
  const blocked = buildBlockedMediaArtifactSet([
    ...(overrides.blockedPaths || []),
    ...(overrides.referencePaths || []),
  ]);

  const explicitImageDirs = Array.isArray(overrides.imageDirs)
    ? overrides.imageDirs.filter(Boolean)
    : [];
  const imageDirs = overrides.strictImageDirs
    ? [...new Set(explicitImageDirs)]
    : [
        ...explicitImageDirs,
        path.join(workspaceDir, "artifacts", "images"),
        path.join(repoRoot, "artifacts", "images"),
      ];
  const imageCandidates = imageDirs
    .flatMap((dirPath) => {
      try {
        if (!dirPath || !fs.existsSync(dirPath)) return [];
        return fs
          .readdirSync(dirPath)
          .filter((name) => {
            if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(name).toLowerCase())) {
              return false;
            }
            if (
              [/before/i, /after/i, /screenshot/i, /test_/i].some((pattern) => pattern.test(name))
            ) {
              return false;
            }
            const fullPath = path.join(dirPath, name);
            const mtimeMs = fs.statSync(fullPath).mtimeMs;
            if (Number.isFinite(sinceMs) && sinceMs > 0 && mtimeMs < sinceMs) return false;
            return isUsableRecoveredArtifact(fullPath, {
              startedAtIso,
              referencePaths: overrides.referencePaths || [],
              blocked,
            });
          })
          .map((name) => {
            const fullPath = path.join(dirPath, name);
            return {
              fullPath,
              mtimeMs: fs.statSync(fullPath).mtimeMs,
              score: scoreGeneratedImageArtifact(fullPath),
            };
          })
          .filter((item) => item.score >= 0);
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs);

  const imagePath = imageCandidates[0]?.fullPath || "";

  const explicitVideoDirs = Array.isArray(overrides.videoDirs)
    ? overrides.videoDirs.filter(Boolean)
    : [];
  const explicitVideoPath = selectLatestFinalGeneratedVideoAcrossDirs(
    [...new Set(explicitVideoDirs)],
    [".mp4", ".mov", ".webm"],
    sinceMs,
  );
  const explicitFinalVideoPath = explicitVideoPath || "";
  const videoDirs = [
    path.join(workspaceDir, "artifacts", "videos"),
    path.join(workspaceDir, "outputs", "veo_videos"),
    path.join(workspaceDir, "outputs", "videos"),
    path.join(repoRoot, "artifacts", "videos"),
    path.join(repoRoot, "outputs", "veo_videos"),
    path.join(repoRoot, "outputs", "videos"),
  ];
  const videoPath = overrides.strictVideoDirs
    ? explicitFinalVideoPath
    : explicitFinalVideoPath ||
      selectLatestFinalGeneratedVideoAcrossDirs(
        [...new Set(videoDirs.filter(Boolean))],
        [".mp4", ".mov", ".webm"],
        sinceMs,
      );

  return {
    imagePath,
    videoPath: isLikelyFinalGeneratedVideoPath(videoPath) ? videoPath : "",
  };
}

// â�?€â�?€â�?€ Content Dedup Check â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

function isDuplicateContent(historyDir, newContent) {
  try {
    if (!fs.existsSync(historyDir)) return false;
    const files = fs
      .readdirSync(historyDir)
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

// â�?€â�?€â�?€ WORKFLOW ACTIONS â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

/**
 * Táº¡o workflow má»›i â€�? giao nv_content viáº¿t bÃ i.
 */
async function startNewWorkflow(context) {
  const rootBinding = await resolveRootWorkflowBinding(context);
  const workflowId = rootBinding.workflowId;
  const stepId = "step_01_content";
  const requestedMediaType = context.intent?.media_type_requested || "image";
  const intent = {
    ...(context.intent || {}),
    media_type_requested: "image",
    requested_video_after_publish: requestedMediaType === "video" || requestedMediaType === "both",
    requested_original_media_type: requestedMediaType,
  };

  try {
    await beClient.createWorkflow({
      id: workflowId,
      rootConversationId: rootBinding.rootConversationId || context.parentConversationId || null,
      managerInstanceId: rootBinding.managerInstanceId || undefined,
      initiatorAgentId: context.options.from || "pho_phong",
      initiatorEmployeeId: context.options.from || "pho_phong",
      title: `[AUTO] Workflow (từ ${context.options.from})`,
      inputPayload: JSON.stringify(context.message),
    });
  } catch (err) {
    logger.logError("beClient", "Lỗi tạo workflow Db: " + err.message);
  }

  logger.logPhase("TẠO BÀI MỚI", `Sếp giao brief: "${context.message.slice(0, 100)}..."`);
  logger.logHandoff(
    "Phó phòng",
    "NV Content",
    logger.buildHumanMessage(
      "pho_phong",
      "nv_content",
      "content_draft",
      context.message.slice(0, 80),
    ),
  );

  const prompt = contentAgent.buildContentDraftPrompt({
    workflowId,
    stepId,
    brief: context.message,
    openClawHome: context.openClawHome,
    workflowGuidelines: mergeWorkflowGuidelines([], context.message),
  });

  const baseState = saveWorkflow(context.paths, {
    workflow_id: workflowId,
    rootConversationId: rootBinding.rootConversationId || null,
    managerId: context.options.from || "pho_phong",
    created_at: nowIso(),
    status: "pending",
    stage: "generating_content",
    content_started_at: nowIso(),
    content_step_id: stepId,
    intent,
    original_brief: context.message,
    content: null,
    prompt_package: null,
    media: null,
    publish: null,
    reject_history: [],
    prompt_versions: [],
    global_guidelines: mergeWorkflowGuidelines([], context.message),
    notifications: {},
  });

  let contentCheckpoint = await recoverContentCheckpointFromHistory({
    agentId: "nv_content",
    managerInstanceId: rootBinding.managerInstanceId || null,
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    rootConversationId: rootBinding.rootConversationId || null,
    taskId: buildWorkflowTaskId(workflowId, stepId),
    workflowId,
    stepId,
  });

  if (!contentCheckpoint) {
    contentCheckpoint = await runContentCheckpointStep({
      agentId: "nv_content",
      sessionKey: context.registry.byId.nv_content.transport.sessionKey,
      openClawHome: context.openClawHome,
      rootConversationId: rootBinding.rootConversationId || null,
      workflowId,
      stepId,
      timeoutMs: getContentTimeoutMs(context.options.timeoutMs),
      prompt,
      onTaskStarted: ({ sessionKey }) =>
        startContentApprovalAutoNotifyWatcher(context, workflowId, sessionKey),
    });
  }
  const content = enrichContentReviewMedia(context.paths, workflowId, contentCheckpoint.content);

  // Content dedup check
  if (isDuplicateContent(context.paths.historyDir, content.approvedContent)) {
    logger.log("info", "Lỗi¸  Nội dung này có thể trùng với bài đã đăng gần đây.");
  }

  const state = saveWorkflow(context.paths, {

    ...baseState,

    status: "pending",
    stage: "awaiting_content_approval",
    content_started_at: null,
    content,
  });

  const summary = [
    context.supersededWorkflowId ? `Da archive workflow cu: ${context.supersededWorkflowId}` : "",
    " NV Content đã viết xong bài nháp, đang ch�? Sếp duyệt.",
    content.productName ? `Sản phẩm: ${content.productName}` : "",
    "",
    "NỘI DUNG CHỜ DUYỆT",
    content.approvedContent,
    'Sếp muốn duyệt? Nói: "Duyệt content, tạo ảnh"',
    'Muốn sửa? Ghi rõ nhận xét, ví dụ: "Sửa content, thêm giá"',
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    getContentReviewImage(content) ? "" : "",
    getContentReviewImage(content) ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
    buildMediaDirective(getContentReviewImage(content)),
  ]
    .filter(Boolean)
    .join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  await syncApprovalCheckpoint({
    workflowId,
    paths: context.paths,
    rootConversationId: rootBinding.rootConversationId || null,
    managerInstanceId: rootBinding.managerInstanceId || null,
    taskId: buildWorkflowTaskId(workflowId, state.stage),
    stepId: state.stage,
    managerId: context.options.from || "pho_phong",
    stage: state.stage,
    title: `[AUTO] ${context.options.from || "pho_phong"} • ${workflowId}`,
    content: buildContentApprovalCheckpointMessage({
      productName: content.productName,
      approvedContent: content.approvedContent,
      primaryProductImage: content.primaryProductImage,
      primaryProductReviewImage: content.primaryProductReviewImage,
      rawReply: content.reply,
      revised: false,
    }),
    eventId: `${workflowId}:awaiting_content_approval:content`,
  });

  return buildResult({
    workflowId,
    stage: state.stage,
    summary: summaryWithPreview,
    humanMessage: summaryWithPreview,
    data: { content, next_expected_action: "content_approval" },
  });
}

/**
 * Sá»­a content khi bá»‹ reject.
 */
async function reviseContent(context, state) {
  const stepId = "step_01b_content_revise";

  logger.logRejected("content", context.message);

  // Memory learning: rÃºt quy táº¯c tá»« feedback
  const feedbackRule = memory.learnFromFeedbackSync(
    "nv_content",
    context.openClawHome,
    context.message,
  );
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
    logger.logError(
      "content",
      `NV Content đã bị từ chối ${contentRejects} lần. Cần xem lại brief.`,
    );
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `NV Content đã bị từ chối ${contentRejects} lần liên tiếp. Có thể brief cần bổ sung hoặc nhân viên cần training thêm.`,
      data: { reject_count: contentRejects },
    });
  }

  logger.logHandoff(
    "PhÃ³ phÃ²ng",
    "NV Content",
    logger.buildHumanMessage(
      "pho_phong",
      "nv_content",
      "content_revise",
      context.message.slice(0, 80),
    ),
  );

  const prompt = contentAgent.buildContentRevisePrompt({
    workflowId: state.workflow_id,
    stepId,
    originalBrief: state.original_brief,
    feedback: context.message,
    oldContent: state.content.approvedContent,
    openClawHome: context.openClawHome,
    workflowGuidelines: state.global_guidelines || [],
  });

  const revisingState = saveWorkflow(context.paths, {
    ...state,
    stage: "generating_content",
    content_started_at: nowIso(),
    content_step_id: stepId,
  });

  const contentCheckpoint = await runContentCheckpointStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: getContentTimeoutMs(context.options.timeoutMs),
    prompt,
    onTaskStarted: ({ sessionKey }) =>
      startContentApprovalAutoNotifyWatcher(context, state.workflow_id, sessionKey),
  });
  const content = enrichContentReviewMedia(context.paths, state.workflow_id, contentCheckpoint.content);
  const nextState = saveWorkflow(context.paths, {
    ...revisingState,
    stage: "awaiting_content_approval",
    content_started_at: null,
    content,
  });

  const summary = [
    " NV Content đã sửa lại bài theo nhận xét, đang ch�? Sếp duyệt lại.",
    "",
    "NỘI DUNG �?Ã SỬA",
    content.approvedContent,
    "",
    'Duyệt: "Duyệt content, tạo ảnh"',
    "Sửa tiếp: ghi rõ nhận xét",
  ].join("\n");
  const summaryWithPreview = [
    summary,
    getContentReviewImage(content) ? "" : "",
    getContentReviewImage(content) ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
    buildMediaDirective(getContentReviewImage(content)),
  ]
    .filter(Boolean)
    .join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  await syncApprovalCheckpoint({
    workflowId: state.workflow_id,
    paths: context.paths,
    rootConversationId: state.rootConversationId || null,
    managerId: context.options.from || "pho_phong",
    stage: nextState.stage,
    title: `[AUTO] ${context.options.from || "pho_phong"} • ${state.workflow_id}`,
    content: buildContentApprovalCheckpointMessage({
      productName: content.productName,
      approvedContent: content.approvedContent,
      primaryProductImage: content.primaryProductImage,
      primaryProductReviewImage: content.primaryProductReviewImage,
      rawReply: content.reply,
      revised: true,
    }),
    eventId: `${state.workflow_id}:awaiting_content_approval:content_revise`,
  });

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: summaryWithPreview,
    humanMessage: summaryWithPreview,
    data: { content, next_expected_action: "content_approval" },
  });
}

/**
 * Táº¡o media (áº£nh hoáº·c video).
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
    "Phó phòng",
    "NV Media",
    logger.buildHumanMessage("pho_phong", "nv_media", "media_generate", ""),
  );

  const prompt = mediaAgent.buildMediaGeneratePrompt({
    workflowId: state.workflow_id,
    stepId,
    state,
    mediaType: route.effectiveType,
    openClawHome: context.openClawHome,
  });

  // â�?€â�?€â�?€ LOCK: LÆ°u stage 'generating_media' TRÆ¯á»šC khi gá»�?i agent â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  // Tháº©m quyá»�?n nÃ y ngÄƒn orchestrator bá»‹ loop khÃ´ng há»Ÿi NV Media láº§n 2
  // náº¿u nÃ³ crash sau khi NV Media Ä‘Ã£ tráº£ áº£nh nhÆ°ng trÆ°á»›c khi save state.
  const generatingStartedAt = nowIso();
  const generatingOutputDir = mediaAgent.resolveMediaOutputDir(
    context.openClawHome,
    state.workflow_id,
    stepId,
  );
  saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_started_at: generatingStartedAt,
    generating_output_dir: generatingOutputDir,
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
      break; // ThÃ nh cÃ´ng
    } catch (transportErr) {
      logger.logError("transport", `Láº§n ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= MAX_TRANSPORT_RETRIES) {
        // Khi transport lá»—i, khÃ´i phá»¥c stage vá»�? awaiting_content_approval
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
            "Tạo ảnh không thành công sau 2 lần thử.",
            `Lỗi: ${transportErr.message || "Kết nối tới NV Media bị ngắt."}`,
            "",
            'Thử lại: "Duyệt content, tạo ảnh"',
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `Thử lại lần ${attempt + 1}...`);
    }
  }

  // â�?€â�?€â�?€ Parse káº¿t quáº£ â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
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
        "NV Media đã tạo ảnh nhưng hệ thống không đ�?c được kết quả.",
        `Lỗi: ${parseErr.message}`,
        "",
        'Thử lại: "Duyệt content, tạo ảnh"',
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // â�?€â�?€â�?€ LÆ°u background path ngay sau khi parse â€�? trÆ°á»›c composite â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  // Náº¿u composite crash, recovery sá»­ dá»¥ng Ä‘Æ°á»�?ng dáº«n nÃ y thay vÃ¬ scan thÆ° má»¥c.
  const guardedMedia = normalizeIncomingMediaForAsyncStage(media, state, {
    kind: "media",
    route: route.effectiveType,
    startedAt: generatingStartedAt,
  });
  if (!guardedMedia) {
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
      last_error: "media_generate returned no fresh image artifact",
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary: [
        "Tạo ảnh chưa trả v�? file ảnh mới hợp lệ.",
        "Hệ thống đã chặn việc dùng lại ảnh cũ hoặc ảnh gốc sản phẩm làm bản duyệt.",
        "",
        'Thử lại: "Duyệt content, tạo ảnh"',
      ].join("\n"),
      data: { error: "media_generate returned stale_or_reference_artifact" },
    });
  }
  media = guardedMedia;

  saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_bg_image_path: media.generatedImagePath || "",
    generating_product_image_path: state.content?.primaryProductImage || "",
  });

  // â�?€â�?€â�?€ PIPELINE GHÃ‰P 3 Lá»šP â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  // Náº¿u cÃ³ áº£nh sáº£n pháº©m tháº­t â†’ ghÃ©p: Background AI + Product tháº­t + Logo
  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (
    route.effectiveType === "image" &&
    media.generatedImagePath &&
    state.content?.primaryProductImage
  ) {
    try {
      logger.log("media", "�?ang ghép 3 lớp: N�?n AI + Sản phẩm thật + Logo...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `Ghép ảnh 3 lớp thành công: ${compositePath}`);
    } catch (compErr) {
      if (logger.isEnabled()) {
        process.stderr.write(`[COMPOSITE_ERROR] ${compErr.stack || compErr.message || compErr}\n`);
      }
      logger.logError("composite", compErr);
      logger.log("info", "Sử dụng ảnh n�?n AI gốc (chưa ghép sản phẩm).");
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

  // Táº¡o file:// link Ä‘á»ƒ phÃ³ phÃ²ng hiá»ƒn thá»‹ áº£nh trong chat
  const fileLink = finalMediaPath ? `file:///${finalMediaPath.replace(/\\/g, "/")}` : "";

  const summary = [
    `NV Media đã tạo ${route.effectiveType === "video" ? "video" : "ảnh"} xong, đang ch�? Sếp duyệt.`,
    media.composited ? "�?ã ghép: N�?n AI + Sản phẩm thật + Logo" : "",
    route.fallbackMessage ? `${route.fallbackMessage}` : "",
    "",
    finalMediaPath ? `Xem ảnh: ${fileLink}` : "",
    `File: ${finalMediaPath}`,
    "",
    'Duyệt và đăng bài: "Duyệt ảnh và đăng bài"',
    'Sửa ảnh: ghi rõ nhận xét, ví dụ: "Sửa ảnh, n�?n chưa đẹp"',
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    finalMediaPath ? "" : "",
    finalMediaPath ? "Ảnh media vừa tạo:" : "",
    buildMediaDirective(finalMediaPath),
    state.content?.primaryProductImage ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
    buildMediaDirective(state.content?.primaryProductImage),
  ]
    .filter(Boolean)
    .join("\n");

  logger.logApprovalWait("awaiting_media_approval", `File: ${finalMediaPath}`);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: summaryWithPreview,
    humanMessage: summaryWithPreview,
    data: {
      media,
      approved_content: state.content.approvedContent,
      next_expected_action: "media_approval",
    },
  });
}

/**
 * Sá»­a media khi bá»‹ reject.
 */
async function reviseMedia(context, state) {
  const stepId = "step_02b_media_revise";
  const mediaType = state.media?.mediaType || state.intent?.media_type_requested || "image";

  logger.logRejected("media", context.message);

  // Memory learning
  const feedbackRule = memory.learnFromFeedbackSync(
    "nv_media",
    context.openClawHome,
    context.message,
  );
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
      summary: `NV Media đã bị từ chối ${mediaRejects} lần liên tiếp. Prompt có thể cần được thiết kế lại.`,
      data: { reject_count: mediaRejects },
    });
  }

  logger.logHandoff(
    "Phó phòng",
    "NV Media",
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

  // â�?€â�?€â�?€ LOCK: LÆ°u stage 'revising_media' TRÆ¯á»šC khi gá»�?i agent â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  const revisingStartedAt = nowIso();
  const revisingOutputDir = mediaAgent.resolveMediaOutputDir(
    context.openClawHome,
    state.workflow_id,
    stepId,
  );
  saveWorkflow(context.paths, {
    ...state,
    stage: "revising_media",
    revising_started_at: revisingStartedAt,
    revising_output_dir: revisingOutputDir,
    revising_feedback: context.message,
  });

  // â�?€â�?€â�?€ Gá»�?i NV Media vá»›i retry â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
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
      logger.logError("transport", `Láº§n ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= MAX_TRANSPORT_RETRIES) {
        saveWorkflow(context.paths, {
          ...state,
          stage: "revising_media",
          last_error: `media_revise transport: ${transportErr.message}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "revising_media",
          status: "error",
          summary: [
            "Sửa ảnh không thành công.",
            `Lỗi: ${transportErr.message || "Kết nối bị ngắt."}`,
            "",
            "Thử lại: nhắn lại nhận xét sửa ảnh",
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `Thử lại lần ${attempt + 1}...`);
    }
  }

  // â�?€â�?€â�?€ Parse káº¿t quáº£ â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  let media;
  try {
    media = mediaAgent.parseMediaResult(reply, mediaType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "revising_media",
      last_error: `parse_media: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_media",
      status: "error",
      summary: [
        "NV Media đã tạo ảnh mới nhưng hệ thống không đ�?c được kết quả.",
        `Lỗi: ${parseErr.message}`,
        "",
        "Thử lại: nhắn lại nhận xét sửa ảnh",
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // â�?€â�?€â�?€ PIPELINE GHÃ‰P 3 Lá»šP (giá»‘ng generateMedia) â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
  const guardedRevisedMedia = normalizeIncomingMediaForAsyncStage(media, state, {
    kind: "media",
    route: mediaType,
    startedAt: revisingStartedAt,
  });
  if (!guardedRevisedMedia) {
    saveWorkflow(context.paths, {
      ...state,
      stage: "revising_media",
      last_error: "media_revise returned no fresh image artifact",
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_media",
      status: "error",
      summary: [
        "Sửa ảnh chưa trả v�? file ảnh mới hợp lệ.",
        "Hệ thống đã chặn việc trình lại ảnh cũ hoặc ảnh gốc sản phẩm.",
        "",
        "Thử lại: nhắn lại nhận xét sửa ảnh",
      ].join("\n"),
      data: { error: "media_revise returned stale_or_reference_artifact" },
    });
  }
  media = guardedRevisedMedia;

  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (mediaType === "image" && media.generatedImagePath && state.content?.primaryProductImage) {
    try {
      logger.log("media", "�?ang ghép lại 3 lớp với n�?n mới...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `Ghép ảnh 3 lớp thành công: ${compositePath}`);
    } catch (compErr) {
      logger.logError("composite", compErr);
      logger.log("info", "Sử dụng ảnh n�?n AI gốc (chưa ghép sản phẩm).");
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

  // Táº¡o file:// link Ä‘á»ƒ phÃ³ phÃ²ng hiá»ƒn thá»‹ áº£nh trong chat
  const fileLink = finalMediaPath ? `file:///${finalMediaPath.replace(/\\/g, "/")}` : "";

  const summary = [
    "NV Media đã sửa lại theo nhận xét, đang ch�? Sếp duyệt.",
    media.composited ? "�?ã ghép lại: N�?n AI mới + Sản phẩm thật + Logo" : "",
    "",
    finalMediaPath ? `Xem ảnh: ${fileLink}` : "",
    `File mới: ${finalMediaPath}`,
    "",
    'Duyệt và đăng bài: "Duyệt ảnh và đăng bài"',
    "Sửa ảnh: ghi rõ nhận xét",
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    finalMediaPath ? "" : "",
    finalMediaPath ? "Anh media sau khi sua:" : "",
    buildMediaDirective(finalMediaPath),
    state.content?.primaryProductImage ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
    buildMediaDirective(state.content?.primaryProductImage),
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: summaryWithPreview,
    humanMessage: summaryWithPreview,
    data: { media, next_expected_action: "media_approval" },
  });
}

/**
 * BÆ°á»›c trung gian: Há»�?i sáº¿p muá»‘n Ä‘Äƒng ngay hay háº¹n giá»�?.
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
    "Pho phong",
    "NV Media",
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
        "NV Media chưa tổng hợp được brief để gửi NV Prompt.",
        `Lỗi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        'Thử lại: "Duyệt content, tạo ảnh"',
      ].join("\n"),
      data: { error: mediaPrepareErr.message || String(mediaPrepareErr) },
    });
  }

  logger.logHandoff(
    "NV Media",
    "NV Prompt",
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
        workflowGuidelines: state.global_guidelines || [],
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
        "Không thể tạo prompt media từ NV Prompt.",
        `Lỗi: ${promptErr.message || promptErr}`,
        "",
        'Thử lại: "Duyệt content, tạo ảnh"',
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
    logger.buildHumanMessage("nv_prompt", "nv_media", "prompt_back_to_media", route.effectiveType),
  );

  const generatingStartedAt = nowIso();
  const generatingOutputDir = mediaAgent.resolveMediaOutputDir(
    context.openClawHome,
    state.workflow_id,
    mediaStepId,
  );
  const generatingState = saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_started_at: generatingStartedAt,
    generating_output_dir: generatingOutputDir,
    generating_route: route.effectiveType,
    generating_logo_paths: logoPaths,
    media_request_brief: mediaRequestBrief,
    prompt_package: promptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
  });

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
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
      if (isAsyncStepStillRunningError(transportErr)) {
        startWorkflowStageAutoNotifyWatcher({
          openClawHome: context.openClawHome,
          workflowId: state.workflow_id,
          stage: "awaiting_media_approval",
          sessionKey:
            context.registry.byId.pho_phong?.transport?.sessionKey ||
            buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
          timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        });
        const waitingState = saveWorkflow(context.paths, {
          ...generatingState,
          stage: "generating_media",
          last_error: "",
        });
        const summary = buildAsyncWaitingSummary("media");
        return buildResult({
          workflowId: state.workflow_id,
          stage: waitingState.stage,
          status: "running",
          summary,
          humanMessage: summary,
          data: { next_expected_action: "wait_media" },
        });
      }
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
            "Không thể tạo media sau 2 lần thử.",
            `Lỗi: ${transportErr.message || "Kết nối tới NV Media bị ngắt."}`,
            "",
            'Thử lại: "Duyệt content, tạo ảnh"',
          ].join("\n"),
          data: { error: transportErr.message || String(transportErr) },
        });
      }
      logger.log("info", `Thử lại lần ${attempt + 1}...`);
    }
  }

  let media;
  try {
    media = mediaAgent.parseMediaResult(mediaReply, route.effectiveType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    const summary = buildMediaParseFailureSummary({
      reply: mediaReply,
      error: parseErr,
      title: "Bước tạo media chưa có file thật để duyệt.",
      retryHint: 'Thử lại: "Duyệt content, tạo ảnh" hoặc "Tạo lại ảnh"',
    });
    saveWorkflow(context.paths, {
      ...generatingState,
      stage: "awaiting_content_approval",
      last_error: `parse_media error: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary,
      humanMessage: summary,
      data: { error: parseErr.message },
    });
  }
  const guardedMedia = normalizeIncomingMediaForAsyncStage(media, generatingState, {
    kind: "media",
    route: route.effectiveType,
    startedAt: generatingStartedAt,
  });
  if (!guardedMedia) {
    const summary = [
      "Tạo media chưa trả v�? file mới hợp lệ để duyệt.",
      "Hệ thống đã chặn việc dùng lại ảnh cũ hoặc ảnh gốc sản phẩm làm bản duyệt.",
      "",
      'Thử lại: "Duyệt content, tạo ảnh" hoặc "Tạo lại ảnh"',
    ].join("\n");
    saveWorkflow(context.paths, {
      ...generatingState,
      stage: "awaiting_content_approval",
      last_error: "media_generate returned stale_or_reference_artifact",
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_content_approval",
      status: "error",
      summary,
      humanMessage: summary,
      data: { error: "media_generate returned stale_or_reference_artifact" },
    });
  }
  media = guardedMedia;

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

  const feedbackRule = memory.learnFromFeedbackSync(
    "nv_media",
    context.openClawHome,
    context.message,
  );
  if (feedbackRule) {
    const latestRule = feedbackRule.rules[feedbackRule.rules.length - 1];
    logger.logLearning("nv_media", latestRule?.text || context.message);
  }
  if (promptFocused) {
    const promptRule = memory.learnFromFeedbackSync(
      "nv_prompt",
      context.openClawHome,
      context.message,
    );
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
    logger.logError("media", `NV Media đã bị từ chối ${mediaRejects} lần.`);
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `NV Media đã bị từ chối ${mediaRejects} lần liên tiếp. Cần xem lại prompt package hoặc yêu cầu duyệt.`,
      data: { reject_count: mediaRejects },
    });
  }

  logger.logHandoff(
    "Pho phong",
    "NV Media",
    logger.buildHumanMessage(
      "pho_phong",
      "nv_media",
      "media_prepare_revise",
      context.message.slice(0, 80),
    ),
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
        "NV Media chưa tổng hợp được yêu cầu prompt mới.",
        `Lỗi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        "Thử lại bằng cách gửi lại nhận xét sửa ảnh hoặc sửa prompt.",
      ].join("\n"),
      data: { error: mediaPrepareErr.message || String(mediaPrepareErr) },
    });
  }

  logger.logHandoff(
    "NV Media",
    "NV Prompt",
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
        workflowGuidelines: state.global_guidelines || [],
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
        "Không thể sửa prompt media.",
        `Lỗi: ${promptErr.message || promptErr}`,
        "",
        "Thử lại bằng cách gửi lại nhận xét sửa ảnh hoặc sửa prompt.",
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
    logger.buildHumanMessage("nv_prompt", "nv_media", "prompt_back_to_media", route.effectiveType),
  );

  const revisingStartedAt = nowIso();
  const revisingOutputDir = mediaAgent.resolveMediaOutputDir(
    context.openClawHome,
    state.workflow_id,
    mediaStepId,
  );
  const revisingState = saveWorkflow(context.paths, {
    ...state,
    stage: "revising_media",
    revising_started_at: revisingStartedAt,
    revising_output_dir: revisingOutputDir,
    revising_feedback: context.message,
    revising_route: route.effectiveType,
    revising_logo_paths: logoPaths,
    media_request_brief: mediaRequestBrief,
    prompt_package: promptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
  });

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
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
      if (isAsyncStepStillRunningError(transportErr)) {
        startWorkflowStageAutoNotifyWatcher({
          openClawHome: context.openClawHome,
          workflowId: state.workflow_id,
          stage: "awaiting_media_approval",
          sessionKey:
            context.registry.byId.pho_phong?.transport?.sessionKey ||
            buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
          timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
        });
        const waitingState = saveWorkflow(context.paths, {
          ...revisingState,
          stage: "revising_media",
          last_error: "",
        });
        const summary = buildAsyncWaitingSummary("media");
        return buildResult({
          workflowId: state.workflow_id,
          stage: waitingState.stage,
          status: "running",
          summary,
          humanMessage: summary,
          data: { next_expected_action: "wait_media" },
        });
      }
      if (attempt >= maxTransportRetries) {
        saveWorkflow(context.paths, {
          ...revisingState,
          stage: "revising_media",
          last_error: `media_revise transport: ${transportErr.message || transportErr}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "revising_media",
          status: "error",
          summary: [
            "Không thể sửa media.",
            `Lỗi: ${transportErr.message || "Kết nối bị ngắt."}`,
            "",
            "Thử lại bằng cách gửi lại nhận xét sửa ảnh hoặc sửa prompt.",
          ].join("\n"),
          data: { error: transportErr.message || String(transportErr) },
        });
      }
      logger.log("info", `Thử lại lần ${attempt + 1}...`);
    }
  }

  let media;
  try {
    media = mediaAgent.parseMediaResult(reply, route.effectiveType);
  } catch (parseErr) {
    logger.logError("parse_media", parseErr);
    const summary = buildMediaParseFailureSummary({
      reply,
      error: parseErr,
      title: "Bước sửa media chưa có file thật để duyệt.",
      retryHint: "Thử lại bằng cách gửi lại nhận xét sửa ảnh hoặc sửa prompt.",
    });
    saveWorkflow(context.paths, {
      ...revisingState,
      stage: "revising_media",
      last_error: `parse_media: ${parseErr.message}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_media",
      status: "error",
      summary,
      humanMessage: summary,
      data: { error: parseErr.message },
    });
  }
  const guardedMedia = normalizeIncomingMediaForAsyncStage(media, revisingState, {
    kind: "media",
    route: route.effectiveType,
    startedAt: revisingStartedAt,
  });
  if (!guardedMedia) {
    const summary = [
      "Sửa media chưa trả v�? file mới hợp lệ để duyệt.",
      "Hệ thống đã chặn việc trình lại ảnh cũ hoặc ảnh gốc sản phẩm.",
      "",
      "Thử lại bằng cách gửi lại nhận xét sửa ảnh hoặc sửa prompt.",
    ].join("\n");
    saveWorkflow(context.paths, {
      ...revisingState,
      stage: "revising_media",
      last_error: "media_revise returned stale_or_reference_artifact",
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_media",
      status: "error",
      summary,
      humanMessage: summary,
      data: { error: "media_revise returned stale_or_reference_artifact" },
    });
  }
  media = guardedMedia;

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

async function generateVideoFlow(context, state) {
  if (!context.registry.byId.media_video) {
    return buildResult({
      workflowId: state.workflow_id,
      stage: state.stage,
      status: "error",
      summary: [
        "Chua tim thay agent media_video trong runtime registry.",
        "Can them agent media_video vao openclaw config roi chay lai.",
      ].join("\n"),
    });
  }

  const videoRequestStepId = "step_04_video_prepare";
  const promptStepId = "step_05_video_prompt";
  const videoStepId = "step_06_video_generate";
  const logoPaths = resolveWorkflowLogoPaths(context);

  logger.logPhase("TẠO VIDEO", "Phát sinh thêm video quảng cáo theo yêu cầu của Sếp");
  logger.logHandoff(
    "Pho phong",
    "Media_Video",
    logger.buildHumanMessage("pho_phong", "media_video", "video_prepare_prompt", "video"),
  );

  let videoRequestBrief;
  try {
    const videoPrepareReply = await runAgentStep({
      agentId: "media_video",
      sessionKey: context.registry.byId.media_video.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: videoRequestStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: videoAgent.buildVideoPromptRequestPrompt({
        workflowId: state.workflow_id,
        stepId: videoRequestStepId,
        state,
        openClawHome: context.openClawHome,
        logoPaths,
      }),
    });
    videoRequestBrief = videoAgent.parseVideoPromptRequest(videoPrepareReply).request;
  } catch (videoPrepareErr) {
    logger.logError("video_prepare_prompt", videoPrepareErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_publish_decision",
      last_error: `video_prepare_prompt error: ${videoPrepareErr.message || videoPrepareErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_publish_decision",
      status: "error",
      summary: [
        "Media Video chưa tổng hợp được brief để gửi NV Prompt.",
        `Lỗi: ${videoPrepareErr.message || videoPrepareErr}`,
        "",
        'Thử lại: "Tạo video"',
      ].join("\n"),
      data: { error: videoPrepareErr.message || String(videoPrepareErr) },
    });
  }

  logger.logHandoff(
    "Media_Video",
    "NV Prompt",
    logger.buildHumanMessage("media_video", "nv_prompt", "prompt_from_video", "video"),
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
        mediaType: "video",
        openClawHome: context.openClawHome,
        logoPaths,
        mediaRequestBrief: videoRequestBrief,
        workflowGuidelines: state.global_guidelines || [],
      }),
    });
    promptPackage = enforceDefaultVideoPrompt(
      promptAgent.parsePromptResult(promptReply, "video"),
      true,
      logoPaths.length > 0,
    );
    promptVersion = promptAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
      type: "video",
      mode: "draft",
      imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
      videoPrompt: promptPackage.videoPrompt || "",
      promptDecision: "video",
      product_image: state.content?.primaryProductImage || "",
      logo_paths: logoPaths,
      media_request_brief: videoRequestBrief,
    });
  } catch (promptErr) {
    logger.logError("video_prompt_draft", promptErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_publish_decision",
      last_error: `video_prompt_draft error: ${promptErr.message || promptErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_publish_decision",
      status: "error",
      summary: [
        "Không thể tạo video prompt từ NV Prompt.",
        `Lỗi: ${promptErr.message || promptErr}`,
        "",
        'Thử lại: "Tạo video"',
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "Media_Video",
    logger.buildHumanMessage("nv_prompt", "media_video", "prompt_back_to_video", "video"),
  );

  const mergedPromptPackage = {
    ...(state.prompt_package || {}),
    imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
    videoPrompt: promptPackage.videoPrompt || "",
    promptDecision: state.media?.generatedImagePath ? "both" : "video",
  };

  const generatingState = saveWorkflow(context.paths, {
    ...state,
    stage: "generating_video",
    video_generating_started_at: nowIso(),
    video_request_brief: videoRequestBrief,
    video_output_dir: videoAgent.resolveVideoOutputDir(context.openClawHome, state.workflow_id),
    video_generating_logo_paths: logoPaths,
    prompt_package: mergedPromptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
    video_offer_declined: false,
  });

  logger.logHandoff(
    "Pho phong",
    "Media_Video",
    logger.buildHumanMessage("pho_phong", "media_video", "video_generate", "video"),
  );

  let videoReply;
  try {
    videoReply = await runAgentStep({
      agentId: "media_video",
      sessionKey: context.registry.byId.media_video.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: videoStepId,
      timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
      prompt: videoAgent.buildVideoGeneratePrompt({
        workflowId: state.workflow_id,
        stepId: videoStepId,
        state: generatingState,
        openClawHome: context.openClawHome,
        promptPackage: mergedPromptPackage,
        logoPaths,
      }),
    });
  } catch (videoErr) {
    logger.logError("video_generate", videoErr);
    if (isAsyncStepStillRunningError(videoErr)) {
      startWorkflowStageAutoNotifyWatcher({
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stage: "awaiting_video_approval",
        sessionKey:
          context.registry.byId.pho_phong?.transport?.sessionKey ||
          buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
      });
      const waitingState = saveWorkflow(context.paths, {
        ...generatingState,
        stage: "generating_video",
        last_error: "",
      });
      const summary = buildAsyncWaitingSummary("video");
      return buildResult({
        workflowId: state.workflow_id,
        stage: waitingState.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_video" },
      });
    }
    saveWorkflow(context.paths, {
      ...generatingState,
      stage: "awaiting_publish_decision",
      last_error: `video_generate error: ${videoErr.message || videoErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_publish_decision",
      status: "error",
      summary: [
        "Không thể tạo video quảng cáo.",
        `Lỗi: ${videoErr.message || videoErr}`,
        "",
        'Thử lại: "Tạo video"',
      ].join("\n"),
      data: { error: videoErr.message || String(videoErr) },
    });
  }

  let videoMedia;
  try {
    videoMedia = videoAgent.parseVideoResult(videoReply, {
      productImage: generatingState.content?.primaryProductImage || "",
      outputDir:
        generatingState.video_output_dir ||
        videoAgent.resolveVideoOutputDir(context.openClawHome, state.workflow_id),
      logoPaths,
    });
  } catch (parseErr) {
    logger.logError("parse_video", parseErr);
    saveWorkflow(context.paths, {
      ...generatingState,
      stage: "awaiting_publish_decision",
      last_error: `parse_video error: ${parseErr.message || parseErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_publish_decision",
      status: "error",
      summary: [
        "Media Video đã tạo video nhưng hệ thống không đ�?c được kết quả.",
        `Lỗi: ${parseErr.message || parseErr}`,
        "",
        'Thử lại: "Tạo video"',
      ].join("\n"),
      data: { error: parseErr.message || String(parseErr) },
    });
  }

  const mergedMedia = mergeMediaData(state.media, videoMedia, state.content);
  const nextState = saveWorkflow(context.paths, {
    ...generatingState,
    stage: "awaiting_video_approval",
    video_generating_started_at: null,
    media: mergedMedia,
    prompt_package: mergedPromptPackage,
  });

  const summary = buildVideoApprovalSummary({
    media: mergedMedia,
    promptPackage: mergedPromptPackage,
  });

  logger.logApprovalWait("awaiting_video_approval", summary);
  const videoChatPayload = buildVideoChatPayload(mergedMedia.generatedVideoPath);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: {
      media: mergedMedia,
      prompt_package: mergedPromptPackage,
      next_expected_action: "video_approval",
      ...videoChatPayload.data,
    },
    artifacts: videoChatPayload.artifacts,
  });
}

async function reviseVideoFlow(context, state) {
  if (!context.registry.byId.media_video) {
    return buildResult({
      workflowId: state.workflow_id,
      stage: state.stage,
      status: "error",
      summary: "Chua tim thay agent media_video trong runtime registry.",
    });
  }

  const videoRequestStepId = "step_06a_video_prepare_revise";
  const promptStepId = "step_06b_video_prompt_revise";
  const videoStepId = "step_06c_video_revise";
  const logoPaths = resolveWorkflowLogoPaths(context);
  const promptFocused = isPromptFocusedFeedback(context.message);

  logger.logRejected("video", context.message);

  const videoRule = memory.learnFromFeedbackSync(
    "media_video",
    context.openClawHome,
    context.message,
  );
  if (videoRule) {
    const latestRule = videoRule.rules[videoRule.rules.length - 1];
    logger.logLearning("media_video", latestRule?.text || context.message);
  }
  if (promptFocused) {
    const promptRule = memory.learnFromFeedbackSync(
      "nv_prompt",
      context.openClawHome,
      context.message,
    );
    if (promptRule) {
      const latestPromptRule = promptRule.rules[promptRule.rules.length - 1];
      logger.logLearning("nv_prompt", latestPromptRule?.text || context.message);
    }
  }

  state.reject_history = state.reject_history || [];
  state.reject_history.push({
    stage: "video",
    agent: "media_video",
    feedback: context.message,
    timestamp: nowIso(),
  });

  logger.logHandoff(
    "Pho phong",
    "Media_Video",
    logger.buildHumanMessage(
      "pho_phong",
      "media_video",
      "video_prepare_revise",
      context.message.slice(0, 80),
    ),
  );

  let videoRequestBrief;
  try {
    const videoPrepareReply = await runAgentStep({
      agentId: "media_video",
      sessionKey: context.registry.byId.media_video.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: videoRequestStepId,
      timeoutMs: context.options.timeoutMs,
      prompt: videoAgent.buildVideoPromptReviseRequestPrompt({
        workflowId: state.workflow_id,
        stepId: videoRequestStepId,
        state,
        feedback: context.message,
        openClawHome: context.openClawHome,
        logoPaths,
      }),
    });
    videoRequestBrief = videoAgent.parseVideoPromptRequest(videoPrepareReply).request;
  } catch (videoPrepareErr) {
    logger.logError("video_prepare_revise", videoPrepareErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_video_approval",
      last_error: `video_prepare_revise error: ${videoPrepareErr.message || videoPrepareErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_video_approval",
      status: "error",
      summary: [
        "Media Video chưa tổng hợp được yêu cầu prompt mới.",
        `Lỗi: ${videoPrepareErr.message || videoPrepareErr}`,
      ].join("\n"),
      data: { error: videoPrepareErr.message || String(videoPrepareErr) },
    });
  }

  logger.logHandoff(
    "Media_Video",
    "NV Prompt",
    logger.buildHumanMessage("media_video", "nv_prompt", "prompt_from_video", "video"),
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
        mediaType: "video",
        feedback: context.message,
        openClawHome: context.openClawHome,
        logoPaths,
        mediaRequestBrief: videoRequestBrief,
        workflowGuidelines: state.global_guidelines || [],
      }),
    });
    promptPackage = promptAgent.parsePromptResult(promptReply, "video");
    promptVersion = promptAgent.trackPromptVersion(context.paths.baseDir, state.workflow_id, {
      type: "video",
      mode: "revise",
      imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
      videoPrompt: promptPackage.videoPrompt || "",
      promptDecision: state.media?.generatedImagePath ? "both" : "video",
      product_image: state.content?.primaryProductImage || "",
      logo_paths: logoPaths,
      feedback: context.message,
      media_request_brief: videoRequestBrief,
    });
  } catch (promptErr) {
    logger.logError("video_prompt_revise", promptErr);
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_video_approval",
      last_error: `video_prompt_revise error: ${promptErr.message || promptErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_video_approval",
      status: "error",
      summary: ["Không thể sửa video prompt.", `Lỗi: ${promptErr.message || promptErr}`].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "Media_Video",
    logger.buildHumanMessage("nv_prompt", "media_video", "prompt_back_to_video", "video"),
  );

  const mergedPromptPackage = {
    ...(state.prompt_package || {}),
    imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
    videoPrompt: promptPackage.videoPrompt || "",
    promptDecision: state.media?.generatedImagePath ? "both" : "video",
  };

  const revisingState = saveWorkflow(context.paths, {
    ...state,
    stage: "revising_video",
    video_revising_started_at: nowIso(),
    video_output_dir: videoAgent.resolveVideoOutputDir(context.openClawHome, state.workflow_id),
    video_revising_logo_paths: logoPaths,
    video_request_brief: videoRequestBrief,
    prompt_package: mergedPromptPackage,
    prompt_versions: [...(state.prompt_versions || []), promptVersion],
  });

  logger.logHandoff(
    "Pho phong",
    "Media_Video",
    logger.buildHumanMessage(
      "pho_phong",
      "media_video",
      "video_revise",
      context.message.slice(0, 80),
    ),
  );

  let videoReply;
  try {
    videoReply = await runAgentStep({
      agentId: "media_video",
      sessionKey: context.registry.byId.media_video.transport.sessionKey,
      openClawHome: context.openClawHome,
      workflowId: state.workflow_id,
      stepId: videoStepId,
      timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
      prompt: videoAgent.buildVideoRevisePrompt({
        workflowId: state.workflow_id,
        stepId: videoStepId,
        state: revisingState,
        feedback: context.message,
        openClawHome: context.openClawHome,
        promptPackage: mergedPromptPackage,
        logoPaths,
      }),
    });
  } catch (videoErr) {
    logger.logError("video_revise", videoErr);
    if (isAsyncStepStillRunningError(videoErr)) {
      startWorkflowStageAutoNotifyWatcher({
        openClawHome: context.openClawHome,
        workflowId: state.workflow_id,
        stage: "awaiting_video_approval",
        sessionKey:
          context.registry.byId.pho_phong?.transport?.sessionKey ||
          buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
      });
      const waitingState = saveWorkflow(context.paths, {
        ...revisingState,
        stage: "revising_video",
        last_error: "",
      });
      const summary = buildAsyncWaitingSummary("video");
      return buildResult({
        workflowId: state.workflow_id,
        stage: waitingState.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_video" },
      });
    }
    saveWorkflow(context.paths, {
      ...revisingState,
      stage: "awaiting_video_approval",
      last_error: `video_revise error: ${videoErr.message || videoErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_video_approval",
      status: "error",
      summary: ["Không thể sửa video quảng cáo.", `Lỗi: ${videoErr.message || videoErr}`].join(
        "\n",
      ),
      data: { error: videoErr.message || String(videoErr) },
    });
  }

  let videoMedia;
  try {
    videoMedia = videoAgent.parseVideoResult(videoReply, {
      productImage: revisingState.content?.primaryProductImage || "",
      outputDir:
        revisingState.video_output_dir ||
        videoAgent.resolveVideoOutputDir(context.openClawHome, state.workflow_id),
      logoPaths,
    });
  } catch (parseErr) {
    logger.logError("parse_video_revise", parseErr);
    saveWorkflow(context.paths, {
      ...revisingState,
      stage: "awaiting_video_approval",
      last_error: `parse_video_revise error: ${parseErr.message || parseErr}`,
    });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_video_approval",
      status: "error",
      summary: [
        "Media Video đã tạo video mới nhưng hệ thống không đ�?c được kết quả.",
        `Lỗi: ${parseErr.message || parseErr}`,
      ].join("\n"),
      data: { error: parseErr.message || String(parseErr) },
    });
  }

  const mergedMedia = mergeMediaData(state.media, videoMedia, state.content);
  const nextState = saveWorkflow(context.paths, {
    ...revisingState,
    stage: "awaiting_video_approval",
    video_revising_started_at: null,
    media: mergedMedia,
    prompt_package: mergedPromptPackage,
  });

  const summary = buildVideoApprovalSummary({
    media: mergedMedia,
    promptPackage: mergedPromptPackage,
  });
  const videoChatPayload = buildVideoChatPayload(mergedMedia.generatedVideoPath);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: {
      media: mergedMedia,
      prompt_package: mergedPromptPackage,
      next_expected_action: "video_approval",
      ...videoChatPayload.data,
    },
    artifacts: videoChatPayload.artifacts,
  });
}

function askPublishDecision(context, state) {
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_publish_decision",
  });

  const summary = buildPublishDecisionSummary(nextState);

  logger.logApprovalWait("awaiting_publish_decision", summary);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: { next_expected_action: "publish_decision" },
  });
}

function buildPublishFailureSummary(actionLabel, error) {
  const errorMessage = String(error?.message || error || "Unknown publish error").trim();
  const isPermissionError = /\(#200\)|permissions error/i.test(errorMessage);

  const summaryLines = [`${actionLabel} thất bại trên Facebook.`, `Lỗi: ${errorMessage}`];

  if (isPermissionError) {
    summaryLines.push(
      "Gợi ý: Kiểm tra FACEBOOK_PAGE_ACCESS_TOKEN có đúng với FACEBOOK_PAGE_ID và có quy�?n pages_manage_posts/pages_read_engagement.",
    );
  }

  summaryLines.push(
    'Thử lại: "�?ăng ngay" hoặc "Hẹn gi�? <th�?i gian>" sau khi cập nhật quy�?n/token.',
  );
  return summaryLines.join("\n");
}

function enforceDefaultVideoPrompt(promptPackage, forceTemplate = false, includeLogo = true) {
  if (!promptPackage || !forceTemplate) {
    return promptPackage;
  }
  const videoPrompt = includeLogo
    ? DEFAULT_VIDEO_PROMPT_TEMPLATE
    : String(DEFAULT_VIDEO_PROMPT_TEMPLATE || "")
        .split(/\r?\n/)
        .filter((line) => !/logo/i.test(line))
        .join("\n");
  return {
    ...promptPackage,
    videoPrompt,
  };
}

/**
 * Ä�?Äƒng bÃ i ngay.
 */
function publishNowAction(context, state) {
  logger.logPhase("�?ăng bài", "�?ang đăng bài lên Fanpage...");

  const mediaPaths = [];
  if (state.media?.generatedImagePath) mediaPaths.push(state.media.generatedImagePath);
  if (state.media?.generatedVideoPath) mediaPaths.push(state.media.generatedVideoPath);

  let publishResult;
  try {
    publishResult = publisher.publishNow({
      content: state.content.approvedContent,
      mediaPaths,
    });
  } catch (publishError) {
    logger.logError("publish", publishError);
    const failedState = saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_publish_decision",
      last_error: `publish_now error: ${publishError.message || publishError}`,
    });
    const summary = buildPublishFailureSummary("�?ăng ngay", publishError);
    return buildResult({
      workflowId: state.workflow_id,
      stage: failedState.stage,
      status: "error",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "publish_decision" },
    });
  }

  const canonicalPublish = publisher.extractCanonicalPublishResult(publishResult);
  const postIds = canonicalPublish.postIds;
  const postId = canonicalPublish.postId;

  const publishState = {
    ...state,
    status: "completed",
    stage: "published",
    publish: publishResult,
    publish_canonical: canonicalPublish,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, publishState);

  logger.logPublished(postId);

  const canonicalPublishedSummary = buildPublishSuccessSummary("publish", canonicalPublish);

  return buildResult({
    workflowId: state.workflow_id,
    stage: "published",
    summary: canonicalPublishedSummary,
    humanMessage: canonicalPublishedSummary,
    data: {
      status: canonicalPublish.status,
      page_id: canonicalPublish.pageId,
      page_ids: canonicalPublish.pageIds,
      post_id: postId,
      post_ids: postIds,
      permalink: canonicalPublish.permalink,
      publish_canonical: canonicalPublish,
      publish_result: publishResult,
    },
  });

  const summary = [
    "Bài viết đã được đăng thành công lên Fanpage",
    postIds.length > 1 ? `ID bài viết: ${postIds.join(", ")}` : postId ? `ID bài viết: ${postId}` : "",
    `Media: ${mediaPaths.join(", ") || "không có"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const normalizedSummary = normalizePublishedSummaryText(summary);
  const publishedSummary = [
    "Bài viết đã được đăng thành công lên Fanpage",
    postIds.length > 1 ? `ID bài viết: ${postIds.join(", ")}` : postId ? `ID bài viết: ${postId}` : "",
    `Media: ${mediaPaths.join(", ") || "không có"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "published",
    summary: normalizedSummary || publishedSummary,
    humanMessage: normalizedSummary || publishedSummary,
    data: {
      post_id: postId,
      post_ids: postIds,
      media_paths: mediaPaths,
      publish_result: publishResult,
    },
  });
}

/**
 * Háº¹n giá»  Ä‘Äƒng bÃ i.
 */
function schedulePostAction(context, state) {
  const scheduleTime = state.intent?.schedule_time || context.scheduleTime || context.message;

  logger.logPhase("HẸN GIỜ", `�?ang hẹn gi�? đăng bài: ${scheduleTime}`);

  const mediaPaths = [];
  if (state.media?.generatedImagePath) mediaPaths.push(state.media.generatedImagePath);
  if (state.media?.generatedVideoPath) mediaPaths.push(state.media.generatedVideoPath);

  let scheduleResult;
  try {
    scheduleResult = publisher.schedulePost({
      content: state.content.approvedContent,
      mediaPaths,
      scheduleTime,
    });
  } catch (scheduleError) {
    logger.logError("schedule", scheduleError);
    const failedState = saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_publish_decision",
      last_error: `schedule_post error: ${scheduleError.message || scheduleError}`,
    });
    const summary = buildPublishFailureSummary("Hẹn gi�? đăng bài", scheduleError);
    return buildResult({
      workflowId: state.workflow_id,
      stage: failedState.stage,
      status: "error",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "publish_decision" },
    });
  }

  const canonicalSchedule = publisher.extractCanonicalPublishResult(scheduleResult);
  const postIds = canonicalSchedule.postIds;
  const postId = canonicalSchedule.postId;

  const schedState = {
    ...state,
    status: "completed",
    stage: "scheduled",
    publish: scheduleResult,
    publish_canonical: canonicalSchedule,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, schedState);

  logger.logScheduled(scheduleTime);

  const scheduledSummary = buildPublishSuccessSummary("schedule", canonicalSchedule, scheduleTime);

  return buildResult({
    workflowId: state.workflow_id,
    stage: "scheduled",
    summary: scheduledSummary,
    humanMessage: scheduledSummary,
    data: {
      status: canonicalSchedule.status,
      page_id: canonicalSchedule.pageId,
      page_ids: canonicalSchedule.pageIds,
      post_id: postId,
      post_ids: postIds,
      permalink: canonicalSchedule.permalink,
      schedule_time: scheduleTime,
      schedule_canonical: canonicalSchedule,
      schedule_result: scheduleResult,
    },
  });

  const summary = [
    "Bài viết đã được hẹn gi�? đăng thành công!",
    `Th�?i gian: ${scheduleTime}`,
    postIds.length > 1 ? `ID bài viết: ${postIds.join(", ")}` : postId ? `ID bài viết: ${postId}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "scheduled",
    summary,
    humanMessage: summary,
    data: {
      post_id: postId,
      post_ids: postIds,
      schedule_time: scheduleTime,
      schedule_result: scheduleResult,
    },
  });
}

/**
 * Sá»­a bÃ i Ä‘Ã£ Ä‘Äƒng (EDIT_PUBLISHED intent).
 */
async function editPublishedFlow(context) {
  let workflowId = `wf_edit_${randomUUID()}`;
  
  // Try to find the latest frontend automation conversation so events sync back
  try {
    const res = await fetch("http://localhost:3001/api/conversations/pho_phong?includeAutomation=1");
    if (res.ok) {
      const convs = await res.json();
      const latestAuto = convs.find(c => c.id && c.id.startsWith("auto_wf_"));
      if (latestAuto) {
        workflowId = latestAuto.id;
      }
    }
  } catch (e) {
    // fallback
  }

  const stepId = "step_edit_content";
  const postId = context.intent?.post_id;
  logger.setSyncContext({
    workflowId,
    employeeId: context.options?.from || "pho_phong",
    agentId: context.options?.from || "pho_phong",
    title: `[AUTO] ${context.options?.from || "pho_phong"} • ${workflowId}`,
  });

  if (!postId) {
    return buildResult({
      status: "blocked",
      summary:
        'Cần cung cấp Post ID của bài viết muốn sửa. Ví dụ: "Sửa bài đã đăng, post ID: 643048852218433_123456"',
    });
  }

  logger.logPhase("SỬA BÀI �?Ã �?ĂNG", `ID bài viết: ${postId}`);
  logger.logHandoff(
    "Phó phòng",
    "NV Content",
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

  const contentCheckpoint = await runContentCheckpointStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId,
    stepId,
    timeoutMs: getContentTimeoutMs(context.options.timeoutMs),
    prompt,
  });
  const content = contentCheckpoint.content;

  // LÆ°u state chá»�? duyá»‡t ná»™i dung má»›i trÆ°á»›c khi update lÃªn FB
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
    "NV Content đã viết nội dung mới cho bài đã đăng, đang ch�? Sếp duyệt.",
    `ID bài viết sẽ cập nhật: ${postId}`,
    "",
    "NỘI DUNG MỚI",
    content.approvedContent,
    "",
    'Duyệt: "Duyệt content" â€�? nội dung sẽ được cập nhật lên Facebook',
    "Sửa: ghi rõ nhận xét",
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
 * Xá»­ lÃ½ approve cho bÃ i edit â†’ gá» i facebook_edit_post.
 */
function applyEditToPublished(context, state) {
  const postId = state.post_id;

  logger.logPhase("Cập nhật bài đã đăng", `�?ang cập nhật post ${postId}...`);

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
    "Bài viết trên Facebook đã được cập nhật thành công!",
    `ID bài viết: ${postId}`,
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
 * Xá»­ lÃ½ intent TRAIN â€�? ghi quy táº¯c thá»§ cÃ´ng.
 */
function handleTrainIntent(context) {
  const feedback = context.intent?.feedback_or_brief || context.message;
  const targetAgent = context.intent?.target_agent;

  logger.logPhase("TRAINING", `Sếp dạy quy tắc mới`);

  const results = [];

  // Ghi rule cho agent được chỉ định, hoặc cả hai nếu "self"
  const agents =
    targetAgent === "nv_content"
      ? ["nv_content"]
      : targetAgent === "nv_media"
        ? ["nv_media"]
        : targetAgent === "media_video"
          ? ["media_video"]
          : targetAgent === "nv_prompt"
            ? ["nv_prompt"]
            : ["nv_content", "nv_prompt", "nv_media", "media_video"];

  for (const agentId of agents) {
    memory.appendRule(agentId, context.openClawHome, feedback);
    logger.logLearning(agentId, feedback);
    results.push(agentId);
  }

  const summary = [
    "�?ã ghi nhớ quy tắc mới!",
    `�?p dụng cho: ${results.join(", ")}`,
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

// â�?€â�?€â�?€ MAIN ROUTING â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

/**
 * Xá»­ lÃ½ workflow Ä‘ang pending.
 */
async function continueWorkflow(context, state) {
  const stateBeforeMigration = JSON.stringify(state || {});
  state = migrateState(state);
  if (
    context.paths?.currentFile &&
    state &&
    JSON.stringify(state) !== stateBeforeMigration
  ) {
    state = saveWorkflow(context.paths, state);
  }
  const mergedGuidelines = mergeWorkflowGuidelines(state.global_guidelines || [], context.message);
  if ((state.global_guidelines || []).join("\n") !== mergedGuidelines.join("\n")) {
    state = saveWorkflow(context.paths, {
      ...state,
      global_guidelines: mergedGuidelines,
    });
  }
  const decision = intentParser.classifyPendingDecision(context.message, state.stage);
  if (context.intent?.intent === "TRAIN" && decision === "unknown") {
    const summary = [
      "Da ghi nho guideline moi cho workflow hien tai.",
      "",
      ...(state.global_guidelines || []).map((item) => `- ${item}`),
      "",
      buildStageHumanMessage(state) || buildBlockedResult(state, context.message).human_message,
    ]
      .filter(Boolean)
      .join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: state.stage,
      summary,
      humanMessage: summary,
      data: { global_guidelines: state.global_guidelines || [] },
    });
  }

  if (state.stage === "generating_content") {
    const stepId = state.content_step_id || "step_01_content";
    const contentCheckpoint = await recoverContentCheckpointFromHistory({
      agentId: "nv_content",
      sessionKey: context.registry?.byId?.nv_content?.transport?.sessionKey || "",
      openClawHome: context.openClawHome,
      rootConversationId: state.rootConversationId || null,
      workflowId: state.workflow_id,
      stepId,
    });

    if (contentCheckpoint) {
      const content = enrichContentReviewMedia(context.paths, state.workflow_id, contentCheckpoint.content);
      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_content_approval",
        content_started_at: null,
        content,
      });
      const summary = [
        "NV Content đã viết xong bài nháp, đang ch�? Sếp duyệt.",
        content.productName ? `Sản phẩm: ${content.productName}` : "",
        "",
        "NỘI DUNG CHỜ DUYỆT",
        content.approvedContent,
        'Duyệt: "Duyệt content, tạo ảnh"',
        'Sửa: "Sửa content, <nhận xét>"',
        getContentReviewImage(content) ? "" : "",
        getContentReviewImage(content) ? "Ảnh gốc sản phẩm để đối chiếu:" : "",
        buildMediaDirective(getContentReviewImage(content)),
      ]
        .filter(Boolean)
        .join("\n");

      await syncApprovalCheckpoint({
        workflowId: state.workflow_id,
        paths: context.paths,
        rootConversationId: state.rootConversationId || null,
        managerId: context.options.from || "pho_phong",
        stage: nextState.stage,
        title: `[AUTO] ${context.options.from || "pho_phong"} - ${state.workflow_id}`,
        content: buildContentApprovalCheckpointMessage({
          productName: content.productName,
          approvedContent: content.approvedContent,
          primaryProductImage: content.primaryProductImage,
          primaryProductReviewImage: content.primaryProductReviewImage,
          rawReply: content.reply,
          revised: false,
        }),
        eventId: `${state.workflow_id}:awaiting_content_approval:content`,
      });

      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { content, next_expected_action: "content_approval" },
      });
    }

    const summary = [
      "Hệ thống đang đợi NV Content trả v�? bản nháp hợp lệ.",
      "",
      "Tôi sẽ tiếp tục theo dõi và trình content ngay khi có checkpoint.",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: state.stage,
      status: "running",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "wait_content" },
    });
  }

  if (state.stage === "revising_video") {
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_video_approval") {
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (
      !hasAsyncStageExceededGrace(
        state.video_revising_started_at,
        getMediaTimeoutMs(context.options.timeoutMs),
      )
    ) {
      const summary = buildAsyncWaitingSummary("video");
      return buildResult({
        workflowId: state.workflow_id,
        stage: state.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_video" },
      });
    }

    saveWorkflow(context.paths, { ...state, stage: "revising_video" });
    const summary = buildAsyncWaitingSummary("video");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_video",
      status: "running",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "wait_video" },
    });
  }

  if (state.stage === "generating_video") {
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_video_approval") {
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (
      !hasAsyncStageExceededGrace(
        state.video_generating_started_at,
        getMediaTimeoutMs(context.options.timeoutMs),
      )
    ) {
      const summary = buildAsyncWaitingSummary("video");
      return buildResult({
        workflowId: state.workflow_id,
        stage: state.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_video" },
      });
    }

    saveWorkflow(context.paths, { ...state, stage: "generating_video" });
    const summary = buildAsyncWaitingSummary("video");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "generating_video",
      status: "running",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "wait_video" },
    });
  }

  if (state.stage === "revising_media") {
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_media_approval") {
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (
      !hasAsyncStageExceededGrace(
        state.revising_started_at,
        getMediaTimeoutMs(context.options.timeoutMs),
      )
    ) {
      const summary = buildAsyncWaitingSummary("media");
      return buildResult({
        workflowId: state.workflow_id,
        stage: state.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_media" },
      });
    }

    saveWorkflow(context.paths, { ...state, stage: "revising_media" });
    const summary = buildAsyncWaitingSummary("media");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "revising_media",
      status: "running",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "wait_media" },
    });
  }

  if (state.stage === "generating_media") {
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_media_approval") {
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (
      !hasAsyncStageExceededGrace(
        state.generating_started_at,
        getMediaTimeoutMs(context.options.timeoutMs),
      )
    ) {
      const summary = buildAsyncWaitingSummary("media");
      return buildResult({
        workflowId: state.workflow_id,
        stage: state.stage,
        status: "running",
        summary,
        humanMessage: summary,
        data: { next_expected_action: "wait_media" },
      });
    }

    saveWorkflow(context.paths, {
      ...state,
      stage: "generating_media",
    });
    const summary = [
      "Hệ thống vẫn đang render media, chưa thấy file media mới.",
      "",
      "Tôi sẽ tiếp tục đợi và gửi ảnh ngay khi có kết quả.",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "generating_media",
      status: "running",
      summary,
      humanMessage: summary,
    });
  }

  if (state.stage === "revising_media") {
    // Phá»¥c há»“i sau crash cá»§a reviseMedia: tÃ¬m áº£nh má»›i nháº¥t (khÃ´ng pháº£i screenshot/final cÅ©)
    const imagesDir = path.join(context.openClawHome, "workspace_media", "artifacts", "images");
    const currentBg = state.media?.generatedImagePath || "";
    let latestImage = "";
    try {
      if (fs.existsSync(imagesDir)) {
        const files = fs
          .readdirSync(imagesDir)
          .filter((f) => {
            if (f.includes("-before-") || f.includes("-after-") || f.includes("_final"))
              return false;
            if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) return false;
            // Bá»�? file cÅ© náº¿u Ä‘Æ°á»£ng dáº«n khá»›p vá»›i ná»�?n cÅ© (trÆ°á»›c khi revise)
            const fullPath = path.join(imagesDir, f);
            if (currentBg && path.resolve(fullPath) === path.resolve(currentBg)) return false;
            return true;
          })
          .map((f) => ({ f, t: fs.statSync(path.join(imagesDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) latestImage = path.join(imagesDir, files[0].f);
      }
    } catch {
      /* ignore */
    }

    if (latestImage) {
      logger.log("media", `Phục hồi ảnh sửa từ lượt trước: ${latestImage}`);
      let finalPath = latestImage;
      if (state.content?.primaryProductImage) {
        try {
          const compositePath = await mediaAgent.compositeImage3Layers({
            backgroundPath: latestImage,
            productImagePath: state.content.primaryProductImage,
            outputPath: latestImage.replace(/(\.[a-z]+)$/i, "_final$1"),
          });
          finalPath = compositePath;
        } catch (e) {
          logger.logError("composite", e);
        }
      }
      const recoveredMedia = {
        generatedImagePath: finalPath,
        mediaType: "image",
        imagePrompt: state.media?.imagePrompt || "(phá»¥c há»“i sau sá»­a)",
        composited: finalPath !== latestImage,
      };
      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });
      const finalLink = `file:///${finalPath.replace(/\\/g, "/")}`;
      const summary = [
        "�?ã phục hồi ảnh sửa từ lượt trước, đang ch�? Sếp duyệt.",
        recoveredMedia.composited ? "�?ã ghép: N�?n AI mới + Sản phẩm thật + Logo" : "",
        "",
        `Xem ảnh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        'Duyệt và đăng bài: "Duyệt ảnh và đăng bài"',
        "Sửa tiếp: ghi rõ nhận xét",
      ]
        .filter(Boolean)
        .join("\n");
      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { media: recoveredMedia, next_expected_action: "media_approval" },
      });
    }

    // Không có ảnh mới â€�? quay lại awaiting_media_approval với ảnh cũ
    saveWorkflow(context.paths, { ...state, stage: "awaiting_media_approval" });
    const summary = [
      "Bước sửa ảnh bị ngắt giữa chừng, chưa có ảnh mới.",
      "",
      "Nhấn lại nhận xét để thử sửa ảnh lần nữa",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary,
      humanMessage: summary,
    });
  }

  // generating_media â€�? Ä�?ang táº¡o áº£nh, cháº·n loop.
  // Stage nÃ y Ä‘Æ°á»£c set ngay trÆ°á»›c khi gá»�?i NV Media. Náº¿u orchestrator
  // crash sau khi cÃ³ áº£nh nhÆ°ng trÆ°á»›c khi save, láº§n sau sáº½ vÃ o bá»™ nÃ y.
  if (state.stage === "generating_media") {
    // Æ¯u tiÃªn dÃ¹ng Ä‘Æ°á»�?ng dáº«n Ä‘Ã£ lÆ°u trong state (chÃ­nh xÃ¡c, khÃ´ng nháº§m workflow cÅ©)
    const savedBg = state.generating_bg_image_path || "";
    const savedProduct =
      state.generating_product_image_path || state.content?.primaryProductImage || "";

    let bgImagePath = "";
    if (savedBg && fs.existsSync(savedBg)) {
      bgImagePath = savedBg;
      logger.log("media", `Dùng path n�?n đã lưu trong state: ${bgImagePath}`);
    } else {
      // Fallback: scan thư mục, chỉ lấy ảnh được tạo sau khi bắt đầu workflow
      const imagesDir = path.join(context.openClawHome, "workspace_media", "artifacts", "images");
      const startedAt = state.generating_started_at
        ? new Date(state.generating_started_at).getTime()
        : 0;
      try {
        if (fs.existsSync(imagesDir)) {
          const files = fs
            .readdirSync(imagesDir)
            .filter((f) => {
              if (f.includes("-before-") || f.includes("-after-") || f.includes("_final"))
                return false;
              if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) return false;
              const fullPath = path.join(imagesDir, f);
              const mtime = fs.statSync(fullPath).mtimeMs;
              return mtime >= startedAt; // chá»‰ láº¥y file má»›i hÆ¡n thá»�?i Ä‘iá»ƒm báº¯t Ä‘áº§u
            })
            .map((f) => ({ f, t: fs.statSync(path.join(imagesDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          if (files.length > 0) bgImagePath = path.join(imagesDir, files[0].f);
        }
      } catch {
        /* ignore */
      }
    }

    if (bgImagePath) {
      logger.log("media", `Phục hồi: chạy lại composite với n�?n: ${bgImagePath}`);
      let finalPath = bgImagePath;
      if (savedProduct && fs.existsSync(savedProduct)) {
        try {
          const compositePath = await mediaAgent.compositeImage3Layers({
            backgroundPath: bgImagePath,
            productImagePath: savedProduct,
            outputPath: bgImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
          });
          finalPath = compositePath;
          logger.log("media", `Ghép 3 lớp thành công: ${compositePath}`);
        } catch (compErr) {
          if (logger.isEnabled()) {
            process.stderr.write(
              `[COMPOSITE_RECOVERY_ERROR] ${compErr.stack || compErr.message}\n`,
            );
          }
          logger.logError("composite", compErr);
          logger.log("info", "Dùng ảnh n�?n gốc (composite thất bại).");
        }
      }

      const recoveredMedia = {
        generatedImagePath: finalPath,
        mediaType: "image",
        imagePrompt: state.media?.imagePrompt || "(phá»¥c há»“i)",
        composited: finalPath !== bgImagePath,
      };

      const nextState = saveWorkflow(context.paths, {
        ...state,
        stage: "awaiting_media_approval",
        media: recoveredMedia,
      });

      const finalLink = `file:///${finalPath.replace(/\\/g, "/")}`;
      const summary = [
        "�?ã ghép xong ảnh, đang ch�? Sếp duyệt.",
        recoveredMedia.composited
          ? "�?ã ghép: N�?n AI + Sản phẩm thật + Logo"
          : "Chỉ có ảnh n�?n AI (chưa ghép sản phẩm).",
        "",
        `Xem ảnh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        'Duyệt và đăng bài: "Duyệt ảnh và đăng bài"',
        "ðŸ‘‰ Sá»­a áº£nh: ghi rÃµ nháº­n xÃ©t",
      ]
        .filter(Boolean)
        .join("\n");

      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { media: recoveredMedia, next_expected_action: "media_approval" },
      });
    }

    // KhÃ´ng tÃ¬m tháº¥y áº£nh nÃ o â€�? quay vá»�? step trÆ°á»›c, cho phÃ©p re-trigger
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
    });
    const noImgSummary = [
      "Bước tạo ảnh bị ngắt giữa chừng, chưa có file ảnh nào.",
      "",
      'Thử lại: "Duyệt content, tạo ảnh"',
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
      rememberApprovedContent(state, context.openClawHome);
      return generateMediaFlow(context, state);
    }
    if (decision === "reject") {
      return reviseContent(context, state);
    }
    // Unknown â€�? thá»­ parse intent náº¿u lÃ  lá»‡nh má»›i hoÃ n toÃ n
    return buildBlockedResult(state, context.message);
  }

  // awaiting_media_approval
  if (state.stage === "awaiting_media_approval") {
    if (context.intent?.intent === "EDIT_CONTENT") {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
    }
    if (decision === "generate_video") {
      logger.logApproved("media");
      rememberApprovedPrompt(state, context.openClawHome, "image");
      return generateVideoFlow(context, state);
    }
    if (decision === "approve") {
      logger.logApproved("media");
      rememberApprovedPrompt(state, context.openClawHome, "image");
      return askPublishDecision(context, state);
    }
    if (decision === "reject") {
      return reviseMediaFlow(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  if (state.stage === "awaiting_video_approval") {
    if (context.intent?.intent === "EDIT_CONTENT") {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
    }
    if (context.intent?.intent === "EDIT_MEDIA" && context.intent?.target_agent === "nv_media") {
      return reviseMediaFlow(context, { ...state, stage: "awaiting_media_approval" });
    }
    if (decision === "approve") {
      logger.logApproved("video");
      rememberApprovedPrompt(state, context.openClawHome, "video");
      return askPublishDecision(context, state);
    }
    if (decision === "reject") {
      return reviseVideoFlow(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  // awaiting_publish_decision
  if (state.stage === "awaiting_publish_decision") {
    if (context.intent?.intent === "EDIT_CONTENT") {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
    }
    if (
      context.intent?.intent === "EDIT_MEDIA" &&
      ["nv_media", "nv_prompt"].includes(context.intent?.target_agent)
    ) {
      return reviseMediaFlow(context, { ...state, stage: "awaiting_media_approval" });
    }
    if (context.intent?.intent === "EDIT_MEDIA" && context.intent?.target_agent === "media_video") {
      return reviseVideoFlow(context, { ...state, stage: "awaiting_video_approval" });
    }
    if (decision === "generate_video") {
      return generateVideoFlow(context, state);
    }
    if (decision === "skip_video") {
      const nextState = saveWorkflow(context.paths, {
        ...state,
        video_offer_declined: true,
      });
      const summary = buildPublishDecisionSummary(nextState);
      return buildResult({
        workflowId: state.workflow_id,
        stage: nextState.stage,
        summary,
        humanMessage: summary,
        data: { next_expected_action: "publish_decision" },
      });
    }
    if (decision === "publish_now") {
      return publishNowAction(context, state);
    }
    if (decision === "schedule") {
      // TrÃ­ch schedule time tá»« message
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
    if (
      decision === "approve" ||
      intentParser.classifyPendingDecision(context.message, "awaiting_content_approval") ===
        "approve"
    ) {
      return applyEditToPublished(context, state);
    }
    if (
      decision === "reject" ||
      intentParser.classifyPendingDecision(context.message, "awaiting_content_approval") ===
        "reject"
    ) {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
    }
    return buildBlockedResult(state, context.message);
  }

  // Unknown stage â€�? archive and restart
  archiveWorkflow(context.paths, state);
  return startNewWorkflow(context);
}

function buildBlockedResult(state, message) {
  const stage = state?.stage || null;
  const cleanStageLabels = {
    awaiting_content_approval: "Đang chờ duyệt content",
    awaiting_media_approval: "Đang chờ duyệt media",
    awaiting_video_approval: "Đang chờ duyệt video",
    awaiting_publish_decision: "Đang chờ quyết định đăng bài",
    awaiting_edit_approval: "Đang chờ duyệt nội dung sửa",
    generating_media: "Đang tạo ảnh (vui lòng đợi)",
    revising_media: "Đang sửa ảnh (vui lòng đợi)",
    generating_video: "Đang tạo video (vui lòng đợi)",
    revising_video: "Đang sửa video (vui lòng đợi)",
  };
  const cleanStageLabel = cleanStageLabels[stage] || "Đang chờ xử lý";
  const cleanHint =
    stage === "awaiting_content_approval"
      ? '  - "Duyệt content, tạo ảnh" / "Tạo lại ảnh" / "Sửa content, <nhận xét>"'
      : stage === "awaiting_media_approval"
        ? '  - "Duyệt ảnh" / "Sửa ảnh, <nhận xét>" / "Sửa prompt, <nhận xét>"'
        : stage === "awaiting_video_approval"
          ? '  - "Duyệt video" / "Sửa video, <nhận xét>" / "Sửa prompt video, <nhận xét>"'
          : stage === "awaiting_publish_decision"
            ? '  - "Tạo video" / "Đăng ngay" / "Hẹn giờ <thời gian>"'
            : '  - "Duyệt" / "Sửa"';

  return buildResult({
    workflowId: state?.workflow_id || null,
    stage,
    status: "blocked",
    summary: [
      `Đang có workflow pending: ${cleanStageLabel}.`,
      `Tin nhắn "${String(message || "").slice(0, 100)}" chưa được nhận diện rõ.`,
      "",
      "Gợi ý lệnh phù hợp:",
      cleanHint,
    ].join("\n"),
    data: { expected_stage: stage },
  });

  const stageLabels = {
    awaiting_content_approval: "�?ang ch�? duyệt content",
    awaiting_media_approval: "�?ang ch�? duyệt media",
    awaiting_video_approval: "�?ang ch�? duyệt video",
    awaiting_publish_decision: "�?ang ch�? quyết định đăng bài",
    awaiting_edit_approval: "�?ang ch�? duyệt nội dung sửa",
    generating_media: "�?ang tạo ảnh (vui lòng đợi)",
    generating_video: "�?ang tạo video (vui lòng đợi)",
    revising_video: "�?ang sửa video (vui lòng đợi)",
  };
  const stageLabel = stageLabels[state?.stage] || "�?ang ch�? xử lý";

  return buildResult({
    workflowId: state?.workflow_id || null,
    stage: state?.stage || null,
    status: "blocked",
    summary: [
      `�?ang có workflow pending: ${stageLabel}.`,
      `Tin nhắn "${message.slice(0, 100)}" chưa được nhận diện rõ.`,
      "",
      "Gợi ý lệnh phù hợp:",
      state?.stage === "awaiting_content_approval"
        ? '  - "Duyệt content" / "Sửa content, <nhận xét>"'
        : state?.stage === "awaiting_media_approval"
          ? '  - "Duyệt ảnh" / "Sửa ảnh, <nhận xét>" / "Sửa prompt, <nhận xét>"'
          : state?.stage === "awaiting_video_approval"
            ? '  - "Duyệt video" / "Sửa video, <nhận xét>" / "Sửa prompt video, <nhận xét>"'
            : state?.stage === "awaiting_publish_decision"
              ? '  - "Tạo video" / "�?ăng ngay" / "Hẹn gi�? <th�?i gian>"'
              : '  - "Duyệt" / "Sửa"',
    ].join("\n"),
    data: { expected_stage: state?.stage || null },
  });
}

// â�?€â�?€â�?€ CLI ENTRY POINT â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  logger.setEnabled(!options.json);
  if (options.autoNotifyWatch) {
    await runAutoNotifyWatcher(options);
    return;
  }
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const workspaceDir = getPhoPhongWorkspace(config, openClawHome);
  const paths = buildPaths(workspaceDir, options.managerInstanceId);

  // Reset command
  if (options.reset) {
    if (fs.existsSync(paths.currentFile)) {
      const current = readJsonIfExists(paths.currentFile, {});
      archiveWorkflow(paths, current);
    }
    printResult(
      buildResult({
        status: "reset",
        summary: "�?ã reset workflow pending của agent-orchestrator-test.",
        humanMessage: "�?ã reset workflow pending.",
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
  if (
    !registry.byId.pho_phong ||
    !registry.byId.nv_content ||
    !registry.byId.nv_prompt ||
    !registry.byId.nv_media
  ) {
    throw new Error(
      "Missing required agents pho_phong / nv_content / nv_prompt / nv_media in runtime registry.",
    );
  }

  const currentState = readJsonIfExists(paths.currentFile, null);

  // Parse intent náº¿u khÃ´ng cÃ³ workflow pending
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
    managerInstanceId: currentState?.managerInstanceId || options.managerInstanceId || null,
  };

  let result;

  // Xu ly lenh HUY/RESET truoc tat ca logic khac de tranh tao workflow moi nham.
  if (isExplicitWorkflowResetMessage(message)) {
    if (currentState) {
      logger.log("info", `Nhan lenh huy - archive workflow ${currentState.workflow_id}.`);
      archiveWorkflow(paths, currentState);
      result = buildResult({
        workflowId: currentState.workflow_id,
        status: "reset",
        summary: "�?ã hủy workflow đang pending.",
        humanMessage:
          "Workflow đã được hủy thành công. Bạn có thể bắt đầu brief mới bất cứ lúc nào.",
      });
    } else {
      result = buildResult({
        status: "ok",
        summary: "Không có workflow đang chạy.",
        humanMessage:
          "Hiện không có workflow nào đang pending. Bạn có thể gửi brief mới để bắt đầu.",
      });
    }
  } else if (currentState && shouldSupersedePendingWorkflow(message, currentState, intent)) {
    logger.log("info", `Phat hien brief moi, archive workflow cu ${currentState.workflow_id}.`);
    archiveWorkflow(paths, currentState);
    result = await startNewWorkflow({
      ...context,
      intent,
      supersededWorkflowId: currentState.workflow_id,
    });
  } else if (currentState) {
    // Workflow dang pending -> tiep tuc
    result = await continueWorkflow(context, currentState);
  } else {
    // Khong co workflow pending -> dispatch theo intent
    switch (intent.intent) {
      case "CREATE_NEW":
        result = await startNewWorkflow(context);
        break;
      case "EDIT_CONTENT":
        // Khong co workflow pending nhung muon sua content -> tao workflow moi
        result = await startNewWorkflow(context);
        break;
      case "EDIT_MEDIA":
        // Khong co workflow nen create new
        result = await startNewWorkflow(context);
        break;
      case "EDIT_PUBLISHED":
        result = await editPublishedFlow(context);
        break;
      case "SCHEDULE":
        // Schedule nhung khong co workflow -> can tao content truoc
        result = await startNewWorkflow(context);
        break;
      case "TRAIN":
        result = handleTrainIntent(context);
        break;
      default:
        result = await startNewWorkflow(context);
    }
  }

  const rootSynced = await syncRootMessageFromResult(context, result);
  const resultStage = String(result?.stage || "").trim();
  const resultStatus = String(result?.status || "ok").trim().toLowerCase();
  if (
    !rootSynced &&
    resultStatus === "ok" &&
    ["awaiting_media_approval", "awaiting_video_approval", "awaiting_publish_decision"].includes(resultStage)
  ) {
    startWorkflowStageAutoNotifyWatcher({
      openClawHome: context.openClawHome,
      workflowId: result.workflow_id || result.workflowId,
      stage: resultStage,
      sessionKey:
        context.registry.byId.pho_phong?.transport?.sessionKey ||
        buildWorkflowScopedSessionKey("pho_phong", result.workflow_id || result.workflowId, "root"),
      timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
    });
  }
  if (!rootSynced && resultStatus === "running" && resultStage === "generating_content") {
    startContentApprovalAutoNotifyWatcher(
      context,
      result.workflow_id || result.workflowId,
      context.registry.byId.nv_content?.transport?.sessionKey || "",
    );
  }
  if (!rootSynced && resultStatus === "running") {
    const asyncStageWatchers = {
      generating_media: "awaiting_media_approval",
      revising_media: "awaiting_media_approval",
      generating_video: "awaiting_video_approval",
      revising_video: "awaiting_video_approval",
    };
    const notifyStage = asyncStageWatchers[resultStage];
    if (notifyStage) {
      startWorkflowStageAutoNotifyWatcher({
        openClawHome: context.openClawHome,
        workflowId: result.workflow_id || result.workflowId,
        stage: notifyStage,
        sessionKey:
          context.registry.byId.pho_phong?.transport?.sessionKey ||
          buildWorkflowScopedSessionKey("pho_phong", result.workflow_id || result.workflowId, "root"),
        timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
      });
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

// â�?€â�?€â�?€ BACKWARD-COMPATIBLE EXPORTS â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€â�?€
// Giá»¯ nguyÃªn exports cÅ© cho test file hiá»‡n táº¡i.

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
  buildContentApprovalCheckpointMessage,
  buildPaths,
  continueWorkflow,
  buildStageHumanMessage,
  buildWorkflowScopedSessionKey,

  isWorkflowScopedSessionKey,
  resolveWorkflowScopedSessionKey,

  classifyContentDecision,
  classifyMediaDecision,
  extractBlock,
  extractField,
  hasWorkflowStageNotification,
  hasAsyncStageExceededGrace,
  parseContentReply,
  parseMediaReply,
  buildRootSyncPayloadFromResult,
  resolveRootWorkflowBinding,
  runAutoNotifyWatcher,
  scanLatestGeneratedMedia,
  syncRootMessageFromResult,
  shouldSupersedePendingWorkflow,
  runContentCheckpointStep,
  validateContentCheckpointReply,
  waitForValidContentCheckpoint,
  migrateState,
};
