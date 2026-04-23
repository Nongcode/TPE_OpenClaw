/**
 * orchestrator.js â€” Bá»™ Ä‘iá»u phá»‘i trung tÃ¢m v2.
 *
 * NÃ¢ng cáº¥p tá»« state-machine tuyáº¿n tÃ­nh cá»‘ Ä‘á»‹nh sang Multi-Agent tá»± trá»‹:
 * - Dynamic Routing qua LLM intent parsing
 * - Long-term Memory (rules.json self-learning)
 * - Human-in-the-Loop báº¯t buá»™c táº¡i má»i checkpoint
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
const DEFAULT_VIDEO_PROMPT_TEMPLATE = promptAgent.DEFAULT_VIDEO_PROMPT_TEMPLATE;

// â”€â”€â”€ CLI Argument Parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    useLLMIntent: false, // Táº¯t máº·c Ä‘á»‹nh â€” LLM intent gá»­i prompt vÃ o lane phÃ³ phÃ²ng gÃ¢y lá»™ ná»™i dung. DÃ¹ng keyword matching.
    autoNotifyWatch: false,
    notifySessionKey: "",
    notifyWorkflowId: "",
    notifyStage: "",
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

// â”€â”€â”€ Workspace & State Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  if (!Number.isFinite(numeric) || numeric <= 0) return 900000;
  return Math.max(numeric, 900000);
}

function isAsyncStepStillRunningError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
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
      "He thong van dang render video, chua co ket qua cuoi cung.",
      "",
      "Toi se gui video ngay khi Media_Video tra ket qua.",
    ].join("\n");
  }
  return [
    "He thong van dang render media, chua co ket qua cuoi cung.",
    "",
    "Toi se gui media ngay khi NV Media tra ket qua.",
  ].join("\n");
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
  const isStatusQuery = [
    "den dau roi",
    "toi dau roi",
    "xong chua",
    "tien do",
    "bao gio xong",
  ].some((token) => normalized.includes(token));
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
  return [...new Set([
    ...(existingGuidelines || []).map((item) => String(item || "").trim()).filter(Boolean),
    ...extractWorkflowGuidelines(message),
  ])];
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

function normalizePublishedSummaryText(message) {
  return String(message || "")
    .replaceAll(
      "Ã°Å¸â€œÂ¤ BÃƒÂ i viÃ¡ÂºÂ¿t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã„Æ’ng thÃƒÂ nh cÃƒÂ´ng lÃƒÂªn Fanpage!",
      "📤 Bài viết đã được đăng thành công lên Fanpage!",
    )
    .replaceAll("khÃƒÂ´ng cÃƒÂ³", "không có");
}

function buildFrontendApprovalMessage(params) {
  const lines = [
    params.revised
      ? "NV Content da sua lai bai theo nhan xet, dang cho Sep duyet lai."
      : "NV Content da viet xong bai nhap, dang cho Sep duyet.",
    params.productName ? `San pham: ${params.productName}` : "",
    "----- NOI DUNG CHO DUYET -----",
    params.approvedContent || "",
    "------------------------------",
    'Sep muon duyet? Noi: "Duyet content, tao anh"',
    'Muon sua? Ghi ro nhan xet, vi du: "Sua content, them gia"',
    params.primaryProductImage ? "" : "",
    params.primaryProductImage ? "Anh goc san pham de doi chieu:" : "",
    buildMediaDirective(params.primaryProductImage),
  ];

  return lines.filter(Boolean).join("\n");
}

function buildPaths(workspaceDir) {
  const baseDir = path.join(workspaceDir, "agent-orchestrator-test");
  const historyDir = path.join(baseDir, "history");
  const currentFile = path.join(baseDir, "current-workflow.json");
  ensureDir(baseDir);
  ensureDir(historyDir);
  return { baseDir, historyDir, currentFile };
}

// â”€â”€â”€ Result Builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  // Human-readable mode: chá»‰ in summary
  console.log(result.human_message || result.summary || JSON.stringify(result, null, 2));
}

// â”€â”€â”€ Workflow State Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 * Migrate state cÅ© náº¿u thiáº¿u trÆ°á»ng má»›i.
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

// â”€â”€â”€ Reply Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function validateCommonReply(reply, workflowId, stepId) {
  const text = String(reply || "").trim();
  if (!text) throw new Error("Agent reply is empty.");

  // Soft validation â€” chá»‰ warn náº¿u thiáº¿u token, khÃ´ng crash.
  // Agent LLM cÃ³ thá»ƒ viáº¿t hÆ¡i khÃ¡c (thÃªm dáº¥u, space, format) nhÆ°ng ná»™i dung Ä‘Ãºng.
  const requiredTokens = ["WORKFLOW_META", "TRANG_THAI", "KET_QUA"];
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      logger.log("warn", `âš ï¸ Agent reply thiáº¿u token "${token}" â€” tiáº¿p tá»¥c xá»­ lÃ½.`);
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

async function resolveRootWorkflowBinding(context) {
  const managerId = String(context?.options?.from || "pho_phong").trim() || "pho_phong";
  const brief = normalizeText(context?.message || "");
  const fallbackWorkflowId = `wf_test_${randomUUID()}`;

  try {
    const resolved = await beClient.resolveAutomationRootConversation({
      agentId: managerId,
      employeeId: managerId,
      brief,
      sessionKey: context?.registry?.byId?.pho_phong?.transport?.sessionKey || null,
    });

    const workflowId =
      String(resolved?.workflowId || resolved?.rootConversation?.workflowId || "").trim()
      || fallbackWorkflowId;
    const rootConversationId =
      String(resolved?.rootConversationId || resolved?.rootConversation?.id || "").trim() || null;
    const rootSessionKey =
      String(resolved?.sessionKey || resolved?.rootConversation?.sessionKey || "").trim() || null;

    if (rootConversationId) {
      logger.log(
        "info",
        `[workflow-binding] adopted root=${rootConversationId} workflow=${workflowId} for ${managerId}`,
      );
      return {
        workflowId,
        rootConversationId,
        rootSessionKey,
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
    adoptedExistingRoot: false,
  };
}

async function resolveWorkflowSessionContext(params) {
  let actualSessionKey =
    String(params.sessionKey || "").trim()
    || buildWorkflowScopedSessionKey(params.agentId, params.workflowId, params.stepId);
  let subConv = null;

  try {
    subConv = await beClient.createSubAgentConversation({
      workflowId: params.workflowId,
      agentId: params.agentId,
      employeeId: params.employeeId || params.agentId,
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
  };
}

function buildContentApprovalCheckpointMessage(params) {
  // Root/manager conversation should show the review-ready approval summary.
  // Keep the raw child checkpoint only for explicit debug/tracing flows.
  if (!params?.includeRawCheckpoint) {
    return buildFrontendApprovalMessage(params);
  }

  const intro = params.revised
    ? "NV Content da sua lai bai theo nhan xet. Dang cho pho_phong duyet lai."
    : "NV Content da hoan tat content. Dang cho pho_phong duyet.";
  const rawReply = String(params.rawReply || "").trim();
  if (!rawReply) {
    return buildFrontendApprovalMessage(params);
  }
  return [
    intro,
    "",
    "CHECKPOINT_GOC_TU_NV_CONTENT:",
    rawReply,
  ].join("\n");
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
    return { ok: false, reason: "missing PRODUCT_NAME", content: null, reply: correlation.matchedText || rawReply, warnings };
  }
  if (!parsed.productUrl) {
    return { ok: false, reason: "missing PRODUCT_URL", content: null, reply: correlation.matchedText || rawReply, warnings };
  }
  if (!parsed.primaryProductImage) {
    return { ok: false, reason: "missing PRIMARY_PRODUCT_IMAGE", content: null, reply: correlation.matchedText || rawReply, warnings };
  }
  if (!parsed.approvedContent) {
    return { ok: false, reason: "missing APPROVED_CONTENT_BEGIN/END", content: null, reply: correlation.matchedText || rawReply, warnings };
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
  logCheckpointValidation(params.agentId, params.workflowId, params.stepId, validation, params.sessionKey);
  if (validation.ok) {
    return validation;
  }

  const graceMs = Math.min(Math.max(Number(params.graceMs) || 20000, 3000), 60000);
  const deadline = Date.now() + graceMs;
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
    logCheckpointValidation(params.agentId, params.workflowId, params.stepId, validation, params.sessionKey);
    if (validation.ok) {
      return validation;
    }
  }

  throw new Error(
    `${params.agentId} chua tra ve checkpoint duyet content hop le. Ly do cuoi: ${validation.reason || "unknown"}.`,
  );
}

// â”€â”€â”€ Agent Communication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runAgentStepDetailed(params) {
  const { sessionKey: actualSessionKey, subConv } = await resolveWorkflowSessionContext(params);
  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    timeoutMs: params.timeoutMs,
  });
  const response = await transport.waitForAgentResponse(task);
  const finalReply = validateCommonReply(response.text, params.workflowId, params.stepId);

  if (subConv) {
    try {
      const now = Date.now();
      await beClient.persistMessages([
        { id: `msg_${now}_${params.stepId}_prompt`, conversationId: subConv.id, role: "user", content: params.prompt, timestamp: now },
        { id: `msg_${now}_${params.stepId}_reply`, conversationId: subConv.id, role: "assistant", content: finalReply, timestamp: now + 1 },
      ]);
    } catch (err) {
      logger.logError("beClient", "LÃ¡Â»â€”i lÃ†Â°u log message DB: " + err.message);
    }
  }

  return {
    reply: finalReply,
    sessionKey: actualSessionKey,
    subConv,
  };
}

async function runAgentStep(params) {
  let actualSessionKey =
    String(params.sessionKey || "").trim()
    || buildWorkflowScopedSessionKey(params.agentId, params.workflowId, params.stepId);
  let subConv;

  try {
    // 1. Táº¡o/Reuse conversation qua BE Ä‘á»ƒ láº¥y sessionKey chuáº©n (cÃ´ láº­p tiáº¿n trÃ¬nh)
    subConv = await beClient.createSubAgentConversation({
      workflowId: params.workflowId,
      agentId: params.agentId,
      parentConversationId: params.rootConversationId || null,
      title: `[AUTO] ${params.agentId} â€¢ ${params.stepId}`
    });
    if (subConv && subConv.sessionKey) {
      actualSessionKey = subConv.sessionKey;
    }
  } catch (err) {
    logger.logError("beClient", "Lá»—i táº¡o sub-agent conversation DB: " + err.message);
  }

  // 2. Gá»i cho Gateway bÃ¬nh thÆ°á» ng
  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: actualSessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    timeoutMs: params.timeoutMs,
  });
  const response = await transport.waitForAgentResponse(task);
  const finalReply = validateCommonReply(response.text, params.workflowId, params.stepId);

  // 3. Persist messages (Prompt & Reply)
  if (subConv) {
    try {
      const now = Date.now();
      await beClient.persistMessages([
        { id: `msg_${now}_${params.stepId}_prompt`, conversationId: subConv.id, role: "user", content: params.prompt, timestamp: now },
        { id: `msg_${now}_${params.stepId}_reply`, conversationId: subConv.id, role: "assistant", content: finalReply, timestamp: now + 1 },
      ]);
    } catch (err) {
      logger.logError("beClient", "Lá»—i lÆ°u log message DB: " + err.message);
    }
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
  });

  return {
    reply: validation.reply,
    content: {
      ...validation.content,
      reply: validation.reply,
    },
    sessionKey: result.sessionKey,
  };
}

async function syncApprovalCheckpoint(params) {
  const managerId = params.managerId || "pho_phong";
  const timestamp = Date.now();
  let delivered = false;

  try {
    await beClient.updateWorkflowStatus(params.workflowId, params.stage || "awaiting_content_approval");
  } catch (err) {
    logger.logError("beClient", "Loi dong bo workflow status: " + err.message);
  }

  try {
    await beClient.pushAutomationEvent({
      workflowId: params.workflowId,
      employeeId: managerId,
      agentId: managerId,
      conversationId: params.rootConversationId || null,
      title: params.title || `[AUTO] ${managerId} • ${params.workflowId}`,
      role: "assistant",
      type: "approval_request",
      content: params.content,
      timestamp,
      status: params.stage || "awaiting_content_approval",
      conversationRole: "root",
      injectToGateway: false,
      eventId: params.eventId || `${params.workflowId}:${params.stage || "awaiting_content_approval"}:approval`,
    });
    delivered = true;
  } catch (err) {
    logger.logError("beClient", "Loi day approval message ve FE: " + err.message);
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
      employeeId: managerId,
      agentId: managerId,
      conversationId: params.rootConversationId || null,
      title: params.title || `[AUTO] ${managerId} • ${workflowId}`,
      role: "assistant",
      type: params.type || "regular",
      content,
      timestamp,
      status: params.stage || "active",
      conversationRole: "root",
      injectToGateway: false,
      eventId: params.eventId || `${workflowId}:${params.stage || "active"}:${params.type || "regular"}`,
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
    return current;
  }
  if (!workflowId || !paths?.historyDir) {
    return null;
  }
  return readJsonIfExists(path.join(paths.historyDir, `${workflowId}.json`), null);
}

function buildRootSyncPayloadFromResult(context, result) {
  const workflowId = String(result?.workflow_id || result?.workflowId || "").trim();
  const stage = String(result?.stage || "").trim();
  const status = String(result?.status || "ok").trim().toLowerCase();
  if (!workflowId || !stage) {
    return null;
  }

  // Do not persist transient blocked/running placeholders as real manager checkpoints.
  if (stage.startsWith("awaiting_") && status !== "ok") {
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

  const stageSpec = stageSpecs[stage];
  if (!stageSpec) {
    return null;
  }

  const workflowState = readWorkflowStateForSync(context.paths, workflowId);
  const content = String(
    result?.human_message ||
      result?.summary ||
      buildStageHumanMessage(workflowState) ||
      "",
  ).trim();
  if (!content) {
    return null;
  }

  return {
    workflowId,
    stage,
    type: stageSpec.type,
    eventId: stageSpec.eventId,
    content,
    rootConversationId:
      workflowState?.rootConversationId || context.parentConversationId || null,
  };
}

async function syncRootMessageFromResult(context, result) {
  const payload = buildRootSyncPayloadFromResult(context, result);
  if (!payload) {
    return false;
  }
  return syncRootConversationMessage({
    ...payload,
    managerId: context.options?.from || "pho_phong",
    title: `[AUTO] ${context.options?.from || "pho_phong"} • ${payload.workflowId}`,
  });
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
  const hasQuotedProduct = /["â€œâ€].+["â€œâ€]/.test(raw);
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

function buildPromptPreview(promptPackage) {
  const shortenPrompt = (value, maxLength = 420) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
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

function mergeUniquePaths(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function sanitizeVideoMediaPath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return videoAgent.isPlaceholderGeneratedPath(normalized) ? "" : normalized;
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
  const { media, promptPackage, route } = params;
  const promptPreview = buildPromptPreview(promptPackage);
  const referenceText = [
    media?.usedProductImage ? `Anh san pham goc da dung: ${media.usedProductImage}` : "",
    Array.isArray(media?.usedLogoPaths) && media.usedLogoPaths.length > 0
      ? `Logo da dung: ${media.usedLogoPaths.join(" ; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `NV Media da tao xong media (${route.effectiveType}), dang cho Sep duyet.`,
    media?.generatedImagePath ? "Anh media vua tao:" : "",
    buildMediaDirective(media?.generatedImagePath),
    media?.generatedVideoPath ? "Video media vua tao:" : "",
    buildMediaDirective(media?.generatedVideoPath),
    media?.usedProductImage ? "Anh goc san pham de doi chieu:" : "",
    buildMediaDirective(media?.usedProductImage),
    referenceText,
    "",
    promptPreview,
    "",
    'Duyet va sang buoc tiep: "Duyet anh va dang bai" hoac "Duyet media"',
    'Sua tiep: "Sua anh, <nhan xet>" hoac "Sua prompt, <nhan xet>"',
  ]
    .filter(Boolean)
    .join("\n");
}

function buildVideoApprovalSummary(params) {
  const { media, promptPackage } = params;
  const promptPreview = buildPromptPreview({
    videoPrompt: promptPackage?.videoPrompt || media?.videoPrompt || "",
  });
  const referenceText = [
    media?.usedProductImage ? `Anh san pham goc da dung: ${media.usedProductImage}` : "",
    Array.isArray(media?.usedLogoPaths) && media.usedLogoPaths.length > 0
      ? `Logo da dung: ${media.usedLogoPaths.join(" ; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "Media_Video da tao xong video quang cao, dang cho Sep duyet.",
    media?.generatedVideoPath ? "Video quang cao vua tao:" : "",
    buildMediaDirective(media?.generatedVideoPath),
    media?.generatedImagePath ? "Anh quang cao da duyet de doi chieu:" : "",
    buildMediaDirective(media?.generatedImagePath),
    media?.usedProductImage ? "Anh goc san pham de doi chieu:" : "",
    buildMediaDirective(media?.usedProductImage),
    referenceText,
    "",
    promptPreview,
    "",
    'Duyet video: "Duyet video"',
    'Sua video: "Sua video, <nhan xet>" hoac "Sua prompt video, <nhan xet>"',
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
      ? "✅ Sep da duyet content, anh va video. Da san sang dang bai."
      : "✅ Sep da duyet content va anh. Da san sang dang bai.",
    hasImage ? "Anh se dang:" : "",
    buildMediaDirective(state.media?.generatedImagePath),
    hasVideo ? "Video da duyet va san sang dang trong luot nay." : "",
    offerVideo ? "" : "",
    offerVideo ? "Co muon tao them video quang cao san pham tren roi dang len page khong?" : "",
    offerVideo ? '👉 Tao video: "Tao video"' : "",
    '👉 Dang ngay: "Dang ngay" hoac "Publish"',
    '👉 Hen gio: "Hen gio 20:00 hom nay" hoac "Schedule 2026-04-10T20:00:00+07:00"',
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
      rawReply: state.content?.reply || "",
      revised: true,
    });
  }
  return "";
}

function getAsyncStageSpec(state) {
  if (!state) return null;
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

  let workerSessionKey =
    registry?.byId?.[spec.agentId]?.transport?.sessionKey
    || buildWorkflowScopedSessionKey(spec.agentId, state.workflow_id, spec.stepId);

  // Ưu tiên session key do BE sinh (per-workflow) thay vì fixed registry key
  try {
    const subConv = await beClient.createSubAgentConversation({
      workflowId: state.workflow_id,
      agentId: spec.agentId,
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
      if (spec.kind === "video") {
        const parsed = videoAgent.parseVideoResult(historyReply, {
          productImage: state.content?.primaryProductImage || "",
          logoPaths:
            state.video_generating_logo_paths ||
            state.video_revising_logo_paths ||
            state.media?.usedLogoPaths ||
            mediaAgent.resolveLogoAssetPaths(openClawHome),
        });
        recoveredMedia = mergeMediaData(state.media, parsed, state.content);
      } else {
        const parsed = mediaAgent.parseMediaResult(historyReply, spec.route);
        recoveredMedia = mergeMediaData(state.media, parsed, state.content);
      }
    }
  } catch {
    // fall through to artifact scan
  }

  if (!recoveredMedia) {
    const recoveredArtifacts = scanLatestGeneratedMedia(openClawHome, spec.startedAt, {
      agentId: spec.agentId,
      videoDirs: state.video_output_dir ? [state.video_output_dir] : [],
    });
    if (spec.kind === "video" && recoveredArtifacts.videoPath) {
      recoveredMedia = mergeMediaData(
        state.media,
        {
          generatedVideoPath: recoveredArtifacts.videoPath,
          videoPrompt: state.prompt_package?.videoPrompt || state.media?.videoPrompt || "",
          usedProductImage: state.content?.primaryProductImage || state.media?.usedProductImage || "",
          usedLogoPaths:
            state.video_generating_logo_paths ||
            state.video_revising_logo_paths ||
            state.media?.usedLogoPaths ||
            [],
        },
        state.content,
      );
    }
    if (spec.kind === "media" && (recoveredArtifacts.imagePath || recoveredArtifacts.videoPath)) {
      recoveredMedia = mergeMediaData(
        state.media,
        {
          generatedImagePath: recoveredArtifacts.imagePath || "",
          generatedVideoPath: recoveredArtifacts.videoPath || "",
          mediaType: spec.route,
          imagePrompt: state.prompt_package?.imagePrompt || state.media?.imagePrompt || "",
          videoPrompt: state.prompt_package?.videoPrompt || state.media?.videoPrompt || "",
          usedProductImage: state.content?.primaryProductImage || state.media?.usedProductImage || "",
          usedLogoPaths:
            state.generating_logo_paths ||
            state.revising_logo_paths ||
            state.media?.usedLogoPaths ||
            [],
        },
        state.content,
      );
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
    String(params.timeoutMs || 900000),
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
      detached: process.platform !== "win32",
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
  const paths = buildPaths(workspaceDir);
  const registry = discoverRegistry({ openClawHome });
  const targetWorkflowId = String(options.notifyWorkflowId || "").trim();
  const targetStage = String(options.notifyStage || "").trim();
  const targetSessionKey = String(options.notifySessionKey || "").trim();
  const deadline =
    Date.now() + Math.min(Math.max(Number(options.timeoutMs) || 900000, 30000), 1800000);

  while (Date.now() <= deadline) {
    let state = readJsonIfExists(paths.currentFile, null);
    if (!state || state.workflow_id !== targetWorkflowId) {
      return;
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
        await transport.callGatewayMethod({
          openClawHome,
          method: "chat.inject",
          params: {
            sessionKey: targetSessionKey,
            message: humanMessage,
            label: "workflow-auto-notify",
          },
          timeoutMs: 30000,
        });
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

function selectLatestArtifactPath(dirPath, extensions, sinceMs, excludePatterns = []) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return "";
    }

    const files = fs
      .readdirSync(dirPath)
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

function scoreGeneratedImageArtifact(fullPath) {
  const fileName = path.basename(fullPath || "").toLowerCase();
  if (!fileName) return -1;
  if (/^gemini_generated_image_/i.test(fileName)) return 4;
  if (/[_-]final\./i.test(fileName)) return 3;
  if (/generated|download/i.test(fileName)) return 2;
  if (/^gemini-(before|after)-/i.test(fileName)) return -1;
  return 1;
}

function selectLatestArtifactAcrossDirs(dirPaths, extensions, sinceMs, excludePatterns = []) {
  const candidates = dirPaths
    .map((dirPath) => selectLatestArtifactPath(dirPath, extensions, sinceMs, excludePatterns))
    .filter(Boolean)
    .map((fullPath) => ({
      fullPath,
      mtimeMs: fs.statSync(fullPath).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates[0]?.fullPath || "";
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

  const imageDirs = [
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
            return !Number.isFinite(sinceMs) || sinceMs <= 0 || mtimeMs >= sinceMs;
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

  const videoDirs = [
    ...(Array.isArray(overrides.videoDirs) ? overrides.videoDirs : []),
    path.join(workspaceDir, "artifacts", "videos"),
    path.join(workspaceDir, "outputs", "veo_videos"),
    path.join(workspaceDir, "outputs", "videos"),
    path.join(repoRoot, "artifacts", "videos"),
    path.join(repoRoot, "outputs", "veo_videos"),
    path.join(repoRoot, "outputs", "videos"),
  ];
  const videoPath = selectLatestArtifactAcrossDirs(
    [...new Set(videoDirs.filter(Boolean))],
    [".mp4", ".mov", ".webm"],
    sinceMs,
  );

  return {
    imagePath,
    videoPath: isLikelyFinalGeneratedVideoPath(videoPath) ? videoPath : "",
  };
}

// â”€â”€â”€ Content Dedup Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ WORKFLOW ACTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Táº¡o workflow má»›i â€” giao nv_content viáº¿t bÃ i.
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
      initiatorAgentId: context.options.from || "pho_phong",
      initiatorEmployeeId: context.options.from || "pho_phong",
      title: `[AUTO] Workflow (tá»« ${context.options.from})`,
      inputPayload: JSON.stringify(context.message)
    });
  } catch (err) {
    logger.logError("beClient", "Lá»—i táº¡o workflow Db: " + err.message);
  }


  logger.logPhase("Táº O BÃ€I Má»šI", `Sáº¿p giao brief: "${context.message.slice(0, 100)}..."`);
  logger.logHandoff(
    "PhÃ³ phÃ²ng",
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

  const contentCheckpoint = await runContentCheckpointStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    rootConversationId: rootBinding.rootConversationId || null,
    workflowId,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });
  const content = contentCheckpoint.content;

  // Content dedup check
  if (isDuplicateContent(context.paths.historyDir, content.approvedContent)) {
    logger.log(
      "info",
      "âš ï¸ Ná»™i dung nÃ y cÃ³ thá»ƒ trÃ¹ng vá»›i bÃ i Ä‘Ã£ Ä‘Äƒng gáº§n Ä‘Ã¢y.",
    );
  }

  const state = saveWorkflow(context.paths, {
    workflow_id: workflowId,
    rootConversationId: rootBinding.rootConversationId || null,
    managerId: context.options.from || "pho_phong",
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
    global_guidelines: mergeWorkflowGuidelines([], context.message),
    notifications: {},
  });

  const summary = [
    context.supersededWorkflowId ? `Da archive workflow cu: ${context.supersededWorkflowId}` : "",
    "ðŸ“ NV Content Ä‘Ã£ viáº¿t xong bÃ i nhÃ¡p, Ä‘ang chá» Sáº¿p duyá»‡t.",
    content.productName ? `Sáº£n pháº©m: ${content.productName}` : "",
    "",
    "â”â”â” Ná»˜I DUNG CHá»œ DUYá»†T â”â”â”",
    content.approvedContent,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "",
    'ðŸ‘‰ Sáº¿p muá»‘n duyá»‡t? NÃ³i: "Duyá»‡t content, táº¡o áº£nh"',
    'ðŸ‘‰ Muá»‘n sá»­a? Ghi rÃµ nháº­n xÃ©t, vÃ­ dá»¥: "Sá»­a content, thÃªm giÃ¡"',
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    content.primaryProductImage ? "" : "",
    content.primaryProductImage ? "Anh goc san pham de doi chieu:" : "",
    buildMediaDirective(content.primaryProductImage),
  ]
    .filter(Boolean)
    .join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  await syncApprovalCheckpoint({
    workflowId,
    rootConversationId: rootBinding.rootConversationId || null,
    managerId: context.options.from || "pho_phong",
    stage: state.stage,
    title: `[AUTO] ${context.options.from || "pho_phong"} • ${workflowId}`,
    content: buildContentApprovalCheckpointMessage({
      productName: content.productName,
      approvedContent: content.approvedContent,
      primaryProductImage: content.primaryProductImage,
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
      `NV Content Ä‘Ã£ bá»‹ tá»« chá»‘i ${contentRejects} láº§n. Cáº§n xem láº¡i brief.`,
    );
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `âš ï¸ NV Content Ä‘Ã£ bá»‹ tá»« chá»‘i ${contentRejects} láº§n liÃªn tiáº¿p. CÃ³ thá»ƒ brief cáº§n bá»• sung hoáº·c nhÃ¢n viÃªn cáº§n training thÃªm.`,
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

  const contentCheckpoint = await runContentCheckpointStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });
  const content = contentCheckpoint.content;
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_content_approval",
    content,
  });

  const summary = [
    "ðŸ“ NV Content Ä‘Ã£ sá»­a láº¡i bÃ i theo nháº­n xÃ©t, Ä‘ang chá» Sáº¿p duyá»‡t láº¡i.",
    "",
    "â”â”â” Ná»˜I DUNG ÄÃƒ Sá»¬A â”â”â”",
    content.approvedContent,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "",
    'ðŸ‘‰ Duyá»‡t: "Duyá»‡t content, táº¡o áº£nh"',
    "ðŸ‘‰ Sá»­a tiáº¿p: ghi rÃµ nháº­n xÃ©t",
  ].join("\n");
  const summaryWithPreview = [
    summary,
    content.primaryProductImage ? "" : "",
    content.primaryProductImage ? "Anh goc san pham de doi chieu:" : "",
    buildMediaDirective(content.primaryProductImage),
  ]
    .filter(Boolean)
    .join("\n");

  logger.logApprovalWait("awaiting_content_approval", content.approvedContent);

  await syncApprovalCheckpoint({
    workflowId: state.workflow_id,
    managerId: context.options.from || "pho_phong",
    stage: nextState.stage,
    title: `[AUTO] ${context.options.from || "pho_phong"} • ${state.workflow_id}`,
    content: buildContentApprovalCheckpointMessage({
      productName: content.productName,
      approvedContent: content.approvedContent,
      primaryProductImage: content.primaryProductImage,
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

  logger.logPhase("Táº O MEDIA", `Loáº¡i: ${route.effectiveType}`);
  logger.logHandoff(
    "PhÃ³ phÃ²ng",
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

  // â”€â”€â”€ LOCK: LÆ°u stage 'generating_media' TRÆ¯á»šC khi gá»i agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tháº©m quyá»n nÃ y ngÄƒn orchestrator bá»‹ loop khÃ´ng há»Ÿi NV Media láº§n 2
  // náº¿u nÃ³ crash sau khi NV Media Ä‘Ã£ tráº£ áº£nh nhÆ°ng trÆ°á»›c khi save state.
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
      break; // ThÃ nh cÃ´ng
    } catch (transportErr) {
      logger.logError("transport", `Láº§n ${attempt}: ${transportErr.message || transportErr}`);
      if (attempt >= MAX_TRANSPORT_RETRIES) {
        // Khi transport lá»—i, khÃ´i phá»¥c stage vá» awaiting_content_approval
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
            "âŒ Táº¡o áº£nh khÃ´ng thÃ nh cÃ´ng sau 2 láº§n thá»­.",
            `Lá»—i: ${transportErr.message || "Káº¿t ná»‘i tá»›i NV Media bá»‹ ngáº¯t."}`,
            "",
            'ðŸ‘‰ Thá»­ láº¡i: "Duyá»‡t content, táº¡o áº£nh"',
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `ðŸ”ƒ Thá»­ láº¡i láº§n ${attempt + 1}...`);
    }
  }

  // â”€â”€â”€ Parse káº¿t quáº£ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        "âŒ NV Media Ä‘Ã£ táº¡o áº£nh nhÆ°ng há»‡ thá»‘ng khÃ´ng Ä‘á»c Ä‘Æ°á»£c káº¿t quáº£.",
        `Lá»—i: ${parseErr.message}`,
        "",
        'ðŸ‘‰ Thá»­ láº¡i: "Duyá»‡t content, táº¡o áº£nh"',
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // â”€â”€â”€ LÆ°u background path ngay sau khi parse â€” trÆ°á»›c composite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Náº¿u composite crash, recovery sá»­ dá»¥ng Ä‘Æ°á»ng dáº«n nÃ y thay vÃ¬ scan thÆ° má»¥c.
  saveWorkflow(context.paths, {
    ...state,
    stage: "generating_media",
    generating_bg_image_path: media.generatedImagePath || "",
    generating_product_image_path: state.content?.primaryProductImage || "",
  });

  // â”€â”€â”€ PIPELINE GHÃ‰P 3 Lá»šP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Náº¿u cÃ³ áº£nh sáº£n pháº©m tháº­t â†’ ghÃ©p: Background AI + Product tháº­t + Logo
  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (
    route.effectiveType === "image" &&
    media.generatedImagePath &&
    state.content?.primaryProductImage
  ) {
    try {
      logger.log("media", "ðŸ”§ Äang ghÃ©p 3 lá»›p: Ná»n AI + Sáº£n pháº©m tháº­t + Logo...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `âœ… GhÃ©p áº£nh 3 lá»›p thÃ nh cÃ´ng: ${compositePath}`);
    } catch (compErr) {
      process.stderr.write(`[COMPOSITE_ERROR] ${compErr.stack || compErr.message || compErr}\n`);
      logger.logError("composite", compErr);
      logger.log("info", "âš ï¸ Sá»­ dá»¥ng áº£nh ná»n AI gá»‘c (chÆ°a ghÃ©p sáº£n pháº©m).");
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
    `ðŸŽ¨ NV Media Ä‘Ã£ táº¡o ${route.effectiveType === "video" ? "video" : "áº£nh"} xong, Ä‘ang chá» Sáº¿p duyá»‡t.`,
    media.composited ? "âœ… ÄÃ£ ghÃ©p: Ná»n AI + Sáº£n pháº©m tháº­t + Logo" : "",
    route.fallbackMessage ? `â„¹ï¸ ${route.fallbackMessage}` : "",
    "",
    finalMediaPath ? `ðŸ–¼ï¸ Xem áº£nh: ${fileLink}` : "",
    `File: ${finalMediaPath}`,
    "",
    'ðŸ‘‰ Duyá»‡t vÃ  Ä‘Äƒng bÃ i: "Duyá»‡t áº£nh vÃ  Ä‘Äƒng bÃ i"',
    'ðŸ‘‰ Sá»­a áº£nh: ghi rÃµ nháº­n xÃ©t, vÃ­ dá»¥: "Sá»­a áº£nh, ná»n chÆ°a Ä‘áº¹p"',
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    finalMediaPath ? "" : "",
    finalMediaPath ? "Anh media vua tao:" : "",
    buildMediaDirective(finalMediaPath),
    state.content?.primaryProductImage ? "Anh goc san pham de doi chieu:" : "",
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
    logger.logError("media", `NV Media Ä‘Ã£ bá»‹ tá»« chá»‘i ${mediaRejects} láº§n.`);
    return buildResult({
      workflowId: state.workflow_id,
      stage: "blocked",
      status: "blocked",
      summary: `âš ï¸ NV Media Ä‘Ã£ bá»‹ tá»« chá»‘i ${mediaRejects} láº§n liÃªn tiáº¿p. Prompt cÃ³ thá»ƒ cáº§n Ä‘Æ°á»£c thiáº¿t káº¿ láº¡i.`,
      data: { reject_count: mediaRejects },
    });
  }

  logger.logHandoff(
    "PhÃ³ phÃ²ng",
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

  // â”€â”€â”€ LOCK: LÆ°u stage 'revising_media' TRÆ¯á»šC khi gá»i agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  saveWorkflow(context.paths, {
    ...state,
    stage: "revising_media",
    revising_started_at: nowIso(),
    revising_feedback: context.message,
  });

  // â”€â”€â”€ Gá»i NV Media vá»›i retry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          stage: "awaiting_media_approval",
          last_error: `media_revise transport: ${transportErr.message}`,
        });
        return buildResult({
          workflowId: state.workflow_id,
          stage: "awaiting_media_approval",
          status: "error",
          summary: [
            "âŒ Sá»­a áº£nh khÃ´ng thÃ nh cÃ´ng.",
            `Lá»—i: ${transportErr.message || "Káº¿t ná»‘i bá»‹ ngáº¯t."}`,
            "",
            "ðŸ‘‰ Thá»­ láº¡i: nháº¯n láº¡i nháº­n xÃ©t sá»­a áº£nh",
          ].join("\n"),
          data: { error: transportErr.message },
        });
      }
      logger.log("info", `ðŸ”ƒ Thá»­ láº¡i láº§n ${attempt + 1}...`);
    }
  }

  // â”€â”€â”€ Parse káº¿t quáº£ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        "âŒ NV Media Ä‘Ã£ táº¡o áº£nh má»›i nhÆ°ng há»‡ thá»‘ng khÃ´ng Ä‘á»c Ä‘Æ°á»£c káº¿t quáº£.",
        `Lá»—i: ${parseErr.message}`,
        "",
        "ðŸ‘‰ Thá»­ láº¡i: nháº¯n láº¡i nháº­n xÃ©t sá»­a áº£nh",
      ].join("\n"),
      data: { error: parseErr.message },
    });
  }

  // â”€â”€â”€ PIPELINE GHÃ‰P 3 Lá»šP (giá»‘ng generateMedia) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let finalMediaPath = media.generatedImagePath || media.generatedVideoPath || "";
  if (mediaType === "image" && media.generatedImagePath && state.content?.primaryProductImage) {
    try {
      logger.log("media", "ðŸ”§ Äang ghÃ©p láº¡i 3 lá»›p vá»›i ná»n má»›i...");
      const compositePath = await mediaAgent.compositeImage3Layers({
        backgroundPath: media.generatedImagePath,
        productImagePath: state.content.primaryProductImage,
        outputPath: media.generatedImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
      });
      media.generatedImagePath = compositePath;
      media.composited = true;
      finalMediaPath = compositePath;
      logger.log("media", `âœ… GhÃ©p áº£nh 3 lá»›p thÃ nh cÃ´ng: ${compositePath}`);
    } catch (compErr) {
      logger.logError("composite", compErr);
      logger.log("info", "âš ï¸ Sá»­ dá»¥ng áº£nh ná»n AI gá»‘c (chÆ°a ghÃ©p sáº£n pháº©m).");
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
    "ðŸŽ¨ NV Media Ä‘Ã£ sá»­a láº¡i theo nháº­n xÃ©t, Ä‘ang chá» Sáº¿p duyá»‡t.",
    media.composited ? "âœ… ÄÃ£ ghÃ©p láº¡i: Ná»n AI má»›i + Sáº£n pháº©m tháº­t + Logo" : "",
    "",
    finalMediaPath ? `ðŸ–¼ï¸ Xem áº£nh: ${fileLink}` : "",
    `File má»›i: ${finalMediaPath}`,
    "",
    'ðŸ‘‰ Duyá»‡t: "Duyá»‡t áº£nh vÃ  Ä‘Äƒng bÃ i"',
    "ðŸ‘‰ Sá»­a tiáº¿p: ghi rÃµ nháº­n xÃ©t",
  ]
    .filter(Boolean)
    .join("\n");
  const summaryWithPreview = [
    summary,
    finalMediaPath ? "" : "",
    finalMediaPath ? "Anh media sau khi sua:" : "",
    buildMediaDirective(finalMediaPath),
    state.content?.primaryProductImage ? "Anh goc san pham de doi chieu:" : "",
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
 * BÆ°á»›c trung gian: Há»i sáº¿p muá»‘n Ä‘Äƒng ngay hay háº¹n giá».
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
        "NV Media chua tong hop duoc brief de gui NV Prompt.",
        `Loi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        'Thu lai: "Duyet content, tao anh"',
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
        "Khong the tao prompt media tu NV Prompt.",
        `Loi: ${promptErr.message || promptErr}`,
        "",
        'Thu lai: "Duyet content, tao anh"',
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
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
            context.registry.byId.pho_phong?.transport?.sessionKey
            || buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
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
  markWorkflowStageNotified(context.paths, state.workflow_id, "awaiting_media_approval", "sync");

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
        "NV Media chua tong hop duoc yeu cau prompt moi.",
        `Loi: ${mediaPrepareErr.message || mediaPrepareErr}`,
        "",
        "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
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
        "Khong the sua prompt media.",
        `Loi: ${promptErr.message || promptErr}`,
        "",
        "Thu lai bang cach gui lai nhan xet sua anh hoac sua prompt.",
      ].join("\n"),
      data: { error: promptErr.message || String(promptErr) },
    });
  }

  logger.logHandoff(
    "NV Prompt",
    "NV Media",
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
            context.registry.byId.pho_phong?.transport?.sessionKey
            || buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
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
  markWorkflowStageNotified(context.paths, state.workflow_id, "awaiting_media_approval", "sync");

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
  const logoPaths = mediaAgent.resolveLogoAssetPaths(context.openClawHome);

  logger.logPhase("TAO VIDEO", "Phat sinh them video quang cao theo yeu cau cua Sep");
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
        "Media_Video chua tong hop duoc brief de gui NV Prompt.",
        `Loi: ${videoPrepareErr.message || videoPrepareErr}`,
        "",
        'Thu lai: "Tao video"',
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
        "Khong the tao video prompt tu NV Prompt.",
        `Loi: ${promptErr.message || promptErr}`,
        "",
        'Thu lai: "Tao video"',
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
          context.registry.byId.pho_phong?.transport?.sessionKey
          || buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
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
        "Khong the tao video quang cao.",
        `Loi: ${videoErr.message || videoErr}`,
        "",
        'Thu lai: "Tao video"',
      ].join("\n"),
      data: { error: videoErr.message || String(videoErr) },
    });
  }

  let videoMedia;
  try {
    videoMedia = videoAgent.parseVideoResult(videoReply, {
      productImage: generatingState.content?.primaryProductImage || "",
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
        "Media_Video da tao video nhung he thong khong doc duoc ket qua.",
        `Loi: ${parseErr.message || parseErr}`,
        "",
        'Thu lai: "Tao video"',
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
  markWorkflowStageNotified(context.paths, state.workflow_id, "awaiting_video_approval", "sync");

  logger.logApprovalWait("awaiting_video_approval", summary);

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: {
      media: mergedMedia,
      prompt_package: mergedPromptPackage,
      next_expected_action: "video_approval",
    },
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
  const logoPaths = mediaAgent.resolveLogoAssetPaths(context.openClawHome);
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
        "Media_Video chua tong hop duoc yeu cau prompt moi.",
        `Loi: ${videoPrepareErr.message || videoPrepareErr}`,
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
      summary: ["Khong the sua video prompt.", `Loi: ${promptErr.message || promptErr}`].join("\n"),
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
          context.registry.byId.pho_phong?.transport?.sessionKey
          || buildWorkflowScopedSessionKey("pho_phong", state.workflow_id, "root"),
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
      summary: ["Khong the sua video quang cao.", `Loi: ${videoErr.message || videoErr}`].join(
        "\n",
      ),
      data: { error: videoErr.message || String(videoErr) },
    });
  }

  let videoMedia;
  try {
    videoMedia = videoAgent.parseVideoResult(videoReply, {
      productImage: revisingState.content?.primaryProductImage || "",
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
        "Media_Video da tao video moi nhung he thong khong doc duoc ket qua.",
        `Loi: ${parseErr.message || parseErr}`,
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
  markWorkflowStageNotified(context.paths, state.workflow_id, "awaiting_video_approval", "sync");

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary,
    humanMessage: summary,
    data: {
      media: mergedMedia,
      prompt_package: mergedPromptPackage,
      next_expected_action: "video_approval",
    },
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

  const summaryLines = [`${actionLabel} that bai tren Facebook.`, `Loi: ${errorMessage}`];

  if (isPermissionError) {
    summaryLines.push(
      "Goi y: Kiem tra FACEBOOK_PAGE_ACCESS_TOKEN co dung voi FACEBOOK_PAGE_ID va co quyen pages_manage_posts/pages_read_engagement.",
    );
  }

  summaryLines.push(
    'Thu lai: "Dang ngay" hoac "Hen gio <thoi gian>" sau khi cap nhat quyen/token.',
  );
  return summaryLines.join("\n");
}

function enforceDefaultVideoPrompt(promptPackage, forceTemplate = false) {
  if (!promptPackage || !forceTemplate) {
    return promptPackage;
  }
  return {
    ...promptPackage,
    videoPrompt: DEFAULT_VIDEO_PROMPT_TEMPLATE,
  };
}

/**
 * ÄÄƒng bÃ i ngay.
 */
function publishNowAction(context, state) {
  logger.logPhase("Đăng bài", "Đang đăng bài lên Fanpage...");

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
    const summary = buildPublishFailureSummary("Đăng ngay", publishError);
    return buildResult({
      workflowId: state.workflow_id,
      stage: failedState.stage,
      status: "error",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "publish_decision" },
    });
  }

  const postIds = publisher.extractPostIds(publishResult);
  const postId = postIds[0] || "";

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
    "ðŸ“¤ BÃ i viáº¿t Ä‘Ã£ Ä‘Æ°á»£c Ä‘Äƒng thÃ nh cÃ´ng lÃªn Fanpage!",
    postIds.length > 1 ? `Post IDs: ${postIds.join(", ")}` : postId ? `Post ID: ${postId}` : "",
    `Media: ${mediaPaths.join(", ") || "khÃ´ng cÃ³"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const normalizedSummary = normalizePublishedSummaryText(summary);

  return buildResult({
    workflowId: state.workflow_id,
    stage: "published",
    summary: normalizedSummary,
    humanMessage: normalizedSummary,
    data: { post_id: postId, post_ids: postIds, media_paths: mediaPaths, publish_result: publishResult },
  });
}

/**
 * Háº¹n giá» Ä‘Äƒng bÃ i.
 */
function schedulePostAction(context, state) {
  const scheduleTime = state.intent?.schedule_time || context.scheduleTime || context.message;

  logger.logPhase("Háº¸N GIá»œ", `Äang háº¹n giá» Ä‘Äƒng bÃ i: ${scheduleTime}`);

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
    const summary = buildPublishFailureSummary("Hẹn giờ đăng bài", scheduleError);
    return buildResult({
      workflowId: state.workflow_id,
      stage: failedState.stage,
      status: "error",
      summary,
      humanMessage: summary,
      data: { next_expected_action: "publish_decision" },
    });
  }

  const postIds = publisher.extractPostIds(scheduleResult);
  const postId = postIds[0] || "";

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
    "ðŸ“… BÃ i viáº¿t Ä‘Ã£ Ä‘Æ°á»£c háº¹n giá» Ä‘Äƒng thÃ nh cÃ´ng!",
    `Thá»i gian: ${scheduleTime}`,
    postIds.length > 1 ? `Post IDs: ${postIds.join(", ")}` : postId ? `Post ID: ${postId}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult({
    workflowId: state.workflow_id,
    stage: "scheduled",
    summary,
    humanMessage: summary,
    data: { post_id: postId, post_ids: postIds, schedule_time: scheduleTime, schedule_result: scheduleResult },
  });
}

/**
 * Sá»­a bÃ i Ä‘Ã£ Ä‘Äƒng (EDIT_PUBLISHED intent).
 */
async function editPublishedFlow(context) {
  const workflowId = `wf_edit_${randomUUID()}`;
  const stepId = "step_edit_content";
  const postId = context.intent?.post_id;

  if (!postId) {
    return buildResult({
      status: "blocked",
      summary:
        'âš ï¸ Cáº§n cung cáº¥p Post ID cá»§a bÃ i viáº¿t muá»‘n sá»­a. VÃ­ dá»¥: "Sá»­a bÃ i Ä‘Ã£ Ä‘Äƒng, post ID: 643048852218433_123456"',
    });
  }

  logger.logPhase("Sá»¬A BÃ€I ÄÃƒ ÄÄ‚NG", `Post ID: ${postId}`);
  logger.logHandoff(
    "PhÃ³ phÃ²ng",
    "NV Content",
    logger.buildHumanMessage("pho_phong", "nv_content", "edit_post", context.message.slice(0, 80)),
  );

  const prompt = contentAgent.buildContentRevisePrompt({
    workflowId,
    stepId,
    originalBrief: context.message,
    feedback: context.message,
    oldContent: "(BÃ i cÅ© trÃªn Facebook â€” viáº¿t má»›i theo yÃªu cáº§u sáº¿p)",
    openClawHome: context.openClawHome,
  });

  const contentCheckpoint = await runContentCheckpointStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt,
  });
  const content = contentCheckpoint.content;

  // LÆ°u state chá» duyá»‡t ná»™i dung má»›i trÆ°á»›c khi update lÃªn FB
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
    "âœï¸ NV Content Ä‘Ã£ viáº¿t ná»™i dung má»›i cho bÃ i Ä‘Ã£ Ä‘Äƒng, Ä‘ang chá» Sáº¿p duyá»‡t.",
    `Post ID sáº½ cáº­p nháº­t: ${postId}`,
    "",
    "â”â”â” Ná»˜I DUNG Má»šI â”â”â”",
    content.approvedContent,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "",
    'ðŸ‘‰ Duyá»‡t: "Duyá»‡t content" â€” ná»™i dung sáº½ Ä‘Æ°á»£c cáº­p nháº­t lÃªn Facebook',
    "ðŸ‘‰ Sá»­a: ghi rÃµ nháº­n xÃ©t",
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
 * Xá»­ lÃ½ approve cho bÃ i edit â†’ gá»i facebook_edit_post.
 */
function applyEditToPublished(context, state) {
  const postId = state.post_id;

  logger.logPhase("Cáº¬P NHáº¬T BÃ€I ÄÃƒ ÄÄ‚NG", `Äang cáº­p nháº­t post ${postId}...`);

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
    "âœï¸ BÃ i viáº¿t trÃªn Facebook Ä‘Ã£ Ä‘Æ°á»£c cáº­p nháº­t thÃ nh cÃ´ng!",
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
 * Xá»­ lÃ½ intent TRAIN â€” ghi quy táº¯c thá»§ cÃ´ng.
 */
function handleTrainIntent(context) {
  const feedback = context.intent?.feedback_or_brief || context.message;
  const targetAgent = context.intent?.target_agent;

  logger.logPhase("TRAINING", `Sáº¿p dáº¡y quy táº¯c má»›i`);

  const results = [];

  // Ghi rule cho agent Ä‘Æ°á»£c chá»‰ Ä‘á»‹nh, hoáº·c cáº£ hai náº¿u "self"
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
    "ðŸ§  ÄÃ£ ghi nhá»› quy táº¯c má»›i!",
    `Ãp dá»¥ng cho: ${results.join(", ")}`,
    `Ná»™i dung: "${feedback.slice(0, 200)}"`,
    "",
    "Quy táº¯c nÃ y sáº½ tá»± Ä‘á»™ng Ä‘Æ°á»£c nhÃºng vÃ o prompt má»—i khi nhÃ¢n viÃªn lÃ m viá»‡c.",
  ].join("\n");

  return buildResult({
    status: "ok",
    stage: "trained",
    summary,
    humanMessage: summary,
    data: { trained_agents: results, rule: feedback },
  });
}

// â”€â”€â”€ MAIN ROUTING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Xá»­ lÃ½ workflow Ä‘ang pending.
 */
async function continueWorkflow(context, state) {
  state = migrateState(state);
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

  if (state.stage === "revising_video") {
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_video_approval") {
      markWorkflowStageNotified(
        context.paths,
        state.workflow_id,
        recoveredState.stage,
        "recovered",
      );
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (!hasAsyncStageExceededGrace(state.video_revising_started_at, getMediaTimeoutMs(context.options.timeoutMs))) {
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

    saveWorkflow(context.paths, { ...state, stage: "awaiting_video_approval" });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_video_approval",
      status: "error",
      summary: [
        "Buoc sua video bi ngat giua chung, chua co video moi.",
        "",
        "Gui lai nhan xet de thu sua video lan nua.",
      ].join("\n"),
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
      markWorkflowStageNotified(
        context.paths,
        state.workflow_id,
        recoveredState.stage,
        "recovered",
      );
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (!hasAsyncStageExceededGrace(state.video_generating_started_at, getMediaTimeoutMs(context.options.timeoutMs))) {
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

    saveWorkflow(context.paths, { ...state, stage: "awaiting_publish_decision" });
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_publish_decision",
      status: "error",
      summary: [
        "Buoc tao video bi ngat giua chung, chua co file video nao.",
        "",
        'Thu lai: "Tao video"',
      ].join("\n"),
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
      markWorkflowStageNotified(
        context.paths,
        state.workflow_id,
        recoveredState.stage,
        "recovered",
      );
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (!hasAsyncStageExceededGrace(state.revising_started_at, getMediaTimeoutMs(context.options.timeoutMs))) {
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
    const recoveredState = await tryRecoverAsyncStageState({
      openClawHome: context.openClawHome,
      state,
      paths: context.paths,
      registry: context.registry,
    });
    if (recoveredState?.stage === "awaiting_media_approval") {
      markWorkflowStageNotified(
        context.paths,
        state.workflow_id,
        recoveredState.stage,
        "recovered",
      );
      return buildRecoveredAsyncStageResult(recoveredState);
    }

    if (!hasAsyncStageExceededGrace(state.generating_started_at, getMediaTimeoutMs(context.options.timeoutMs))) {
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
      "He thong van dang render media, chua thay file media moi.",
      "",
      "Toi se tiep tuc doi va gui anh ngay khi co ket qua.",
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
            // Bá» file cÅ© náº¿u Ä‘Æ°á»£ng dáº«n khá»›p vá»›i ná»n cÅ© (trÆ°á»›c khi revise)
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
      logger.log("media", `âœ… Phá»¥c há»“i áº£nh sá»­a tá»« lÆ°á»£t trÆ°á»›c: ${latestImage}`);
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
        "ðŸŽ¨ ÄÃ£ phá»¥c há»“i áº£nh sá»­a tá»« lÆ°á»£t trÆ°á»›c, Ä‘ang chá» Sáº¿p duyá»‡t.",
        recoveredMedia.composited
          ? "âœ… ÄÃ£ ghÃ©p: Ná»n AI má»›i + Sáº£n pháº©m tháº­t + Logo"
          : "",
        "",
        `ðŸ–¼ï¸ Xem áº£nh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        'ðŸ‘‰ Duyá»‡t vÃ  Ä‘Äƒng bÃ i: "Duyá»‡t áº£nh vÃ  Ä‘Äƒng bÃ i"',
        "ðŸ‘‰ Sá»­a tiáº¿p: ghi rÃµ nháº­n xÃ©t",
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

    // KhÃ´ng cÃ³ áº£nh má»›i â€” quay láº¡i awaiting_media_approval vá»›i áº£nh cÅ©
    saveWorkflow(context.paths, { ...state, stage: "awaiting_media_approval" });
    const summary = [
      "âŒ BÆ°á»›c sá»­a áº£nh bá»‹ ngáº¯t giá»¯a chá»«ng, chÆ°a cÃ³ áº£nh má»›i.",
      "",
      "ðŸ‘‰ Nháº¯n láº¡i nháº­n xÃ©t Ä‘á»ƒ thá»­ sá»­a áº£nh láº§n ná»¯a",
    ].join("\n");
    return buildResult({
      workflowId: state.workflow_id,
      stage: "awaiting_media_approval",
      status: "error",
      summary,
      humanMessage: summary,
    });
  }

  // generating_media â€” Äang táº¡o áº£nh, cháº·n loop.
  // Stage nÃ y Ä‘Æ°á»£c set ngay trÆ°á»›c khi gá»i NV Media. Náº¿u orchestrator
  // crash sau khi cÃ³ áº£nh nhÆ°ng trÆ°á»›c khi save, láº§n sau sáº½ vÃ o bá»™ nÃ y.
  if (state.stage === "generating_media") {
    // Æ¯u tiÃªn dÃ¹ng Ä‘Æ°á»ng dáº«n Ä‘Ã£ lÆ°u trong state (chÃ­nh xÃ¡c, khÃ´ng nháº§m workflow cÅ©)
    const savedBg = state.generating_bg_image_path || "";
    const savedProduct =
      state.generating_product_image_path || state.content?.primaryProductImage || "";

    let bgImagePath = "";
    if (savedBg && fs.existsSync(savedBg)) {
      bgImagePath = savedBg;
      logger.log("media", `âœ… DÃ¹ng path ná»n Ä‘Ã£ lÆ°u trong state: ${bgImagePath}`);
    } else {
      // Fallback: scan thÆ° má»¥c, chá»‰ láº¥y áº£nh Ä‘Æ°á»£c táº¡o sau khi báº¯t Ä‘áº§u workflow
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
              return mtime >= startedAt; // chá»‰ láº¥y file má»›i hÆ¡n thá»i Ä‘iá»ƒm báº¯t Ä‘áº§u
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
      logger.log("media", `âœ… Phá»¥c há»“i: cháº¡y láº¡i composite vá»›i ná»n: ${bgImagePath}`);
      let finalPath = bgImagePath;
      if (savedProduct && fs.existsSync(savedProduct)) {
        try {
          const compositePath = await mediaAgent.compositeImage3Layers({
            backgroundPath: bgImagePath,
            productImagePath: savedProduct,
            outputPath: bgImagePath.replace(/(\.[a-z]+)$/i, "_final$1"),
          });
          finalPath = compositePath;
          logger.log("media", `âœ… GhÃ©p 3 lá»›p thÃ nh cÃ´ng: ${compositePath}`);
        } catch (compErr) {
          process.stderr.write(`[COMPOSITE_RECOVERY_ERROR] ${compErr.stack || compErr.message}\n`);
          logger.logError("composite", compErr);
          logger.log("info", "âš ï¸ DÃ¹ng áº£nh ná»n gá»‘c (composite tháº¥t báº¡i).");
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
        "ðŸŽ¨ ÄÃ£ ghÃ©p xong áº£nh, Ä‘ang chá» Sáº¿p duyá»‡t.",
        recoveredMedia.composited
          ? "âœ… ÄÃ£ ghÃ©p: Ná»n AI + Sáº£n pháº©m tháº­t + Logo"
          : "âš ï¸ Chá»‰ cÃ³ áº£nh ná»n AI (chÆ°a ghÃ©p sáº£n pháº©m).",
        "",
        `ðŸ–¼ï¸ Xem áº£nh: ${finalLink}`,
        `File: ${finalPath}`,
        "",
        'ðŸ‘‰ Duyá»‡t vÃ  Ä‘Äƒng bÃ i: "Duyá»‡t áº£nh vÃ  Ä‘Äƒng bÃ i"',
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

    // KhÃ´ng tÃ¬m tháº¥y áº£nh nÃ o â€” quay vá» step trÆ°á»›c, cho phÃ©p re-trigger
    saveWorkflow(context.paths, {
      ...state,
      stage: "awaiting_content_approval",
    });
    const noImgSummary = [
      "âŒ BÆ°á»›c táº¡o áº£nh bá»‹ ngáº¯t giá»¯a chá»«ng, chÆ°a cÃ³ file áº£nh nÃ o.",
      "",
      'ðŸ‘‰ Thá»­ láº¡i: "Duyá»‡t content, táº¡o áº£nh"',
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
    // Unknown â€” thá»­ parse intent náº¿u lÃ  lá»‡nh má»›i hoÃ n toÃ n
    return buildBlockedResult(state, context.message);
  }

  // awaiting_media_approval
  if (state.stage === "awaiting_media_approval") {
    if (context.intent?.intent === "EDIT_CONTENT") {
      return reviseContent(context, { ...state, stage: "awaiting_content_approval" });
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

  // Unknown stage â€” archive and restart
  archiveWorkflow(context.paths, state);
  return startNewWorkflow(context);
}

function buildBlockedResult(state, message) {
  const stageLabels = {
    awaiting_content_approval: "Ä‘ang chá» duyá»‡t content",
    awaiting_media_approval: "Ä‘ang chá» duyá»‡t media",
    awaiting_video_approval: "Ä‘ang chá» duyá»‡t video",
    awaiting_publish_decision: "Ä‘ang chá» quyáº¿t Ä‘á»‹nh Ä‘Äƒng bÃ i",
    awaiting_edit_approval: "Ä‘ang chá» duyá»‡t ná»™i dung sá»­a",
    generating_media: "Ä‘ang táº¡o áº£nh (vui lÃ²ng Ä‘á»£i)",
    generating_video: "Ä‘ang táº¡o video (vui lÃ²ng Ä‘á»£i)",
    revising_video: "Ä‘ang sua video (vui lÃ²ng Ä‘á»£i)",
  };
  const stageLabel = stageLabels[state?.stage] || "Ä‘ang chá» xá»­ lÃ½";

  return buildResult({
    workflowId: state?.workflow_id || null,
    stage: state?.stage || null,
    status: "blocked",
    summary: [
      `â³ Äang cÃ³ workflow pending: ${stageLabel}.`,
      `Tin nháº¯n "${message.slice(0, 100)}" chÆ°a Ä‘Æ°á»£c nháº­n diá»‡n rÃµ.`,
      "",
      "Gá»£i Ã½ lá»‡nh phÃ¹ há»£p:",
      state?.stage === "awaiting_content_approval"
        ? '  â€¢ "Duyá»‡t content" / "Sá»­a content, <nháº­n xÃ©t>"'
        : state?.stage === "awaiting_media_approval"
          ? '  â€¢ "Duyá»‡t áº£nh" / "Sá»­a áº£nh, <nháº­n xÃ©t>" / "Sá»­a prompt, <nháº­n xÃ©t>"'
          : state?.stage === "awaiting_video_approval"
            ? '  â€¢ "Duyá»‡t video" / "Sá»­a video, <nháº­n xÃ©t>" / "Sá»­a prompt video, <nháº­n xÃ©t>"'
            : state?.stage === "awaiting_publish_decision"
              ? '  â€¢ "Táº¡o video" / "ÄÄƒng ngay" / "Háº¹n giá» <thá»i gian>"'
              : '  â€¢ "Duyá»‡t" / "Sá»­a"',
    ].join("\n"),
    data: { expected_stage: state?.stage || null },
  });
}

// â”€â”€â”€ CLI ENTRY POINT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.autoNotifyWatch) {
    await runAutoNotifyWatcher(options);
    return;
  }
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
        summary: "ðŸ”„ ÄÃ£ reset workflow pending cá»§a agent-orchestrator-test.",
        humanMessage: "ðŸ”„ ÄÃ£ reset workflow pending.",
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
        summary: "Da huy workflow dang pending.",
        humanMessage: "Workflow da duoc huy thanh cong. Ban co the bat dau brief moi bat cu luc nao.",
      });
    } else {
      result = buildResult({
        status: "ok",
        summary: "Khong co workflow dang chay.",
        humanMessage: "Hien khong co workflow nao dang pending. Ban co the gui brief moi de bat dau.",
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

  await syncRootMessageFromResult(context, result);
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

// â”€â”€â”€ BACKWARD-COMPATIBLE EXPORTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  continueWorkflow,
  buildStageHumanMessage,
  buildWorkflowScopedSessionKey,
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
  scanLatestGeneratedMedia,
  syncRootMessageFromResult,
  shouldSupersedePendingWorkflow,
  validateContentCheckpointReply,
  waitForValidContentCheckpoint,
  migrateState,
};
