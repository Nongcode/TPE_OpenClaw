/**
 * logger.js - Human-readable logging cho workflow orchestrator.
 *
 * Moi output terminal deu bang tieng Viet tu nhien, khong in raw JSON.
 * Moi payload giua cac agent deu kem truong human_message.
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

function timestamp() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function separator() {
  return "─".repeat(60);
}

function log(icon, message) {
  const prefix = ICONS[icon] || "•";
  process.stderr.write(`${prefix} [${timestamp()}] ${String(message || "")}\n`);
}

function logPhase(phase, humanMessage) {
  process.stderr.write(`\n${separator()}\n`);
  log("start", `PHASE: ${phase}`);
  if (humanMessage) {
    process.stderr.write(`   ${humanMessage}\n`);
  }
  process.stderr.write(`${separator()}\n`);
}

function logHandoff(from, to, humanMessage) {
  log("handoff", `${from} → ${to}`);
  process.stderr.write(`   "${humanMessage}"\n`);
}

function logApprovalWait(stage, preview) {
  process.stderr.write("\n");
  log("wait", `ĐANG CHỜ DUYỆT - Giai đoạn: ${stage}`);
  if (!preview) return;

  process.stderr.write(`\n${separator()}\n`);
  process.stderr.write("NỘI DUNG CHỜ DUYỆT:\n\n");

  const previewText = String(preview).trim();
  if (previewText.length > 2000) {
    process.stderr.write(`${previewText.slice(0, 2000)}\n...[rút gọn]\n`);
  } else {
    process.stderr.write(`${previewText}\n`);
  }

  process.stderr.write(`${separator()}\n`);
}

function logApproved(stage) {
  log("approve", `User đã DUYỆT giai đoạn: ${stage}`);
}

function logRejected(stage, feedback) {
  log("reject", `User ĐÃ TỪ CHỐI giai đoạn: ${stage}`);
  if (feedback) {
    process.stderr.write(`   Nhận xét: "${feedback}"\n`);
  }
}

function logLearning(agentId, rule) {
  log("learn", `${agentId} tự học quy tắc mới`);
  process.stderr.write(`   Quy tắc: "${rule}"\n`);
}

function logError(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  log("error", `LỖI tại ${stage}: ${message}`);
}

function logPublished(postId) {
  log("publish", "Bài viết đã được đăng thành công!");
  if (postId) {
    process.stderr.write(`   Post ID: ${postId}\n`);
  }
}

function logScheduled(scheduleTime) {
  log("schedule", "Bài viết đã được hẹn giờ đăng!");
  if (scheduleTime) {
    process.stderr.write(`   Thời gian: ${scheduleTime}\n`);
  }
}

function logEdited(postId) {
  log("edit", "Bài viết đã được cập nhật!");
  if (postId) {
    process.stderr.write(`   Post ID: ${postId}\n`);
  }
}

function logIntent(intent) {
  log("info", `Ý định nhận diện: ${intent.intent}`);
  if (intent.media_type_requested && intent.media_type_requested !== "image") {
    process.stderr.write(`   Loại media: ${intent.media_type_requested}\n`);
  }
  if (intent.target_agent) {
    process.stderr.write(`   Nhân viên phụ trách: ${intent.target_agent}\n`);
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
    content_draft: `Sếp vừa giao bài mới, anh em Content nhận brief và làm nhé: ${detail}`,
    content_revise: `Content cần sửa lại theo nhận xét: ${detail}`,
    media_generate: "Content đã được duyệt, anh em Media vào tạo ảnh nhé!",
    media_revise: `Ảnh cần sửa lại theo nhận xét: ${detail}`,
    publish: "Tất cả đã được duyệt, đăng bài lên Fanpage luôn!",
    schedule: "Tất cả đã được duyệt, hẹn giờ đăng bài theo lịch!",
    edit_post: "Sếp muốn sửa bài đã đăng, anh em Content cập nhật lại nhé!",
    learn_rule: "Rút kinh nghiệm từ lần sửa này, ghi lại quy tắc mới.",
  };

  return messages[action] || `${from} giao việc cho ${to}: ${detail || action}`;
}

module.exports = {
  buildHumanMessage,
  log,
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
