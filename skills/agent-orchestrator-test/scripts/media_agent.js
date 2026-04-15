/**
 * media_agent.js - Logic rieng cho NV Media.
 *
 * Chiu trach nhiem:
 * - Build prompt thuc thi media dua tren prompt da duoc NV Prompt viet
 * - Resolve product/logo references cho skill image/video
 * - Parse ket qua media tu LLM reply
 * - Giu lai helper composite 3 lop cu cho backward-compatibility
 */

const fs = require("fs");
const path = require("path");
const memory = require("./memory");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_LOGO_DIR = "C:/Users/Administrator/.openclaw/assets/logos";
const DEFAULT_LOGO_PATH = `${DEFAULT_LOGO_DIR}/logo.png`;

function extractBlock(source, startMarker, endMarker) {
  const text = String(source || "");
  const startIndex = text.indexOf(startMarker);
  if (startIndex < 0) return "";
  const fromStart = text.slice(startIndex + startMarker.length);
  const endIndex = fromStart.indexOf(endMarker);
  return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
}

function isPlaceholderGeneratedPath(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return [
    "KHONG_CO_DO_SKILL_TRA_VE_LOI",
    "KHONG_CO",
    "NONE",
    "NULL",
    "N/A",
  ].includes(normalized);
}

function isTransientGeneratedImagePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  return /(?:^|\/)gemini-image-screenshot-[^/]+\.(png|jpg|jpeg|webp)$/.test(normalized);
}

function normalizeAgentReportedPath(value) {
  const trimmed = String(value || "")
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "");
  if (!trimmed) return "";

  return trimmed
    .replace(/([A-Za-z]:\\Users\\Administrator)\.openclaw(?=\\|$)/gi, "$1\\.openclaw")
    .replace(/([A-Za-z]:\/Users\/Administrator)\.openclaw(?=\/|$)/gi, "$1/.openclaw");
}

function normalizeAgentReportedPaths(values) {
  return (values || [])
    .map((item) => normalizeAgentReportedPath(item))
    .filter(Boolean);
}

/**
 * Lazy-load sharp — trả null nếu chưa cài.
 */
function tryLoadSharp() {
  try {
    return require("sharp");
  } catch {
    return null;
  }
}

/**
 * Resolve danh sach logo references tu .openclaw/assets/logos.
 */
function resolveLogoAssetPaths(openClawHome, limit = 8) {
  const baseDir = path.join(openClawHome || "C:/Users/Administrator/.openclaw", "assets", "logos");
  if (!fs.existsSync(baseDir)) {
    return fs.existsSync(DEFAULT_LOGO_PATH) ? [path.normalize(DEFAULT_LOGO_PATH)] : [];
  }

  try {
    return fs.readdirSync(baseDir)
      .filter((name) => /\.(png|jpe?g|webp|svg)$/i.test(name))
      .sort()
      .slice(0, limit)
      .map((name) => path.join(baseDir, name));
  } catch {
    return fs.existsSync(DEFAULT_LOGO_PATH) ? [path.normalize(DEFAULT_LOGO_PATH)] : [];
  }
}

function resolveMediaOutputDir(openClawHome) {
  const baseDir = path.join(openClawHome || "C:/Users/Administrator/.openclaw", "workspace_media", "artifacts", "images");
  return path.normalize(baseDir);
}

/**
 * Build system prompt cho nv_media.
 */
function buildMediaSystemPrompt(agentId, openClawHome) {
  const rulesSection = memory.buildRulesPromptSection(agentId, openClawHome);

  return [
    "Ban la nv_media, chuyen vien THUC THI media cho bai Facebook.",
    "",
    "NHIEM VU CHINH:",
    "- Nhan content da duyet, prompt da duoc nv_prompt viet, va du lieu san pham that",
    "- Goi skill tao anh/video bang DUNG prompt da duoc giao",
    "- Khi tao anh, bat buoc dua ca anh san pham goc va logo cong ty vao image_paths",
    "- Khi tao video, uu tien dua anh san pham goc lam reference image",
    "- Truoc khi thuc thi media, co the tong hop yeu cau prompt de gui cho nv_prompt",
    "- Bao cao lai day duong dan file media that, prompt da dung, va cac reference da truyen",
    "- Sua media khi co review tu sep, nhung khong duoc tu y viet prompt moi neu chua nhan prompt moi tu nv_prompt",
    "",
    "NGUYEN TAC BAT BUOC:",
    "- Khong duoc bien prompt giao xuong thanh mot prompt khac nghia",
    "- Khong duoc loai bo anh san pham goc khoi dau vao tao anh",
    "- Khong duoc loai bo logo cong ty khoi dau vao tao anh",
    "- Uu tien tinh xac thuc cua san pham that, logo that, va bo cuc quang cao cuoi cung",
    "- Khong publish",
    "- Khong gia lap duong dan file",
    "- Neu skill tao anh/video tra ve loi, phai noi ro loi that tu tool",
    "- Khi goi gemini_generate_image tren Windows/PowerShell, uu tien tao file JSON tam va goi action.js bang tham so --input_file.",
    "- Khong duoc thu nhieu cach goi lung tung neu da co cach goi --input_file hoat dong.",
    "- Khong doc lai noi dung SKILL.md ra chat, khong ke lai command thu nghiem, khong dump log terminal dai dong vao cau tra loi workflow.",
    "- Khong duoc tu sua file code/skill trong luc dang thuc thi media thong thuong. Neu phat hien loi he thong, dung lai va bao dung loi that thay vi tu hot-fix trong lane.",
    "- Uu tien tra ket qua workflow gon: thanh cong thi chi bao ket qua; that bai thi chi bao loi cot loi va de xuat buoc tiep theo.",
    rulesSection,
  ].join("\n");
}

function buildMediaPromptRequestPrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    mediaType,
    openClawHome,
    logoPaths = resolveLogoAssetPaths(openClawHome),
  } = params;
  const systemPrompt = buildMediaSystemPrompt("nv_media", openClawHome);

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: media_prepare_prompt",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    `Loai media can tao: ${mediaType}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    logoPaths.length > 0 ? `Logo cong ty se gui cho skill tao media: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    "NHIEM VU:",
    "- Ban chua tao media o buoc nay.",
    "- Hay doc brief va noi dung da duyet, sau do tong hop 1 yeu cau ngan gon nhung cu the de gui sang NV Prompt.",
    "- Yeu cau phai neu ro loai media can tao, muc tieu bo cuc, do trung thanh san pham that, cach dung anh san pham goc, va cach dua logo vao media cuoi cung.",
    "- Neu workflow chi yeu cau image thi ghi ro chi can IMAGE prompt. Neu video thi ghi ro VIDEO. Neu ca hai thi ghi ro ca hai.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_REQUEST_BEGIN",
    "<ban tong hop yeu cau gui nv_prompt>",
    "PROMPT_REQUEST_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildMediaPromptReviseRequestPrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    mediaType,
    feedback,
    openClawHome,
    logoPaths = resolveLogoAssetPaths(openClawHome),
  } = params;
  const systemPrompt = buildMediaSystemPrompt("nv_media", openClawHome);

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: media_prepare_prompt_revise",
    "",
    "NGU CANH:",
    `Brief goc: ${state.original_brief}`,
    `Loai media can tao: ${mediaType}`,
    `Nhan xet moi tu sep: ${feedback}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.primaryProductImage ? `Anh san pham goc bat buoc giu dung: ${state.content.primaryProductImage}` : "",
    logoPaths.length > 0 ? `Logo cong ty se gui cho skill tao media: ${logoPaths.join(" ; ")}` : "",
    "",
    "NOI DUNG DA DUYET:",
    state.content?.approvedContent || "",
    "",
    state.prompt_package?.imagePrompt ? `PROMPT ANH CU:\n${state.prompt_package.imagePrompt}` : "",
    state.prompt_package?.videoPrompt ? `PROMPT VIDEO CU:\n${state.prompt_package.videoPrompt}` : "",
    state.media?.generatedImagePath ? `ANH CU: ${state.media.generatedImagePath}` : "",
    state.media?.generatedVideoPath ? `VIDEO CU: ${state.media.generatedVideoPath}` : "",
    "",
    "NHIEM VU:",
    "- Ban chua tao lai media o buoc nay.",
    "- Hay tong hop 1 yeu cau prompt moi de gui sang NV Prompt dua tren feedback cua sep.",
    "- Neu feedback noi ve prompt, bo cuc, logo, tinh trung thanh san pham, chat lieu, goc chup, do sac net thi phai nhan manh lai dung diem do.",
    "- Ghi ro phan nao cua media can giu nguyen, phan nao can sua.",
    "",
    "MARKER BAT BUOC:",
    "PROMPT_REQUEST_BEGIN",
    "<ban tong hop yeu cau sua prompt gui nv_prompt>",
    "PROMPT_REQUEST_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ].filter(Boolean);

  return lines.join("\n");
}

/**
 * Build prompt thuc thi media (anh, video, hoac ca hai) dua tren prompt package.
 */
function buildMediaGeneratePrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    mediaType,
    openClawHome,
    promptPackage = {},
    logoPaths = resolveLogoAssetPaths(openClawHome),
  } = params;
  const agentId = "nv_media";
  const systemPrompt = buildMediaSystemPrompt(agentId, openClawHome);
  const imageActionPath = path.join(REPO_ROOT, "skills", "gemini_generate_image", "action.js").replace(/\\/g, "/");

  const productImagePath = state.content?.primaryProductImage || "";
  const mediaOutputDir = resolveMediaOutputDir(openClawHome);
  const promptContext = [
    promptPackage.imagePrompt ? `IMAGE_PROMPT_DUOC_GIAO:\n${promptPackage.imagePrompt}` : "",
    promptPackage.videoPrompt ? `VIDEO_PROMPT_DUOC_GIAO:\n${promptPackage.videoPrompt}` : "",
  ].filter(Boolean).join("\n\n");

  const context = [
    `Brief goc: ${state.original_brief}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.imageDir ? `Thu muc anh goc: ${state.content.imageDir}` : "",
    productImagePath ? `Anh san pham goc bat buoc gui cho skill: ${productImagePath}` : "",
    logoPaths.length > 0 ? `Logo cong ty bat buoc gui cho skill anh: ${logoPaths.join(" ; ")}` : "",
    `Thu muc output media bat buoc: ${mediaOutputDir}`,
    "",
    "Noi dung da duyet:",
    state.content?.approvedContent || "",
    "",
    promptContext,
  ].filter(Boolean).join("\n");

  const imageInstruction = [
    "NEU CAN TAO ANH:",
    "- Goi skill gemini_generate_image trong lane cua ban.",
    `- Tren Windows/PowerShell, tao 1 file JSON tam chua image_prompt + image_paths + output_dir roi goi: node ${imageActionPath} --input_file <duong_dan_file_json>.`,
    "- Dung DUNG IMAGE_PROMPT_DUOC_GIAO, khong tu y doi nghia.",
    "- image_paths BAT BUOC gom: [anh san pham goc, ...tat ca logo cong ty].",
    `- output_dir BAT BUOC la: ${mediaOutputDir}. Khong duoc de tool tu suy ra theo cwd.`,
    "- Muc tieu la tao ra anh quang cao cuoi cung tu reference that, khong phai background-only.",
    "- Khong doc lai SKILL.md ra chat. Khong thu lenh sai truoc roi moi sua. Khong tua thich sua file skill trong luc dang lam media.",
    "- Neu tool loi, chi tom tat loi that gon nhat; khong chen transcript command, process poll, hay log terminal raw vao reply.",
    "- Sau khi tao xong, ghi dung cac marker sau:",
    "IMAGE_PROMPT_BEGIN",
    "<prompt anh da dung>",
    "IMAGE_PROMPT_END",
    "GENERATED_IMAGE_PATH: <duong dan anh quang cao that vua tao>",
    "USED_PRODUCT_IMAGE: <duong dan anh san pham goc da truyen vao skill>",
    "USED_LOGO_PATHS: <danh sach logo da truyen, ngan cach boi ;>",
  ].join("\n");

  const videoInstruction = [
    "NEU CAN TAO VIDEO:",
    "- Goi skill generate_veo_video trong lane cua ban.",
    "- Dung DUNG VIDEO_PROMPT_DUOC_GIAO, khong tu y doi nghia.",
    "- reference_image hoac image_path uu tien dung anh san pham goc.",
    "- Neu can dua thong tin logo vao video, giu nguyen yeu cau logo trong prompt duoc giao.",
    "- Sau khi tao xong, ghi dung cac marker sau:",
    "VIDEO_PROMPT_BEGIN",
    "<prompt video da dung>",
    "VIDEO_PROMPT_END",
    "GENERATED_VIDEO_PATH: <duong dan video that vua tao>",
    "USED_PRODUCT_IMAGE: <duong dan anh san pham goc da truyen vao skill>",
    "USED_LOGO_PATHS: <danh sach logo lien quan den prompt/video, ngan cach boi ;>",
  ].join("\n");

  const mediaInstruction =
    mediaType === "both"
      ? [
          "LOAI MEDIA: BOTH",
          imageInstruction,
          "",
          videoInstruction,
        ].join("\n\n")
      : mediaType === "video"
        ? [
            "LOAI MEDIA: VIDEO",
            videoInstruction,
          ].join("\n\n")
        : [
            "LOAI MEDIA: IMAGE",
            imageInstruction,
          ].join("\n\n");

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: media_generate",
    "",
    "NGU CANH:",
    context,
    "",
    "NHIEM VU:",
    mediaInstruction,
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ];

  return lines.join("\n");
}

/**
 * Build prompt sua media (khi bi reject).
 */
function buildMediaRevisePrompt(params) {
  const {
    workflowId,
    stepId,
    state,
    feedback,
    mediaType,
    openClawHome,
    promptPackage = state.prompt_package || {},
    logoPaths = resolveLogoAssetPaths(openClawHome),
  } = params;
  const agentId = "nv_media";
  const systemPrompt = buildMediaSystemPrompt(agentId, openClawHome);

  const productImageInfo = state.content?.primaryProductImage
    ? `Anh san pham goc bat buoc gui cho skill: ${state.content.primaryProductImage}`
    : "";
  const mediaOutputDir = resolveMediaOutputDir(openClawHome);

  const context = [
    `Brief goc: ${state.original_brief}`,
    `Nhan xet tu sep: ${feedback}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.imageDir ? `Thu muc anh goc: ${state.content.imageDir}` : "",
    productImageInfo,
    logoPaths.length > 0 ? `Logo cong ty bat buoc gui cho skill anh: ${logoPaths.join(" ; ")}` : "",
    `Thu muc output media bat buoc: ${mediaOutputDir}`,
    "",
    "Noi dung da duyet:",
    state.content?.approvedContent || "",
    "",
    promptPackage.imagePrompt ? `Prompt anh duoc giao:\n${promptPackage.imagePrompt}` : "",
    state.media?.generatedImagePath ? `Anh cu: ${state.media.generatedImagePath}` : "",
    promptPackage.videoPrompt ? `Prompt video duoc giao:\n${promptPackage.videoPrompt}` : "",
    state.media?.generatedVideoPath ? `Video cu: ${state.media.generatedVideoPath}` : "",
  ].filter(Boolean).join("\n");

  const isVideo = mediaType === "video";
  const isBoth = mediaType === "both";
  const markerInstructions = isBoth
    ? [
        "Tra ve lai dung cac marker sau sau khi da tao lai media:",
        "IMAGE_PROMPT_BEGIN",
        "<prompt anh da dung>",
        "IMAGE_PROMPT_END",
        "GENERATED_IMAGE_PATH: <duong dan anh moi>",
        "VIDEO_PROMPT_BEGIN",
        "<prompt video da dung>",
        "VIDEO_PROMPT_END",
        "GENERATED_VIDEO_PATH: <duong dan video moi>",
        "USED_PRODUCT_IMAGE: <duong dan anh san pham goc>",
        "USED_LOGO_PATHS: <danh sach logo, ngan cach boi ;>",
      ].join("\n")
    : isVideo
    ? [
        "Tra ve lai dung cac marker:",
        "VIDEO_PROMPT_BEGIN",
        "<prompt video da dung>",
        "VIDEO_PROMPT_END",
        "GENERATED_VIDEO_PATH: <duong dan video moi>",
        "USED_PRODUCT_IMAGE: <duong dan anh san pham goc>",
        "USED_LOGO_PATHS: <danh sach logo, ngan cach boi ;>",
      ].join("\n")
    : [
        "Tra ve lai dung cac marker:",
        "IMAGE_PROMPT_BEGIN",
        "<prompt anh da dung>",
        "IMAGE_PROMPT_END",
        "GENERATED_IMAGE_PATH: <duong dan anh moi>",
        "USED_PRODUCT_IMAGE: <duong dan anh san pham goc>",
        "USED_LOGO_PATHS: <danh sach logo, ngan cach boi ;>",
      ].join("\n");

  const lines = [
    systemPrompt,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: media_revise",
    "",
    "NGU CANH:",
    context,
    "",
    "NHIEM VU:",
    `User yeu cau sua lai ${isBoth ? "anh va video" : isVideo ? "video" : "anh"}.`,
    "Hay thuc thi lai media theo dung prompt package da duoc giao va sua theo nhan xet cua sep.",
    "Khong duoc bo qua reference product image. Khi tao anh, khong duoc bo qua logo paths.",
    `Khi tao anh, output_dir BAT BUOC la: ${mediaOutputDir}.`,
    "",
    markerInstructions,
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  ];

  return lines.join("\n");
}

function parseMediaPromptRequest(reply) {
  const text = String(reply || "").trim();
  const request = extractBlock(text, "PROMPT_REQUEST_BEGIN", "PROMPT_REQUEST_END");
  if (!request) {
    throw new Error("nv_media reply bi thieu PROMPT_REQUEST block.");
  }
  return {
    request,
    reply: text,
  };
}

/**
 * Parse reply tu nv_media cho anh.
 */
function parseImageResult(reply) {
  const text = String(reply || "").trim();

  const extractBlock = (source, startMarker, endMarker) => {
    const startIndex = source.indexOf(startMarker);
    if (startIndex < 0) return "";
    const fromStart = source.slice(startIndex + startMarker.length);
    const endIndex = fromStart.indexOf(endMarker);
    return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
  };

  const extractField = (source, label) => {
    const match = source.match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
    return match?.[1]?.trim() || "";
  };

  const extractFirstExistingPath = (source, extensions) => {
    // Match cả backslash (C:\...) lẫn forward slash (C:/...) — agent hay trả cả 2 dạng
    const backslashMatches = source.match(/[A-Za-z]:\\[^\r\n"]+/g) || [];
    const forwardSlashMatches = source.match(/[A-Za-z]:\/[^\r\n"]+/g) || [];
    const repoMatches = source.match(/artifacts\/[^\r\n"]+/g) || [];
    const candidates = [...backslashMatches, ...forwardSlashMatches, ...repoMatches]
      .map((item) => normalizeAgentReportedPath(item.trim().replace(/[`"'.,]+$/g, "")))
      .filter(Boolean);
    for (const candidate of candidates) {
      const ext = path.extname(candidate).toLowerCase();
      if (extensions.length > 0 && !extensions.includes(ext)) continue;
      const resolved = candidate.startsWith("artifacts/")
        ? path.join(REPO_ROOT, candidate.replace(/\//g, path.sep))
        : path.resolve(candidate);
      // Thử kiểm tra file, nhưng nếu không check được thì vẫn chấp nhận
      try {
        if (fs.existsSync(resolved)) return resolved;
      } catch {
        // permission error hoặc race condition — vẫn trả path
        return resolved;
      }
    }
    // Fallback: trả candidate đầu tiên có extension đúng dù chưa verify trên disk
    for (const candidate of candidates) {
      const ext = path.extname(candidate).toLowerCase();
      if (extensions.length > 0 && !extensions.includes(ext)) continue;
      return path.resolve(candidate);
    }
    return "";
  };

  const imagePrompt = extractBlock(text, "IMAGE_PROMPT_BEGIN", "IMAGE_PROMPT_END");
  const usedProductImage = normalizeAgentReportedPath(extractField(text, "USED_PRODUCT_IMAGE"));
  const usedLogoPaths = normalizeAgentReportedPaths(
    extractField(text, "USED_LOGO_PATHS")
    .split(/\s*;\s*/g)
    .map((item) => item.trim())
    .filter(Boolean),
  );

  // Ưu tiên extractField, nếu chưa có thì scan toàn bộ reply
  let generatedImagePath = extractField(text, "GENERATED_IMAGE_PATH");
  generatedImagePath = normalizeAgentReportedPath(generatedImagePath);
  // Normalize forward/backslash
  if (isPlaceholderGeneratedPath(generatedImagePath) || isTransientGeneratedImagePath(generatedImagePath)) {
    generatedImagePath = "";
  } else if (generatedImagePath) {
    generatedImagePath = path.resolve(generatedImagePath);
  } else {
    generatedImagePath = extractFirstExistingPath(text, [".png", ".jpg", ".jpeg", ".webp"]);
    if (isTransientGeneratedImagePath(generatedImagePath)) {
      generatedImagePath = "";
    }
  }

  if (!imagePrompt) {
    // Soft warning thay vì crash — có thể agent viết format khác nhưng vẫn có ảnh
    process.stderr.write("[media_agent] WARN: Reply thiếu IMAGE_PROMPT block.\n");
  }
  if (!generatedImagePath) {
    throw new Error("nv_media reply bi thieu duong dan anh that. Kiem tra lai output cua nv_media.");
  }

  return {
    imagePrompt: imagePrompt || "(prompt khong duoc ghi lai)",
    generatedImagePath,
    mediaType: "image",
    usedProductImage,
    usedLogoPaths,
    reply: text,
  };
}

/**
 * Parse reply từ nv_media cho video.
 */
function parseVideoResult(reply) {
  const text = String(reply || "").trim();

  const extractBlock = (source, startMarker, endMarker) => {
    const startIndex = source.indexOf(startMarker);
    if (startIndex < 0) return "";
    const fromStart = source.slice(startIndex + startMarker.length);
    const endIndex = fromStart.indexOf(endMarker);
    return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
  };

  const extractField = (source, label) => {
    const match = source.match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
    return match?.[1]?.trim() || "";
  };

  const videoPrompt = extractBlock(text, "VIDEO_PROMPT_BEGIN", "VIDEO_PROMPT_END");
  let generatedVideoPath = extractField(text, "GENERATED_VIDEO_PATH");
  generatedVideoPath = normalizeAgentReportedPath(generatedVideoPath);
  if (isPlaceholderGeneratedPath(generatedVideoPath)) {
    generatedVideoPath = "";
  }
  const usedProductImage = normalizeAgentReportedPath(extractField(text, "USED_PRODUCT_IMAGE"));
  const usedLogoPaths = normalizeAgentReportedPaths(
    extractField(text, "USED_LOGO_PATHS")
    .split(/\s*;\s*/g)
    .map((item) => item.trim())
    .filter(Boolean),
  );

  return {
    videoPrompt: videoPrompt || "",
    generatedVideoPath: generatedVideoPath || "",
    mediaType: "video",
    usedProductImage,
    usedLogoPaths,
    reply: text,
  };
}

/**
 * Parse media result dua tren media type.
 */
function parseMediaResult(reply, mediaType) {
  if (mediaType === "both") {
    const imageResult = parseImageResult(reply);
    const videoResult = parseVideoResult(reply);
    return {
      imagePrompt: imageResult.imagePrompt,
      generatedImagePath: imageResult.generatedImagePath,
      videoPrompt: videoResult.videoPrompt,
      generatedVideoPath: videoResult.generatedVideoPath,
      mediaType: "both",
      usedProductImage: imageResult.usedProductImage || videoResult.usedProductImage,
      usedLogoPaths: [...new Set([...(imageResult.usedLogoPaths || []), ...(videoResult.usedLogoPaths || [])])],
      reply: String(reply || "").trim(),
    };
  }
  if (mediaType === "video") {
    return parseVideoResult(reply);
  }
  return parseImageResult(reply);
}

/**
 * Route media type - khong fallback nua, tra dung loai duoc yeu cau.
 *
 * Tra ve object { effectiveType, fallbackMessage }
 */
function routeMediaType(requestedType) {
  if (requestedType === "image") {
    return { effectiveType: "image", fallbackMessage: null };
  }

  if (requestedType === "video") {
    return { effectiveType: "video", fallbackMessage: null };
  }

  if (requestedType === "both") {
    return { effectiveType: "both", fallbackMessage: null };
  }

  return { effectiveType: "image", fallbackMessage: null };
}

/**
 * Placeholder — hàm tạo video (chưa triển khai).
 * Khi skill generate_veo_video hoàn thiện, implement logic tại đây.
 */
async function generateVideo(_params) {
  // TODO: Tích hợp skill generate_veo_video khi hoàn thiện
  // Tham số dự kiến:
  // - params.prompt: video prompt tiếng Việt
  // - params.referenceImage: ảnh tham chiếu (nếu có)
  // - params.aspectRatio: "9:16" hoặc "16:9"
  throw new Error(
    "Tinh nang tao video đang trong qua trinh phat trien. Vui long su dung anh thay the.",
  );
}

/**
 * Lưu prompt version history để tracking khi bị reject.
 */
function trackPromptVersion(workflowDir, workflowId, promptData) {
  const versionsDir = path.join(workflowDir, "prompt-versions");
  fs.mkdirSync(versionsDir, { recursive: true });

  const existingFiles = fs.readdirSync(versionsDir)
    .filter((f) => f.startsWith(`${workflowId}_`) && f.endsWith(".json"))
    .sort();

  const versionNumber = existingFiles.length + 1;
  const filePath = path.join(versionsDir, `${workflowId}_v${versionNumber}.json`);

  const entry = {
    version: versionNumber,
    timestamp: new Date().toISOString(),
    ...promptData,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return entry;
}

/**
 * compositeImage3Layers — Ghép ảnh 3 lớp bằng sharp.
 *
 * Lớp 1: Background (ảnh nền do AI vẽ, KHÔNG có sản phẩm)
 * Lớp 2: Real Product Overlay (ảnh thật từ search_product_text)
 * Lớp 3: Logo Watermark (logo tĩnh mặc định)
 *
 * @param {object} params
 * @param {string} params.backgroundPath — Đường dẫn ảnh nền AI
 * @param {string} params.productImagePath — Đường dẫn ảnh sản phẩm thật
 * @param {string} [params.logoPath] — Đường dẫn logo (mặc định: DEFAULT_LOGO_PATH)
 * @param {string} [params.outputPath] — Đường dẫn file output
 * @param {object} [params.options] — Tùy chọn bổ sung
 * @param {number} [params.options.productHeightRatio=0.65] — Tỷ lệ chiều cao sản phẩm / nền (0.6-0.75)
 * @param {number} [params.options.logoWidthRatio=0.17] — Tỷ lệ chiều rộng logo / nền (0.15-0.20)
 * @param {string} [params.options.productPosition='center'] — Vị trí sản phẩm: 'center' | 'center-bottom'
 * @returns {Promise<string>} Đường dẫn file output đã ghép xong
 */
async function compositeImage3Layers(params) {
  const sharp = tryLoadSharp();
  if (!sharp) {
    throw new Error(
      "Thu vien 'sharp' chua duoc cai dat. Chay: npm install sharp",
    );
  }

  const {
    backgroundPath,
    productImagePath,
    logoPath = DEFAULT_LOGO_PATH,
    outputPath,
    options = {},
  } = params;

  const productHeightRatio = options.productHeightRatio || 0.65;
  const logoWidthRatio = options.logoWidthRatio || 0.17;
  const productPosition = options.productPosition || "center";

  // Validate input files
  if (!backgroundPath || !fs.existsSync(backgroundPath)) {
    throw new Error(`Anh nen khong ton tai: ${backgroundPath}`);
  }
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error(`Anh san pham khong ton tai: ${productImagePath}`);
  }

  // ─── LỚP 1: Load Background ──────────────────────────────────────
  const bgBuffer = fs.readFileSync(backgroundPath);
  const bgMeta = await sharp(bgBuffer).metadata();
  const bgWidth = bgMeta.width || 1920;
  const bgHeight = bgMeta.height || 1080;

  // ─── LỚP 2: Xóa nền trắng + Resize & Position Product ───────────────
  const productBuffer = fs.readFileSync(productImagePath);
  const targetProductHeight = Math.round(bgHeight * productHeightRatio);

  // B1: Đảm bảo có kênh alpha
  const productWithAlpha = await sharp(productBuffer)
    .ensureAlpha()
    .toBuffer();

  // B2: Đọc raw RGBA và xóa pixel gần trắng
  // QUAN TRỌNG: phải .ensureAlpha() lại TRƯỚC .raw() để đảm bảo 4 channels
  const productWithAlphaMeta = await sharp(productWithAlpha).metadata();
  const rawWidth = productWithAlphaMeta.width;
  const rawHeight = productWithAlphaMeta.height;

  const { data: rawPixels } = await sharp(productWithAlpha)
    .ensureAlpha()   // force RGBA channels=4 trong raw output
    .raw()
    .toBuffer({ resolveWithObject: true });

  const WHITE_THRESHOLD = 240;
  const NEAR_WHITE_THRESHOLD = 250;

  const buf = Buffer.from(rawPixels);
  const stride = 4;
  for (let i = 0; i < buf.length; i += stride) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    if (r >= NEAR_WHITE_THRESHOLD && g >= NEAR_WHITE_THRESHOLD && b >= NEAR_WHITE_THRESHOLD) {
      buf[i + 3] = 0;
    } else if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) {
      const whiteness = Math.min(r, g, b);
      const alpha = Math.round((255 - whiteness) * (255 / (255 - WHITE_THRESHOLD)));
      buf[i + 3] = Math.max(0, Math.min(255, alpha));
    }
  }

  // B3: Rebuild từ raw buffer với width/height/channels rõ ràng
  const productNoBg = await sharp(buf, {
    raw: { width: rawWidth, height: rawHeight, channels: 4 },
  })
    .png()
    .toBuffer();

  const resizedProduct = await sharp(productNoBg)
    .resize({
      height: targetProductHeight,
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const productMeta = await sharp(resizedProduct).metadata();
  const productWidth = productMeta.width || targetProductHeight;
  const productHeight = productMeta.height || targetProductHeight;

  // Tính vị trí đặt sản phẩm
  let productTop, productLeft;
  productLeft = Math.round((bgWidth - productWidth) / 2);
  if (productPosition === "center-bottom") {
    productTop = Math.round(bgHeight - productHeight - bgHeight * 0.05);
  } else {
    // center
    productTop = Math.round((bgHeight - productHeight) / 2);
  }
  // Clamp
  productTop = Math.max(0, productTop);
  productLeft = Math.max(0, productLeft);

  // ─── LỚP 3: Resize Logo ──────────────────────────────────────────
  const composites = [
    {
      input: resizedProduct,
      top: productTop,
      left: productLeft,
    },
  ];

  if (fs.existsSync(logoPath)) {
    const logoBuffer = fs.readFileSync(logoPath);
    const targetLogoWidth = Math.round(bgWidth * logoWidthRatio);

    const resizedLogo = await sharp(logoBuffer)
      .resize({
        width: targetLogoWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    const logoMeta = await sharp(resizedLogo).metadata();
    const logoWidth = logoMeta.width || targetLogoWidth;
    const logoHeight = logoMeta.height || Math.round(targetLogoWidth / 3);

    // Đặt logo ở góc phải dưới, cách lề 3%
    const logoMargin = Math.round(bgWidth * 0.03);
    composites.push({
      input: resizedLogo,
      top: bgHeight - logoHeight - logoMargin,
      left: bgWidth - logoWidth - logoMargin,
    });
  } else {
    process.stderr.write(
      `[media_agent] WARN: Logo khong ton tai tai ${logoPath}, bo qua lop 3.\n`,
    );
  }

  // ─── COMPOSITE ──────────────────────────────────────────────────
  const outFile = outputPath || backgroundPath.replace(
    /(\.[a-z]+)$/i,
    "_composite$1",
  );

  await sharp(bgBuffer)
    .composite(composites)
    .png({ quality: 95 })
    .toFile(outFile);

  return outFile;
}

module.exports = {
  buildMediaPromptRequestPrompt,
  buildMediaPromptReviseRequestPrompt,
  buildMediaGeneratePrompt,
  buildMediaRevisePrompt,
  buildMediaSystemPrompt,
  compositeImage3Layers,
  DEFAULT_LOGO_DIR,
  DEFAULT_LOGO_PATH,
  generateVideo,
  parseMediaPromptRequest,
  parseImageResult,
  parseMediaResult,
  parseVideoResult,
  normalizeAgentReportedPath,
  resolveLogoAssetPaths,
  routeMediaType,
  trackPromptVersion,
};
