/**
 * logger.js - Human-readable logging for the orchestrator.
 *
 * Interactive runs can print progress to stderr. JSON mode must stay
 * machine-safe, so stderr logging can be disabled at runtime.
 */

const ICONS = {
  start: "[START]",
  handoff: "[HANDOFF]",
  wait: "[WAIT]",
  approve: "[APPROVE]",
  reject: "[REJECT]",
  learn: "[LEARN]",
  publish: "[PUBLISH]",
  schedule: "[SCHEDULE]",
  edit: "[EDIT]",
  media: "[MEDIA]",
  content: "[CONTENT]",
  error: "[ERROR]",
  info: "[INFO]",
  video: "[VIDEO]",
  trend: "[TREND]",
};

let loggingEnabled = true;
let syncContext = null;

function timestamp() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function separator() {
  return "-".repeat(60);
}

function write(text) {
  if (!loggingEnabled) {
    return;
  }
  process.stderr.write(String(text || ""));
}

function log(icon, message) {
  const prefix = ICONS[icon] || "[LOG]";
  write(`${prefix} [${timestamp()}] ${String(message || "")}\n`);
}

function logPhase(phase, humanMessage) {
  write(`\n${separator()}\n`);
  log("start", `PHASE: ${phase}`);
  if (humanMessage) {
    write(`   ${humanMessage}\n`);
  }
  write(`${separator()}\n`);
}

function logHandoff(from, to, humanMessage) {
  log("handoff", `${from} -> ${to}`);
  write(`   "${humanMessage}"\n`);
}

function logApprovalWait(stage, preview) {
  write("\n");
  log("wait", `DANG CHO DUYET - Giai doan: ${stage}`);
  if (!preview) {
    return;
  }

  write(`\n${separator()}\n`);
  write("NOI DUNG CHO DUYET:\n\n");

  const previewText = String(preview).trim();
  if (previewText.length > 2000) {
    write(`${previewText.slice(0, 2000)}\n...[rut gon]\n`);
  } else {
    write(`${previewText}\n`);
  }

  write(`${separator()}\n`);
}

function logApproved(stage) {
  log("approve", `User da DUYET giai doan: ${stage}`);
}

function logRejected(stage, feedback) {
  log("reject", `User da TU CHOI giai doan: ${stage}`);
  if (feedback) {
    write(`   Nhan xet: "${feedback}"\n`);
  }
  postAutomationEvent(`Bị từ chối giai đoạn: ${stage}. Nhận xét: ${feedback || ""}`, "assistant", "regular");
}

function logLearning(agentId, rule) {
  log("learn", `${agentId} tu hoc quy tac moi`);
  write(`   Quy tac: "${rule}"\n`);
}

function logError(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  log("error", `LOI tai ${stage}: ${message}`);
}

function logPublished(postId) {
  log("publish", "Bai viet da duoc dang thanh cong.");
  if (postId) {
    write(`   Post ID: ${postId}\n`);
  }
}

function logScheduled(scheduleTime) {
  log("schedule", "Bai viet da duoc hen gio dang.");
  if (scheduleTime) {
    write(`   Thoi gian: ${scheduleTime}\n`);
  }
}

function logEdited(postId) {
  log("edit", "Bai viet da duoc cap nhat.");
  if (postId) {
    write(`   Post ID: ${postId}\n`);
  }
}

function logIntent(intent) {
  log("info", `Y dinh nhan dien: ${intent.intent}`);
  if (intent.media_type_requested && intent.media_type_requested !== "image") {
    write(`   Loai media: ${intent.media_type_requested}\n`);
  }
  if (intent.target_agent) {
    write(`   Nhan vien phu trach: ${intent.target_agent}\n`);
  }
}

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
  if (action === "video_prepare_prompt") {
    return "Content va anh da duyet, Media_Video tiep nhan brief video va chot yeu cau gui NV Prompt.";
  }
  if (action === "media_prepare_revise") {
    return `NV Media tiep nhan feedback media va tong hop lai yeu cau prompt: ${detail}`;
  }
  if (action === "video_prepare_revise") {
    return `Media_Video tiep nhan feedback video va tong hop lai yeu cau prompt: ${detail}`;
  }
  if (action === "prompt_from_media") {
    return `NV Media gui brief cho NV Prompt de viet prompt ${detail || "media"} chi tiet.`;
  }
  if (action === "prompt_from_video") {
    return `Media_Video gui brief cho NV Prompt de viet prompt ${detail || "video"} chi tiet.`;
  }
  if (action === "prompt_back_to_media") {
    return `NV Prompt da viet xong prompt ${detail || "media"}, chuyen lai cho NV Media thuc thi.`;
  }
  if (action === "prompt_back_to_video") {
    return `NV Prompt da viet xong prompt ${detail || "video"}, chuyen lai cho Media_Video thuc thi.`;
  }

  const messages = {
    content_draft: `Sep vua giao bai moi, anh em Content nhan brief va lam nhe: ${detail}`,
    content_revise: `Content can sua lai theo nhan xet: ${detail}`,
    media_generate: "Content da duoc duyet, anh em Media vao tao anh nhe!",
    media_revise: `Anh can sua lai theo nhan xet: ${detail}`,
    publish: "Tat ca da duoc duyet, dang bai len Fanpage luon!",
    schedule: "Tat ca da duoc duyet, hen gio dang bai theo lich!",
    edit_post: "Sep muon sua bai da dang, anh em Content cap nhat lai nhe!",
    learn_rule: "Rut kinh nghiem tu lan sua nay, ghi lai quy tac moi.",
  };

  return messages[action] || `${from} giao viec cho ${to}: ${detail || action}`;
}

function setEnabled(enabled) {
  loggingEnabled = enabled !== false;
}

function isEnabled() {
  return loggingEnabled;
}

function setSyncContext(context) {
  syncContext = context && typeof context === "object" ? { ...context } : null;
}

function postAutomationEvent(content, role = "assistant", type = "regular") {
  if (!syncContext) {
    return;
  }
  const beClient = require("./be-client");
  void beClient.pushAutomationEvent({
    ...syncContext,
    role,
    type,
    content,
    timestamp: Date.now(),
  }).catch(() => {
    // Logging must not break orchestration.
  });
}

module.exports = {
  buildHumanMessage,
  isEnabled,
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
  setEnabled,
};
