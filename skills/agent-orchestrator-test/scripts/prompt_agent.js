/**
 * prompt_agent.js - Logic rieng cho NV Prompt.
 *
 * Chiu trach nhiem:
 * - Tai kho kien thuc prompt tu workspace_prompt
 * - Build system prompt va task prompt cho nv_prompt
 * - Parse bo prompt image/video tra ve tu agent
 * - Track lich su prompt versions
 */

const fs = require("fs");
const path = require("path");
const memory = require("./memory");

const KNOWLEDGE_FILE_CANDIDATES = [
  "prompt-library.md",
  "prompt-templates.md",
  "knowledge.md",
];

function safeReadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function listKnowledgeFiles(workspaceDir) {
  const knowledgeDir = path.join(workspaceDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) {
    return [];
  }

  try {
    return fs.readdirSync(knowledgeDir)
      .filter((name) => /\.(md|txt|json)$/i.test(name))
      .map((name) => path.join(knowledgeDir, name))
      .sort();
  } catch {
    return [];
  }
}

function loadPromptKnowledgeSection(agentId, openClawHome, maxChars = 16000) {
  const workspaceDir = memory.resolveAgentWorkspace(agentId, openClawHome);
  if (!workspaceDir) {
    return "";
  }

  const candidateFiles = KNOWLEDGE_FILE_CANDIDATES
    .map((name) => path.join(workspaceDir, name))
    .filter((filePath) => fs.existsSync(filePath))
    .concat(listKnowledgeFiles(workspaceDir));

  if (candidateFiles.length === 0) {
    return "";
  }

  const sections = [];
  let usedChars = 0;

  for (const filePath of candidateFiles) {
    const raw = safeReadFile(filePath).trim();
    if (!raw) {
      continue;
    }

    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      break;
    }

    const trimmed = raw.length > remaining ? `${raw.slice(0, remaining)}\n...[rut gon]` : raw;
    sections.push(
      `KHO_KIEN_THUC_TU_FILE: ${path.basename(filePath)}\n${trimmed}`,
    );
    usedChars += trimmed.length;
  }

  if (sections.length === 0) {
    return "";
  }

  return [
    "",
    "KHO KIEN THUC PROMPT (BAT BUOC UU TIEN DOC VA AP DUNG):",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

function buildPromptSystemPrompt(agentId, openClawHome) {
  const rulesSection = memory.buildRulesPromptSection(agentId, openClawHome);
  const knowledgeSection = loadPromptKnowledgeSection(agentId, openClawHome);

  return [
    "Ban la nv_prompt, chuyen gia viet prompt tao anh va video quang cao san pham.",
    "",
    "NHIEM VU CHINH:",
    "- Nhan brief tu workflow media va viet prompt image, video, hoac ca hai tuy theo yeu cau.",
    "- Prompt phai giu nguyen cau truc san pham that trong anh goc, khong duoc bien dang hay che them chi tiet la.",
    "- Prompt phai su dung anh san pham goc va logo cong ty nhu reference bat buoc.",
    "- Neu tao anh quang cao, can mo ta cach dat logo tren mot bo phan phu hop cua san pham trong bo cuc cuoi.",
    "- Neu tao video, can mo ta ro product reference, camera motion, opening shot, va cach hien logo trong khung hinh.",
    "- Phan biet ro khi nao can IMAGE prompt, VIDEO prompt, hoac ca hai.",
    "",
    "NGUYEN TAC BAT BUOC:",
    "- Khong duoc viet prompt kieu chung chung, mo ho, hay chi noi 'anh dep, cao cap'.",
    "- Phai uu tien tinh xac thuc cua san pham that hon hieu ung trang tri.",
    "- Khong duoc sua doi ket cau, kich thuoc, vi tri bo phan, mau sac chinh cua san pham neu brief khong cho phep.",
    "- Neu prompt tao anh, phai nhan manh day la anh quang cao cuoi cung, khong phai chi la background.",
    "- Logo phai duoc dat mot cach tu nhien, sac net, khong chen de, khong sai thuong hieu.",
    "- Tra ve prompt bang tieng Viet.",
    knowledgeSection,
    rulesSection,
  ].join("\n");
}

function buildPromptDraftPrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    mediaType,
    openClawHome,
    logoPaths = [],
    mediaRequestBrief = "",
  } = params;
  const systemPrompt = buildPromptSystemPrompt("nv_prompt", openClawHome);

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: prompt_draft",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief || ""}`,
    `Loai media duoc yeu cau: ${mediaType}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    logoPaths.length > 0 ? `Logo bat buoc dung lam reference: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    ...(mediaRequestBrief
      ? [
          "",
          "YEU CAU CHOT TU NV_MEDIA:",
          mediaRequestBrief,
        ]
      : []),
    "",
    "NHIEM VU:",
    "- Hay viet prompt cu the cho media duoc yeu cau.",
    "- Prompt phai huong toi anh/video quang cao cuoi cung co san pham that va logo.",
    "- Can nhan manh: giu dung ket cau san pham goc, giu dung mau chinh, giu dung cac bo phan co khi quan trong.",
    "- Can nhan manh: dung anh san pham goc va logo reference, khong duoc tu ve lai mot san pham khac.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_DECISION: <image|video|both>",
    "IMAGE_PROMPT_BEGIN",
    "<prompt tao anh quang cao cuoi cung, neu co>",
    "IMAGE_PROMPT_END",
    "VIDEO_PROMPT_BEGIN",
    "<prompt tao video quang cao, neu co>",
    "VIDEO_PROMPT_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildPromptRevisePrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    mediaType,
    feedback,
    openClawHome,
    logoPaths = [],
    mediaRequestBrief = "",
  } = params;
  const systemPrompt = buildPromptSystemPrompt("nv_prompt", openClawHome);

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: prompt_revise",
    "",
    "NGU CANH:",
    `Loai media duoc yeu cau: ${mediaType}`,
    `Brief goc: ${state.original_brief || ""}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    logoPaths.length > 0 ? `Logo bat buoc dung lam reference: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    ...(mediaRequestBrief
      ? [
          "",
          "YEU CAU CHOT TU NV_MEDIA:",
          mediaRequestBrief,
        ]
      : []),
    "",
    "PROMPT CU:",
    state.prompt_package?.imagePrompt
      ? `IMAGE_PROMPT_CU:\n${state.prompt_package.imagePrompt}`
      : "",
    state.prompt_package?.videoPrompt
      ? `VIDEO_PROMPT_CU:\n${state.prompt_package.videoPrompt}`
      : "",
    "",
    "NHAN XET TU SEP (BAT BUOC LAM THEO):",
    feedback,
    "",
    "NHIEM VU:",
    "- Hay sua prompt theo dung nhan xet cua sep.",
    "- Neu nhan xet noi ve prompt, bo cuc, tinh chan that cua san pham, vi tri logo, anh sang, chat luong khung hinh, phai sua dung diem do.",
    "- Van phai giu san pham trung thanh voi anh goc.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_DECISION: <image|video|both>",
    "IMAGE_PROMPT_BEGIN",
    "<prompt anh moi, neu co>",
    "IMAGE_PROMPT_END",
    "VIDEO_PROMPT_BEGIN",
    "<prompt video moi, neu co>",
    "VIDEO_PROMPT_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean);

  return lines.join("\n");
}

function extractBlock(source, startMarker, endMarker) {
  const text = String(source || "");
  const startIndex = text.indexOf(startMarker);
  if (startIndex < 0) {
    return "";
  }
  const fromStart = text.slice(startIndex + startMarker.length);
  const endIndex = fromStart.indexOf(endMarker);
  return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
}

function extractField(source, label) {
  const match = String(source || "").match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
  return match?.[1]?.trim() || "";
}

function parsePromptResult(reply, requestedMediaType = "image") {
  const text = String(reply || "").trim();
  const promptDecision = extractField(text, "PROMPT_DECISION") || requestedMediaType || "image";
  const imagePrompt = extractBlock(text, "IMAGE_PROMPT_BEGIN", "IMAGE_PROMPT_END");
  const videoPrompt = extractBlock(text, "VIDEO_PROMPT_BEGIN", "VIDEO_PROMPT_END");

  if ((requestedMediaType === "image" || requestedMediaType === "both") && !imagePrompt) {
    throw new Error("nv_prompt reply bi thieu IMAGE_PROMPT block.");
  }
  if ((requestedMediaType === "video" || requestedMediaType === "both") && !videoPrompt) {
    throw new Error("nv_prompt reply bi thieu VIDEO_PROMPT block.");
  }

  return {
    promptDecision,
    imagePrompt,
    videoPrompt,
    reply: text,
  };
}

function trackPromptVersion(workflowDir, workflowId, promptData) {
  const versionsDir = path.join(workflowDir, "prompt-versions");
  fs.mkdirSync(versionsDir, { recursive: true });

  const existingFiles = fs.readdirSync(versionsDir)
    .filter((name) => name.startsWith(`${workflowId}_`) && name.endsWith(".json"))
    .sort();

  const versionNumber = existingFiles.length + 1;
  const filePath = path.join(versionsDir, `${workflowId}_v${versionNumber}.json`);
  const payload = {
    version: versionNumber,
    timestamp: new Date().toISOString(),
    ...promptData,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

module.exports = {
  buildPromptDraftPrompt,
  buildPromptRevisePrompt,
  buildPromptSystemPrompt,
  extractBlock,
  extractField,
  loadPromptKnowledgeSection,
  parsePromptResult,
  trackPromptVersion,
};
