/**
 * video_agent.js - Logic rieng cho Media_Video.
 *
 * Chiu trach nhiem:
 * - Build prompt cho agent media_video
 * - Tong hop yeu cau gui nv_prompt de viet video prompt
 * - Parse ket qua tao video tu agent media_video
 */

const fs = require("fs");
const path = require("path");
const memory = require("./memory");
const mediaAgent = require("./media_agent");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function extractBlock(source, startMarker, endMarker) {
  const text = String(source || "");
  const startIndex = text.indexOf(startMarker);
  if (startIndex < 0) return "";
  const fromStart = text.slice(startIndex + startMarker.length);
  const endIndex = fromStart.indexOf(endMarker);
  return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
}

function extractField(source, label) {
  const match = String(source || "").match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
  return match?.[1]?.trim() || "";
}

function isPlaceholderGeneratedPath(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return ["KHONG_CO", "NONE", "NULL", "N/A", "KHONG_CO_DO_SKILL_TRA_VE_LOI"].includes(normalized);
}

function resolveVideoOutputDir(openClawHome) {
  return path.normalize(
    path.join(openClawHome || "C:/Users/Administrator/.openclaw", "workspace_media_video", "artifacts", "videos"),
  );
}

function buildVideoSystemPrompt(agentId, openClawHome) {
  const rulesSection = memory.buildRulesPromptSection(agentId, openClawHome);

  return [
    "Ban la media_video, nhan vien chuyen tao video quang cao san pham.",
    "",
    "NHIEM VU CHINH:",
    "- Nhan content da duyet, prompt video da duoc nv_prompt viet, anh goc san pham va logo cong ty",
    "- Truoc khi tao video, co the tong hop yeu cau prompt de gui sang nv_prompt",
    "- Goi skill generate_veo_video bang DUNG video prompt duoc giao",
    "- Bao cao lai video that vua tao, prompt da dung, anh san pham goc da dung, va logo da dung",
    "- Sua video khi co review tu sep, nhung khong duoc tu y viet prompt moi neu nv_prompt chua viet lai",
    "",
    "NGUYEN TAC BAT BUOC:",
    "- Video khong duoc long text vao khung hinh",
    "- San pham trong video phai trung thanh voi anh goc, khong duoc bien tau thanh san pham khac",
    "- Logo cong ty phai dung thuong hieu, tach nen sach, va xuat hien o goc duoi ben phai",
    "- Khong tao cac canh phi thuc te, vo ly, qua CGI hay qua vi tuong",
    "- Uu tien tinh chan that tuyet doi hon hieu ung",
    "- Khi goi generate_veo_video tren Windows/PowerShell, uu tien tao file JSON tam va goi action.js bang --input_file",
    "- JSON dau vao bat buoc co prompt, reference_image, logo_paths, output_dir",
    "- Neu tool loi, chi tom tat loi that gon nhat va dung lai",
    rulesSection,
  ].join("\n");
}

function buildVideoPromptRequestPrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    openClawHome,
    logoPaths = mediaAgent.resolveLogoAssetPaths(openClawHome),
  } = params;

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: video_prepare_prompt",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    state.media?.generatedImagePath ? `Anh quang cao da duyet: ${state.media.generatedImagePath}` : "",
    logoPaths.length > 0 ? `Logo cong ty bat buoc dung: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "NHIEM VU:",
    "- Ban chua tao video o buoc nay.",
    "- Hay tong hop 1 yeu cau ngan gon nhung cu the de gui sang nv_prompt viet VIDEO prompt.",
    "- Bat buoc neu ro: khong long text vao video, san pham trung thanh anh goc, logo tach nen dat goc duoi ben phai, canh quay chan that tuyet doi.",
    "- Neu da co anh quang cao da duyet, xem do la context tham khao bo cuc chuyen nghiep nhung khong duoc bien no thanh scene phi thuc te.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_REQUEST_BEGIN",
    "<ban tong hop yeu cau gui nv_prompt de viet VIDEO prompt>",
    "PROMPT_REQUEST_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean).join("\n");
}

function buildVideoPromptReviseRequestPrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    feedback,
    openClawHome,
    logoPaths = mediaAgent.resolveLogoAssetPaths(openClawHome),
  } = params;

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: video_prepare_prompt_revise",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    `Nhan xet moi tu sep: ${feedback}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    state.media?.generatedVideoPath ? `Video cu: ${state.media.generatedVideoPath}` : "",
    state.prompt_package?.videoPrompt ? `VIDEO_PROMPT_CU:\n${state.prompt_package.videoPrompt}` : "",
    logoPaths.length > 0 ? `Logo cong ty bat buoc dung: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "NHIEM VU:",
    "- Ban chua tao lai video o buoc nay.",
    "- Hay tong hop 1 yeu cau prompt moi de gui sang nv_prompt dua tren feedback cua sep.",
    "- Bat buoc giu cac rule cot loi: khong text trong video, san pham dung anh goc, logo tach nen o goc duoi ben phai, canh quay chan that tuyet doi.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_REQUEST_BEGIN",
    "<ban tong hop yeu cau sua VIDEO prompt gui nv_prompt>",
    "PROMPT_REQUEST_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean).join("\n");
}

function buildVideoGeneratePrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    openClawHome,
    promptPackage = {},
    logoPaths = mediaAgent.resolveLogoAssetPaths(openClawHome),
  } = params;
  const videoOutputDir = resolveVideoOutputDir(openClawHome);
  const videoActionPath = path.join(REPO_ROOT, "skills", "generate_veo_video", "action.js").replace(/\\/g, "/");

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: video_generate",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc gui cho skill: ${state.content.primaryProductImage}` : "",
    state.media?.generatedImagePath ? `Anh quang cao da duyet de tham khao: ${state.media.generatedImagePath}` : "",
    logoPaths.length > 0 ? `Logo cong ty bat buoc gui cho skill va prompt: ${logoPaths.join(" ; ")}` : "",
    `Thu muc output video bat buoc: ${videoOutputDir}`,
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "VIDEO_PROMPT_DUOC_GIAO:",
    promptPackage.videoPrompt || "",
    "",
    "NHIEM VU:",
    "- Goi skill generate_veo_video trong lane cua ban.",
    `- Tren Windows/PowerShell, tao 1 file JSON tam chua prompt + reference_image + logo_paths + output_dir roi goi: node ${videoActionPath} --input_file <duong_dan_file_json>.`,
    "- Dung DUNG VIDEO_PROMPT_DUOC_GIAO, khong tu y doi nghia.",
    `- reference_image BAT BUOC la: ${state.content?.primaryProductImage || ""}`,
    `- logo_paths BAT BUOC la: ${logoPaths.join(" ; ")}`,
    `- output_dir BAT BUOC la: ${videoOutputDir}`,
    "- Khong doc lai SKILL.md ra chat. Khong dump log terminal raw vao reply.",
    "- Neu tool loi, chi tom tat loi that gon nhat.",
    "",
    "MARKER BAT BUOC:",
    "VIDEO_PROMPT_BEGIN",
    "<prompt video da dung>",
    "VIDEO_PROMPT_END",
    "GENERATED_VIDEO_PATH: <duong dan video that vua tao>",
    "USED_PRODUCT_IMAGE: <duong dan anh san pham goc da truyen vao skill>",
    "USED_LOGO_PATHS: <danh sach logo da truyen, ngan cach boi ;>",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean).join("\n");
}

function buildVideoRevisePrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    feedback,
    openClawHome,
    promptPackage = state.prompt_package || {},
    logoPaths = mediaAgent.resolveLogoAssetPaths(openClawHome),
  } = params;
  const videoOutputDir = resolveVideoOutputDir(openClawHome);
  const videoActionPath = path.join(REPO_ROOT, "skills", "generate_veo_video", "action.js").replace(/\\/g, "/");

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: video_revise",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    `Nhan xet tu sep: ${feedback}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc gui cho skill: ${state.content.primaryProductImage}` : "",
    state.media?.generatedImagePath ? `Anh quang cao da duyet de tham khao: ${state.media.generatedImagePath}` : "",
    state.media?.generatedVideoPath ? `Video cu: ${state.media.generatedVideoPath}` : "",
    logoPaths.length > 0 ? `Logo cong ty bat buoc gui cho skill va prompt: ${logoPaths.join(" ; ")}` : "",
    `Thu muc output video bat buoc: ${videoOutputDir}`,
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "VIDEO_PROMPT_DUOC_GIAO:",
    promptPackage.videoPrompt || "",
    "",
    "NHIEM VU:",
    "- Hay tao lai video theo dung prompt package da duoc giao va feedback moi.",
    `- Tren Windows/PowerShell, tao 1 file JSON tam chua prompt + reference_image + logo_paths + output_dir roi goi: node ${videoActionPath} --input_file <duong_dan_file_json>.`,
    "- Khong duoc bo qua reference product image va logo_paths.",
    "",
    "MARKER BAT BUOC:",
    "VIDEO_PROMPT_BEGIN",
    "<prompt video da dung>",
    "VIDEO_PROMPT_END",
    "GENERATED_VIDEO_PATH: <duong dan video moi>",
    "USED_PRODUCT_IMAGE: <duong dan anh san pham goc>",
    "USED_LOGO_PATHS: <danh sach logo, ngan cach boi ;>",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean).join("\n");
}

function parseVideoPromptRequest(reply) {
  const text = String(reply || "").trim();
  const request = extractBlock(text, "PROMPT_REQUEST_BEGIN", "PROMPT_REQUEST_END");
  if (!request) {
    throw new Error("media_video reply bi thieu PROMPT_REQUEST block.");
  }
  return { request, reply: text };
}

function extractFirstExistingPath(source, extensions) {
  const backslashMatches = source.match(/[A-Za-z]:\\[^\r\n"]+/g) || [];
  const forwardSlashMatches = source.match(/[A-Za-z]:\/[^\r\n"]+/g) || [];
  const repoMatches = source.match(/artifacts\/[^\r\n"]+/g) || [];
  const candidates = [...backslashMatches, ...forwardSlashMatches, ...repoMatches]
    .map((item) => item.trim().replace(/[`"'.,]+$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (extensions.length > 0 && !extensions.includes(ext)) continue;
    const resolved = candidate.startsWith("artifacts/")
      ? path.join(REPO_ROOT, candidate.replace(/\//g, path.sep))
      : path.resolve(candidate);
    try {
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      return resolved;
    }
  }
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (extensions.length > 0 && !extensions.includes(ext)) continue;
    return path.resolve(candidate);
  }
  return "";
}

function parseVideoResult(reply) {
  const text = String(reply || "").trim();
  const videoPrompt = extractBlock(text, "VIDEO_PROMPT_BEGIN", "VIDEO_PROMPT_END");
  let generatedVideoPath = extractField(text, "GENERATED_VIDEO_PATH");
  if (isPlaceholderGeneratedPath(generatedVideoPath)) {
    generatedVideoPath = "";
  } else if (generatedVideoPath) {
    generatedVideoPath = path.resolve(generatedVideoPath);
  } else {
    generatedVideoPath = extractFirstExistingPath(text, [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".gif"]);
  }
  const usedProductImage = extractField(text, "USED_PRODUCT_IMAGE");
  const usedLogoPaths = extractField(text, "USED_LOGO_PATHS")
    .split(/\s*;\s*/g)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!generatedVideoPath) {
    throw new Error("media_video reply bi thieu duong dan video that.");
  }

  return {
    videoPrompt: videoPrompt || "(prompt video khong duoc ghi lai)",
    generatedVideoPath,
    mediaType: "video",
    usedProductImage,
    usedLogoPaths,
    reply: text,
  };
}

module.exports = {
  buildVideoGeneratePrompt,
  buildVideoPromptRequestPrompt,
  buildVideoPromptReviseRequestPrompt,
  buildVideoRevisePrompt,
  buildVideoSystemPrompt,
  parseVideoPromptRequest,
  parseVideoResult,
  resolveVideoOutputDir,
};
