/**
 * intent_parser.js — Phân tích Intent bằng LLM cho Phó Phòng.
 *
 * Gọi LLM model của pho_phong để phân tích câu lệnh của Trưởng phòng
 * thành cấu trúc JSON có intent, media_type, target_agent, v.v.
 * Fallback: nếu LLM parse lỗi, dùng keyword matching.
 */

const { normalizeText } = require("../../agent-orchestrator/scripts/common");
const transport = require("../../agent-orchestrator/scripts/transport");

/**
 * Danh sách intent hợp lệ.
 */
const VALID_INTENTS = [
  "CREATE_NEW",
  "EDIT_CONTENT",
  "EDIT_MEDIA",
  "EDIT_PUBLISHED",
  "SCHEDULE",
  "TRAIN",
];

const VALID_MEDIA_TYPES = ["image", "video", "both"];

function detectTrainingTargetAgent(normalizedMessage) {
  if (/\b(prompt|nhan vien prompt|viet prompt)\b/.test(normalizedMessage)) {
    return "nv_prompt";
  }
  if (/\b(media|anh|video|hinh)\b/.test(normalizedMessage)) {
    return "nv_media";
  }
  if (/\b(content|noi dung|viet bai)\b/.test(normalizedMessage)) {
    return "nv_content";
  }
  return "self";
}

/**
 * System prompt cho LLM intent parsing.
 */
function buildIntentSystemPrompt() {
  return [
    "Ban la bo phan tich y dinh (intent parser) cua Pho phong.",
    "Nhiem vu duy nhat: doc cau lenh cua Truong phong va tra ve JSON thuan tuy.",
    "",
    "Cac intent hop le:",
    '- CREATE_NEW: Tao bai Facebook moi (bao gom ca content + media)',
    '- EDIT_CONTENT: Sua lai noi dung bai (khi dang o buoc content hoac user muon sua content)',
    '- EDIT_MEDIA: Sua lai anh/video (khi dang o buoc media hoac user muon sua media)',
    '- EDIT_PUBLISHED: Sua bai da dang tren Facebook (can post_id)',
    '- SCHEDULE: Hen gio dang bai (khi da duyet xong content + media)',
    '- TRAIN: Sep muon day nhan vien 1 quy tac moi (ghi vao bo nho)',
    "",
    "Cac media_type_requested hop le:",
    '- image: Chi tao anh (mac dinh)',
    '- video: Chi tao video',
    '- both: Tao ca anh va video',
    "",
    "FORMAT TRA VE BAT BUOC (chi tra JSON, khong giai thich):",
    "{",
    '  "intent": "CREATE_NEW",',
    '  "media_type_requested": "image",',
    '  "target_agent": "nv_content",',
    '  "feedback_or_brief": "noi dung chi tiet...",',
    '  "post_id": null,',
    '  "schedule_time": null',
    "}",
    "",
    "QUY TAC:",
    '- Neu khong ro intent, mac dinh la "CREATE_NEW".',
    '- Neu khong de cap video, mac dinh media_type_requested la "image".',
    '- Neu sep noi "sua bai da dang" hoac de cap post ID, dung EDIT_PUBLISHED.',
    '- Neu sep noi "dat lich", "hen gio", "schedule", dung SCHEDULE.',
    '- Neu sep noi "nho", "quy tac", "luu y", "tu gio tro di", dung TRAIN.',
    '- target_agent: "nv_content" khi lien quan content, "nv_prompt" khi day prompt/rules prompt, "nv_media" khi lien quan media, "all" khi tao moi, "self" khi pho_phong tu xu ly.',
    "- Chi tra JSON thuan tuy. Khong markdown. Khong giai thich.",
  ].join("\n");
}

/**
 * Gọi LLM để parse intent.
 */
async function parseIntentViaLLM(params) {
  const { message, openClawHome, registry, timeoutMs } = params;
  const sessionKey = registry.byId.pho_phong?.transport?.sessionKey || "agent:pho_phong:main";

  const prompt = [
    buildIntentSystemPrompt(),
    "",
    "CAU LENH CUA TRUONG PHONG:",
    message,
  ].join("\n");

  const task = transport.sendTaskToAgentLane({
    agentId: "pho_phong",
    openClawHome,
    sessionKey,
    prompt,
    workflowId: "intent_parse",
    stepId: "parse_intent",
    timeoutMs: Math.min(timeoutMs || 30000, 30000),
  });

  const response = await transport.waitForAgentResponse(task);
  return extractJsonFromText(response.text);
}

/**
 * Trích xuất JSON từ text response của LLM.
 */
function extractJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  // Thử parse trực tiếp
  try {
    return JSON.parse(raw);
  } catch {
    // ignore
  }

  // Tìm block JSON trong response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // ignore
    }
  }

  // Tìm trong code fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Keyword-based intent fallback khi LLM parse lỗi.
 */
function parseIntentByKeywords(message) {
  const normalized = normalizeText(message);

  // TRAIN
  if (
    /\b(nho|quy tac|luu y|tu gio tro di|ghi nho|hoc di)\b/.test(normalized)
  ) {
    return {
      intent: "TRAIN",
      media_type_requested: "image",
      target_agent: detectTrainingTargetAgent(normalized),
      feedback_or_brief: message,
      post_id: null,
      schedule_time: null,
    };
  }

  // EDIT_PUBLISHED
  if (
    /\b(sua bai da dang|edit post|cap nhat bai cu|sua bai hom qua|chinh bai tren page)\b/.test(normalized)
  ) {
    const postIdMatch = message.match(/(\d{10,}[_:]\d+|\d{15,})/);
    return {
      intent: "EDIT_PUBLISHED",
      media_type_requested: "image",
      target_agent: "nv_content",
      feedback_or_brief: message,
      post_id: postIdMatch ? postIdMatch[1] : null,
      schedule_time: null,
    };
  }

  // SCHEDULE
  if (
    /\b(dat lich|hen gio|schedule|dang luc|dang vao luc|hen dang)\b/.test(normalized)
  ) {
    // Trích thời gian nếu có
    const timeMatch = message.match(
      /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2})?|\d{1,2}[hg:]\d{2})/i,
    );
    return {
      intent: "SCHEDULE",
      media_type_requested: "image",
      target_agent: "self",
      feedback_or_brief: message,
      post_id: null,
      schedule_time: timeMatch ? timeMatch[1] : null,
    };
  }

  // EDIT_MEDIA
  if (
    /\b(sua anh|lam lai anh|anh chua dat|media chua dat|chinh anh|doi anh|sua hinh|sua prompt|viet lai prompt|prompt chua on|prompt chua dat|chinh prompt)\b/.test(normalized)
  ) {
    const targetAgent = /\b(prompt|viet lai prompt|sua prompt|chinh prompt)\b/.test(normalized)
      ? "nv_prompt"
      : "nv_media";
    return {
      intent: "EDIT_MEDIA",
      media_type_requested: "image",
      target_agent: targetAgent,
      feedback_or_brief: message,
      post_id: null,
      schedule_time: null,
    };
  }

  // EDIT_CONTENT
  if (
    /\b(sua content|sua bai|viet lai|content chua dat|bai chua dat|chinh content|sua noi dung)\b/.test(normalized)
  ) {
    return {
      intent: "EDIT_CONTENT",
      media_type_requested: "image",
      target_agent: "nv_content",
      feedback_or_brief: message,
      post_id: null,
      schedule_time: null,
    };
  }

  // Detect media type
  let mediaType = "image";
  if (/\b(video|clip|phim|quay)\b/.test(normalized)) {
    mediaType = "video";
  }
  if (/\b(ca anh va video|anh va video|video va anh)\b/.test(normalized)) {
    mediaType = "both";
  }

  // CREATE_NEW (default)
  return {
    intent: "CREATE_NEW",
    media_type_requested: mediaType,
    target_agent: "all",
    feedback_or_brief: message,
    post_id: null,
    schedule_time: null,
  };
}

/**
 * Validate và normalize intent object.
 */
function validateIntent(parsed, originalMessage) {
  const intent = {
    intent: VALID_INTENTS.includes(parsed?.intent) ? parsed.intent : "CREATE_NEW",
    media_type_requested: VALID_MEDIA_TYPES.includes(parsed?.media_type_requested)
      ? parsed.media_type_requested
      : "image",
    target_agent: parsed?.target_agent || "all",
    feedback_or_brief: parsed?.feedback_or_brief || originalMessage || "",
    post_id: parsed?.post_id || null,
    schedule_time: parsed?.schedule_time || null,
  };
  return intent;
}

/**
 * Entry point: Parse intent — thử LLM trước, fallback keyword.
 */
async function parseIntent(params) {
  const { message, openClawHome, registry, timeoutMs, useLLM } = params;

  // Nếu cấu hình cho phép và có registry
  if (useLLM !== false && registry?.byId?.pho_phong) {
    try {
      const llmResult = await parseIntentViaLLM({
        message,
        openClawHome,
        registry,
        timeoutMs,
      });
      if (llmResult && llmResult.intent) {
        return validateIntent(llmResult, message);
      }
    } catch {
      // LLM failed, fallback to keywords
    }
  }

  // Fallback: keyword matching
  return parseIntentByKeywords(message);
}

/**
 * Kiểm tra xem message có phải là lệnh duyệt/từ chối cho workflow pending.
 * Dùng khi đang có workflow pending để quyết định nhanh mà không cần LLM.
 */
function classifyPendingDecision(message, currentStage) {
  const normalized = normalizeText(message);

  if (currentStage === "awaiting_content_approval") {
    const approveSignals = [
      "duyet content", "duyet bai", "ok content", "ok bai",
      "dong y content", "cho lam anh", "tao anh", "lam anh",
      "duyet noi dung", "content ok", "bai ok",
    ];
    const rejectSignals = [
      "sua content", "viet lai", "chua duyet content", "bai chua dat",
      "chua duyet bai", "sua bai", "sua noi dung", "chinh content",
    ];

    if (rejectSignals.some((s) => normalized.includes(s))) return "reject";
    if (approveSignals.some((s) => normalized.includes(s))) return "approve";
    return "unknown";
  }

  if (currentStage === "awaiting_media_approval") {
    const approveSignals = [
      "duyet media", "duyet anh", "ok anh", "ok media",
      "dang bai", "publish", "dang len page", "dang facebook",
      "duyet hinh", "anh ok", "media ok",
    ];
    const rejectSignals = [
      "sua anh", "lam lai anh", "chua duyet media", "anh chua dat",
      "media chua dat", "chua duyet anh", "chinh anh", "doi anh",
      "sua prompt", "viet lai prompt", "prompt chua on", "prompt chua dat", "chinh prompt",
    ];

    if (rejectSignals.some((s) => normalized.includes(s))) return "reject";
    if (approveSignals.some((s) => normalized.includes(s))) return "approve";
    return "unknown";
  }

  if (currentStage === "awaiting_publish_decision") {
    if (/\b(dang ngay|publish ngay|dang luon)\b/.test(normalized)) return "publish_now";
    if (/\b(hen gio|dat lich|schedule|dang luc)\b/.test(normalized)) return "schedule";
    return "unknown";
  }

  return "unknown";
}

module.exports = {
  buildIntentSystemPrompt,
  classifyPendingDecision,
  extractJsonFromText,
  parseIntent,
  parseIntentByKeywords,
  validateIntent,
  VALID_INTENTS,
  VALID_MEDIA_TYPES,
};
