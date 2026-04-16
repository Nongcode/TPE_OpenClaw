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

function resolveVideoOutputDir(openClawHome, workflowId = "") {
  const baseDir = path.join(
    openClawHome || "C:/Users/Administrator/.openclaw",
    "workspace_media_video",
    "artifacts",
    "videos",
  );
  const normalizedWorkflowId = String(workflowId || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return path.normalize(
    normalizedWorkflowId ? path.join(baseDir, normalizedWorkflowId) : baseDir,
  );
}

function assertVideoInputs(state, logoPaths = []) {
  const productImage = state?.content?.primaryProductImage;
  if (!productImage || !String(productImage).trim()) {
    throw new Error("Thieu primaryProductImage. Dung workflow video_generate/video_revise.");
  }

  const resolvedProductImage = path.resolve(String(productImage).trim());
  if (!fs.existsSync(resolvedProductImage)) {
    throw new Error(`primaryProductImage khong ton tai: ${productImage}`);
  }

  const normalizedLogos = (logoPaths || []).filter((item) => String(item || "").trim());
  for (const logoPath of normalizedLogos) {
    const resolvedLogoPath = path.resolve(String(logoPath).trim());
    if (!fs.existsSync(resolvedLogoPath)) {
      throw new Error(`Logo khong ton tai: ${logoPath}`);
    }
  }
}

function normalizePathForCompare(value) {
  return path.resolve(String(value || "").trim()).replace(/\\/g, "/").toLowerCase();
}

function buildVideoSystemPrompt(agentId, openClawHome) {
  const rulesSection = memory.buildRulesPromptSection(agentId, openClawHome);

  return [
    "Ban la media_video, nhan vien chuyen tao video quang cao san pham.",
    "",
    "NHIEM VU CHINH:",
    "- Truoc khi tao hoac sua video, bat buoc doc va ap dung tat ca quy tac da luu trong rules.json cua workspace_media_video.",
    "- Nhan content da duyet, prompt video da duoc nv_prompt viet, anh goc san pham va logo cong ty",
    "- Truoc khi tao video, co the tong hop yeu cau prompt de gui sang nv_prompt",
    "- Goi skill generate_veo_video bang DUNG video prompt duoc giao",
    "- Bao cao lai video that vua tao, prompt da dung, anh san pham goc da dung, va logo da dung",
    "- Sua video khi co review tu sep, nhung khong duoc tu y viet prompt moi neu nv_prompt chua viet lai",
    "",
    "NGUYEN TAC BAT BUOC:",
    "- BAO TOAN SAN PHAM TUYET DOI: Bat buoc dung anh goc san pham lam reference chinh. Hinh san pham trong video phai tuan thu tuyet doi thuc te anh goc. Khong duoc bien tau sang mau khac, hang khac, ket cau khac.",
    "- RANG BUOC CHUYEN DONG: Boi canh video va chuyen dong camera chi xoay quanh anh san pham tinh. Tuyet doi khong quay canh san pham dang hoat dong hay thay doi trang thai. Khong tao canh phi thuc te, qua da, hay lam dung CGI.",
    "- RANG BUOC CON NGUOI & VAN BAN: Tuyet doi khong co con nguoi xuat hien trong video. Tuyet doi khong long bat ky text/chữ nao vao khung hinh video.",
    "- RANG BUOC LOGO: Bat buoc dung file logo CONG TY that, tach nen sach, va gan co dinh o goc duoi ben phai video. Day la logo cong ty, khong phai logo thuong hieu cua san pham.",
    "- RANG BUOC QUY TRINH: Khong duoc tu y viet VIDEO prompt moi neu nv_prompt chua giao prompt moi. Moi reply workflow phai giu workflow_id va step_id.",
    "- RANG BUOC NGON NGU & DINH DANG: Bat buoc dung 100% tieng Viet co dau. Khong viet lai content. Khong publish. Khong tu nhan la tro ly ky thuat, C-3PO, hay debug agent.",
    "- Video khong duoc long text vao khung hinh",
    "- San pham trong video phai trung thanh voi anh goc, khong duoc bien tau thanh san pham khac",
    "- DOI TUONG CHINH BAT BUOC la TOAN BO SAN PHAM trong anh goc, khong phai motor, bom, bo nguon, xi lanh, khung phu kien hay bat ky bo phan tach roi nao.",
    "- Cam cac canh close-up khien vat the chinh bi hieu thanh mot linh kien rieng.",
    "- Moi canh quay phai giu ty le, ket cau va hinh dang tong the trung voi anh goc.",
    "- Neu khong the giu dung hinh dang tong the cua san pham, phai dung lai va bao loi thay vi tao sai san pham.",
    "- Logo cong ty phai dung thuong hieu, tach nen sach, va xuat hien o goc duoi ben phai",
    "- Video can ngan gon khoang 8 giay va co loi thuyet minh tieng Viet gioi thieu nhanh thong so chinh cua san pham",
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
  assertVideoInputs(state, logoPaths);
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(state.global_guidelines || []);

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    guidelineSection,
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
    logoPaths.length > 0 ? `Logo cong ty bat buoc dung: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "NHIEM VU:",
    "- Ban chua tao video o buoc nay.",
    "- Hay tong hop 1 yeu cau ngan gon nhung cu the de gui sang nv_prompt viet VIDEO prompt.",
    "- Bat buoc neu ro: khong long text vao video, san pham trung thanh anh goc, logo tach nen dat goc duoi ben phai, canh quay chan that tuyet doi.",
    "- DOI TUONG CHINH BAT BUOC la toan bo san pham trong anh goc. Cam close-up lam san pham bi hieu thanh linh kien rieng.",
    "- Bat buoc them yeu cau video ngan khoang 8 giay va co giong doc tieng Viet gioi thieu rat gon 2-4 thong so/chuc nang chinh cua san pham.",
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
  assertVideoInputs(state, logoPaths);
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(state.global_guidelines || []);

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    guidelineSection,
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
    "- DOI TUONG CHINH BAT BUOC la toan bo san pham trong anh goc. Cam close-up lam san pham bi hieu thanh linh kien rieng.",
    "- Neu sep yeu cau clip ngan, uu tien giu tong thoi luong khoang 8 giay va co giong doc tieng Viet gioi thieu rat gon thong so/chuc nang chinh.",
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
  assertVideoInputs(state, logoPaths);
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(state.global_guidelines || []);
  const videoOutputDir = resolveVideoOutputDir(openClawHome, workflowId);
  const videoActionPath = path.join(REPO_ROOT, "skills", "generate_veo_video", "action.js").replace(/\\/g, "/");

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    guidelineSection,
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
    "- Prompt video phai ep model giu dung san pham theo anh goc, khong duoc sinh mot san pham khac.",
    "- DOI TUONG CHINH BAT BUOC la TOAN BO SAN PHAM trong anh goc, khong phai motor, bom, bo nguon, xi lanh, khung phu kien hay bat ky bo phan tach roi nao.",
    "- Cam cac canh close-up khien vat the chinh bi hieu thanh mot linh kien rieng.",
    "- Moi canh quay phai giu ty le, ket cau va hinh dang tong the trung voi anh goc.",
    "- Neu khong the giu dung hinh dang tong the cua san pham, phai dung lai va bao loi thay vi tao sai san pham.",
    "- Prompt video phai neu ro clip ngan khoang 8 giay va co giong doc tieng Viet gioi thieu ngan gon thong so chinh cua san pham.",
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
    "REFERENCE_IMAGE_SHA256: <sha256 cua anh reference da dung>",
    "VIDEO_QC_STATUS: <PASS|FAIL>",
    "VIDEO_QC_REASON: <tom tat ket qua QC>",
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
  assertVideoInputs(state, logoPaths);
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(state.global_guidelines || []);
  const videoOutputDir = resolveVideoOutputDir(openClawHome, workflowId);
  const videoActionPath = path.join(REPO_ROOT, "skills", "generate_veo_video", "action.js").replace(/\\/g, "/");

  return [
    buildVideoSystemPrompt("media_video", openClawHome),
    guidelineSection,
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
    "- DOI TUONG CHINH BAT BUOC la TOAN BO SAN PHAM trong anh goc, khong phai motor, bom, bo nguon, xi lanh, khung phu kien hay bat ky bo phan tach roi nao.",
    "- Cam cac canh close-up khien vat the chinh bi hieu thanh mot linh kien rieng.",
    "- Moi canh quay phai giu ty le, ket cau va hinh dang tong the trung voi anh goc.",
    "- Neu khong the giu dung hinh dang tong the cua san pham, phai dung lai va bao loi thay vi tao sai san pham.",
    "- Tiep tuc uu tien clip ngan khoang 8 giay va giong doc tieng Viet neu prompt duoc giao co yeu cau nay.",
    "",
    "MARKER BAT BUOC:",
    "VIDEO_PROMPT_BEGIN",
    "<prompt video da dung>",
    "VIDEO_PROMPT_END",
    "GENERATED_VIDEO_PATH: <duong dan video moi>",
    "USED_PRODUCT_IMAGE: <duong dan anh san pham goc>",
    "USED_LOGO_PATHS: <danh sach logo, ngan cach boi ;>",
    "REFERENCE_IMAGE_SHA256: <sha256 cua anh reference da dung>",
    "VIDEO_QC_STATUS: <PASS|FAIL>",
    "VIDEO_QC_REASON: <tom tat ket qua QC>",
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
    .map((item) => mediaAgent.normalizeAgentReportedPath(item.trim().replace(/[`"'.,]+$/g, "")))
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

function parseVideoResult(reply, expected = {}) {
  const text = String(reply || "").trim();
  const videoPrompt = extractBlock(text, "VIDEO_PROMPT_BEGIN", "VIDEO_PROMPT_END");
  let generatedVideoPath = mediaAgent.normalizeAgentReportedPath(
    extractField(text, "GENERATED_VIDEO_PATH"),
  );
  if (isPlaceholderGeneratedPath(generatedVideoPath)) {
    generatedVideoPath = "";
  } else if (generatedVideoPath) {
    generatedVideoPath = path.resolve(generatedVideoPath);
  } else {
    generatedVideoPath = extractFirstExistingPath(text, [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".gif"]);
  }
  const usedProductImage = mediaAgent.normalizeAgentReportedPath(
    extractField(text, "USED_PRODUCT_IMAGE"),
  );
  const usedLogoPaths = extractField(text, "USED_LOGO_PATHS")
    .split(/\s*;\s*/g)
    .map((item) => mediaAgent.normalizeAgentReportedPath(item.trim()))
    .filter(Boolean);

  if (!generatedVideoPath) {
    throw new Error("media_video reply bi thieu duong dan video that.");
  }
  if (!usedProductImage) {
    throw new Error("media_video reply bi thieu USED_PRODUCT_IMAGE.");
  }

  if (expected.productImage) {
    const actual = normalizePathForCompare(usedProductImage);
    const expectedImage = normalizePathForCompare(expected.productImage);
    if (actual !== expectedImage) {
      throw new Error(`Sai reference image. expected=${expected.productImage} actual=${usedProductImage}`);
    }
  }

  if (expected.logoPaths?.length) {
    const actualSet = new Set(usedLogoPaths.map(normalizePathForCompare));
    for (const logoPath of expected.logoPaths) {
      if (!actualSet.has(normalizePathForCompare(logoPath))) {
        throw new Error(`Thieu logo bat buoc trong ket qua: ${logoPath}`);
      }
    }
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
