/**
 * logger.js — Human-readable logging cho workflow orchestrator.
 *
 * Mọi output terminal đều bằng tiếng Việt tự nhiên, không in raw JSON.
 * Mỗi payload giữa các agent đều kèm trường human_message.
 */

const ICONS = {
  start: "🚀",
  handoff: "📋",
  wait: "⏳",
  approve: "✅",
  reject: "❌",
  learn: "🧠",
  publish: "📤",
  schedule: "📅",
  edit: "✏️",
  media: "🎨",
  content: "📝",
  error: "💥",
  info: "ℹ️",
  video: "🎬",
  trend: "📊",
};

const SYNC_ENDPOINT = process.env.OPENCLAW_SYNC_API_URL || "http://localhost:3001/api/automation/agent-event";
const SYNC_TOKEN = process.env.OPENCLAW_SYNC_TOKEN || "";
const DEFAULT_SYNC_EMPLOYEE = process.env.OPENCLAW_SYNC_EMPLOYEE_ID || "pho_phong";
const DEFAULT_SYNC_AGENT = process.env.OPENCLAW_SYNC_AGENT_ID || "pho_phong";

const syncContext = {
  workflowId: null,
  employeeId: DEFAULT_SYNC_EMPLOYEE,
  agentId: DEFAULT_SYNC_AGENT,
  title: "",
};
let eventSequence = 0;

function stripVietnamese(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inferAgentIdFromLabel(label, fallback) {
  const normalized = stripVietnamese(label);
  if (!normalized) return fallback;
  if (normalized.includes("pho phong")) return "pho_phong";
  if (normalized.includes("content")) return "nv_content";
  if (normalized.includes("media")) return "nv_media";
  if (normalized.includes("prompt")) return "nv_prompt";
  if (normalized.includes("consultant") || normalized.includes("cskh")) return "nv_consultant";
  if (normalized.includes("quan ly")) return "quan_ly";
  if (normalized.includes("truong phong")) return "truong_phong";
  return fallback;
}

function timestamp() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function separator() {
  return "─".repeat(60);
}

/**
 * In một dòng log chung với icon + timestamp.
 */
function log(icon, message) {
  const prefix = ICONS[icon] || "•";
  process.stderr.write(`${prefix} [${timestamp()}] ${message}\n`);
}

function setSyncContext(context = {}) {
  syncContext.workflowId = context.workflowId || syncContext.workflowId || null;
  syncContext.employeeId = context.employeeId || syncContext.employeeId || DEFAULT_SYNC_EMPLOYEE;
  syncContext.agentId = context.agentId || syncContext.agentId || DEFAULT_SYNC_AGENT;
  syncContext.title = context.title || syncContext.title || "";
}

function postAutomationEvent(content, role = "assistant", type = "regular", overrides = {}) {
  if (!syncContext.workflowId) return;
  eventSequence += 1;
  const timestampMs = Date.now();
  const effectiveEmployeeId = overrides.employeeId || syncContext.employeeId;
  const effectiveAgentId = overrides.agentId || syncContext.agentId;
  const effectiveWorkflowId = overrides.workflowId || syncContext.workflowId;
  const eventId = overrides.eventId || `evt_${effectiveWorkflowId}_${String(eventSequence).padStart(6, "0")}`;
  const payload = {
    eventId,
    workflowId: effectiveWorkflowId,
    employeeId: effectiveEmployeeId,
    agentId: effectiveAgentId,
    title: overrides.title || syncContext.title || `[AUTO] ${effectiveAgentId} • ${effectiveWorkflowId}`,
    type,
    content: String(content || "").slice(0, 4000),
    timestamp: timestampMs,
  };
  const headers = { "Content-Type": "application/json" };
  if (SYNC_TOKEN) {
    headers["x-automation-sync-token"] = SYNC_TOKEN;
  }

  const sendOnce = (attempt) => fetch(SYNC_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`Automation sync failed: ${res.status}`);
    }
  }).catch((error) => {
    if (attempt >= 3) {
      return;
    }
    const waitMs = attempt * 400;
    setTimeout(() => {
      sendOnce(attempt + 1).catch(() => {});
    }, waitMs);
  });

  sendOnce(1).catch(() => {});
}

/**
 * Log bắt đầu một phase mới trong workflow.
 */
function logPhase(phase, humanMessage) {
  process.stderr.write(`\n${separator()}\n`);
  log("start", `PHASE: ${phase}`);
  if (humanMessage) {
    process.stderr.write(`   ${humanMessage}\n`);
    postAutomationEvent(`${phase}: ${humanMessage}`, "assistant", "manager_note");
  }
  process.stderr.write(`${separator()}\n`);
}

/**
 * Log khi Phó phòng giao việc cho nhân viên.
 */
function logHandoff(from, to, humanMessage) {
  log("handoff", `${from} → ${to}`);
  process.stderr.write(`   "${humanMessage}"\n`);

  const fromAgentId = inferAgentIdFromLabel(from, syncContext.agentId);
  const toAgentId = inferAgentIdFromLabel(to, syncContext.agentId);

  // Feed manager/supervisor timeline
  postAutomationEvent(`${from} → ${to}: ${humanMessage}`, "assistant", "regular", {
    employeeId: fromAgentId,
    agentId: fromAgentId,
    title: `[AUTO] ${fromAgentId} • ${syncContext.workflowId}`,
  });

  // Feed assignee timeline so employee has its own automation conversation
  postAutomationEvent(`Nhiem vu moi tu ${from}: ${humanMessage}`, "assistant", "regular", {
    employeeId: toAgentId,
    agentId: toAgentId,
    title: `[AUTO] ${toAgentId} • ${syncContext.workflowId}`,
  });
}

/**
 * Log khi hệ thống dừng chờ User duyệt.
 */
function logApprovalWait(stage, preview) {
  process.stderr.write(`\n`);
  log("wait", `ĐANG CHỜ DUYỆT — Giai đoạn: ${stage}`);
  if (preview) {
    process.stderr.write(`\n${separator()}\n`);
    process.stderr.write(`NỘI DUNG CHỜ DUYỆT:\n\n`);
    const previewText = String(preview).trim();
    // Giới hạn preview ~ 2000 ký tự cho terminal
    if (previewText.length > 2000) {
      process.stderr.write(`${previewText.slice(0, 2000)}\n...[rút gọn]\n`);
    } else {
      process.stderr.write(`${previewText}\n`);
    }
    process.stderr.write(`${separator()}\n`);
  }
  postAutomationEvent(`Đang chờ duyệt (${stage}).`, "assistant", "approval_request");
}

/**
 * Log khi User phê duyệt.
 */
function logApproved(stage) {
  log("approve", `User đã DUYỆT giai đoạn: ${stage}`);
  postAutomationEvent(`Đã duyệt giai đoạn: ${stage}`, "assistant", "regular");
}

/**
 * Log khi User từ chối.
 */
function logRejected(stage, feedback) {
  log("reject", `User ĐÃ TỪ CHỐI giai đoạn: ${stage}`);
  if (feedback) {
    process.stderr.write(`   Nhận xét: "${feedback}"\n`);
  }
  postAutomationEvent(`Bị từ chối giai đoạn: ${stage}. Nhận xét: ${feedback || ""}`, "assistant", "regular");
}

/**
 * Log khi hệ thống học từ feedback (ghi vào memory).
 */
function logLearning(agentId, rule) {
  log("learn", `${agentId} tự học quy tắc mới`);
  process.stderr.write(`   Quy tắc: "${rule}"\n`);
}

/**
 * Log lỗi.
 */
function logError(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  log("error", `LỖI tại ${stage}: ${message}`);
}

/**
 * Log publish thành công.
 */
function logPublished(postId) {
  log("publish", `Bài viết đã được đăng thành công!`);
  if (postId) {
    process.stderr.write(`   Post ID: ${postId}\n`);
  }
}

/**
 * Log schedule thành công.
 */
function logScheduled(scheduleTime) {
  log("schedule", `Bài viết đã được hẹn giờ đăng!`);
  if (scheduleTime) {
    process.stderr.write(`   Thời gian: ${scheduleTime}\n`);
  }
}

/**
 * Log edit bài đã đăng.
 */
function logEdited(postId) {
  log("edit", `Bài viết đã được cập nhật!`);
  if (postId) {
    process.stderr.write(`   Post ID: ${postId}\n`);
  }
}

/**
 * Log intent đã parse được.
 */
function logIntent(intent) {
  log("info", `Ý định nhận diện: ${intent.intent}`);
  if (intent.media_type_requested && intent.media_type_requested !== "image") {
    process.stderr.write(`   Loại media: ${intent.media_type_requested}\n`);
  }
  if (intent.target_agent) {
    process.stderr.write(`   Nhân viên phụ trách: ${intent.target_agent}\n`);
  }
}

/**
 * Build trường human_message cho payload giao tiếp giữa agent.
 */
function buildHumanMessage(from, to, action, detail) {
  if (action === "prompt_draft") {
    return `Content da duyet, NV Prompt viet prompt ${detail || "media"} theo bo quy tac hien tai.`;
  }
  if (action === "prompt_revise") {
    return `Prompt media can duoc viet lai theo nhan xet moi: ${detail}`;
  }
  if (action === "media_prepare_prompt") {
    return "Content da duyet, NV Media tiep nhan brief media va chot yeu cau gui NV Prompt.";
  }
  if (action === "media_prepare_revise") {
    return `NV Media tiep nhan feedback media va tong hop lai yeu cau prompt: ${detail}`;
  }
  if (action === "prompt_from_media") {
    return `NV Media gui brief cho NV Prompt de viet prompt ${detail || "media"} chi tiet.`;
  }
  if (action === "prompt_back_to_media") {
    return `NV Prompt da viet xong prompt ${detail || "media"}, chuyen lai cho NV Media thuc thi.`;
  }
  const messages = {
    content_draft: `Sếp vừa giao bài mới, anh em Content nhận brief và làm nhé: ${detail}`,
    content_revise: `Content cần sửa lại theo nhận xét: ${detail}`,
    media_generate: `Content đã được duyệt, anh em Media vào tạo ảnh nhé!`,
    media_revise: `Ảnh cần sửa lại theo nhận xét: ${detail}`,
    publish: `Tất cả đã được duyệt, đăng bài lên Fanpage luôn!`,
    schedule: `Tất cả đã được duyệt, hẹn giờ đăng bài theo lịch!`,
    edit_post: `Sếp muốn sửa bài đã đăng, anh em Content cập nhật lại nhé!`,
    learn_rule: `Rút kinh nghiệm từ lần sửa này, ghi lại quy tắc mới.`,
  };
  return messages[action] || `${from} giao việc cho ${to}: ${detail || action}`;
}

module.exports = {
  buildHumanMessage,
  log,
  setSyncContext,
  logApprovalWait,
  logApproved,
  logEdited,
  logError,
  logHandoff,
  logIntent,
  logLearning,
  logPhase,
  logPublished,
  logRejected,
  logScheduled,
};
