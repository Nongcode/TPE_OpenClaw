/**
 * content_agent.js — Logic riêng cho NV Content.
 *
 * Chịu trách nhiệm:
 * - Build system prompt với anti-AI rules + rules.json
 * - Tạo prompt viết bài mới / sửa bài
 * - Parse kết quả từ LLM reply
 * - Tích hợp trend_analyzer cho hashtag
 */

const path = require("path");
const { spawnSync } = require("child_process");
const memory = require("./memory");
const mediaAgent = require("./media_agent");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * System prompt CHỐNG AI DETECTION — cứng, không thay đổi.
 */
const ANTI_AI_RULES = [
  "",
  "QUY TAC VIET BAI FACEBOOK (BAT BUOC):",
  "",
  "1. CAM TUYET DOI su dung cac cum tu sao rong sau:",
  '   - "Hon bao gio het"',
  '   - "Hay cung kham pha"',
  '   - "Trong the gioi ngay nay"',
  '   - "Nang tam"',
  '   - "Buc tranh toan canh"',
  '   - "Giai phap hoan hao"',
  '   - "Diem nhan an tuong"',
  '   - "Su lua chon hang dau"',
  '   - "Khong the bo qua"',
  '   - "Dac biet danh cho"',
  '   - "Trai nghiem tuyet voi"',
  "",
  "2. VAN PHONG phai tu nhien nhu nguoi that dang noi chuyen:",
  "   - Cau dai ngan xen ke nhau",
  "   - Thỉnh thoang dung ngon ngu doi thuong, suong sa",
  "   - Khong viet hoa toan bo, khong lam dung cau cam than",
  "   - Viet nhu dang chia se voi ban be, khong phai quang cao",
  "",
  "3. EMOJI co tiet che:",
  "   - Toi da 3-4 emoji moi bai",
  "   - Khong spam emoji cuoi moi cau",
  "   - Dung emoji phu hop ngu canh",
  "",
  "4. CAU TRUC bai viet:",
  "   - Mo dau: 1-2 cau bat noi dung tu nhien (khong sao rong)",
  "   - Than bai: thong so that, dac diem noi bat, tinh ung dung",
  "   - Ket bai: call-to-action ngan gon, lien he/gia (neu co)",
  "   - Gach dau dong khi liet ke thong so",
  "",
  "5. THONG SO san pham phai lay tu data that cua skill search_product_text.",
  "   Khong duoc tu bua bat ky thong so, gia ca, hoac tinh nang nao.",
  "",
].join("\n");

/**
 * Build system prompt đầy đủ cho nv_content.
 */
function buildContentSystemPrompt(agentId, openClawHome) {
  const rulesSection = memory.buildRulesPromptSection(agentId, openClawHome);

  return [
    "Ban la nv_content, chuyen vien viet bai Facebook dua tren du lieu san pham that.",
    "",
    "NHIEM VU CHINH:",
    "- Tu research san pham bang skill search_product_text",
    "- Viet bai Facebook chuan SEO, thong so chinh xac",
    "- Sua bai khi co review tu sep",
    "",
    "NGUYEN TAC:",
    "- Khong duoc bua thong tin san pham",
    "- Khong tao media",
    "- Khong publish",
    ANTI_AI_RULES,
    rulesSection,
  ].join("\n");
}

/**
 * Chạy skill trend_analyzer để lấy hashtag hot.
 * Trả mảng rỗng nếu skill không available hoặc lỗi.
 */
function fetchTrendingHashtags(keyword) {
  const scriptPath = path.join(REPO_ROOT, "skills", "trend_analyzer", "action.js");
  try {
    const run = spawnSync(
      process.execPath,
      [scriptPath, JSON.stringify({ keyword, geo: "VN", count: 5 })],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
    );
    if (run.error) return [];
    const parsed = JSON.parse(run.stdout.trim());
    if (parsed?.success && Array.isArray(parsed?.data?.trends)) {
      return parsed.data.trends;
    }
  } catch {
    // Skill not available or failed — degrade gracefully
  }
  return [];
}

function normalizeContentReportedPath(value) {
  const trimmed = String(value || "")
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "");
  if (!trimmed) return "";
  return trimmed
    .replace(/([A-Za-z]:\\Users\\Administrator)\.openclaw(?=\\|$)/gi, "$1\\.openclaw")
    .replace(/([A-Za-z]:\/Users\/Administrator)\.openclaw(?=\/|$)/gi, "$1/.openclaw");
}

/**
 * Build prompt cho tạo bài mới.
 */
function buildContentDraftPrompt(params) {
  const { workflowId, stepId, brief, openClawHome, workflowGuidelines = [] } = params;
  const agentId = "nv_content";
  const systemPrompt = buildContentSystemPrompt(agentId, openClawHome);
  const successSection = memory.buildSuccessExamplesPromptSection(agentId, openClawHome, brief, 3);
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(workflowGuidelines);

  // Thử lấy trending hashtags
  const keyword = brief.split(/\s+/).slice(0, 3).join(" ");
  const trending = fetchTrendingHashtags(keyword);
  const trendSection = trending.length > 0
    ? `\nHASHTAG DANG HOT (nen chen vao cuoi bai):\n${trending.map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const lines = [
    systemPrompt,
    successSection,
    guidelineSection,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: content_draft",
    "",
    "NHIEM VU:",
    "Hay tu dung skill search_product_text trong lane cua ban de lay du lieu san pham that,",
    "sau do viet 1 bai Facebook nhap chuan SEO, van phong tu nhien.",
    "",
    "Khong tao media. Khong publish. Khong nho ai research thay ban.",
    trendSection,
    "BRIEF TU SEP:",
    brief,
    "",
    "TRONG KET_QUA, bat buoc ghi dung cac marker sau:",
    "- PRODUCT_NAME: ...",
    "- PRODUCT_URL: ...",
    "- IMAGE_DOWNLOAD_DIR: ...",
    "- PRIMARY_PRODUCT_IMAGE: <duong dan day du den file anh goc san pham chinh da duoc search_product_text tai ve>",
    "- APPROVED_CONTENT_BEGIN / APPROVED_CONTENT_END",
    "",
    "LUU Y QUAN TRONG VE PRIMARY_PRODUCT_IMAGE:",
    "- Sau khi goi search_product_text, skill se tu dong tai anh san pham ve may.",
    "- Ban BAT BUOC phai ghi lai duong dan file anh chinh (primary_image.file_path) vao marker PRIMARY_PRODUCT_IMAGE.",
    "- Duong dan phai la file that tren may (vi du: D:/CodeAiTanPhat/TPE_OpenClaw/artifacts/references/search_product_text/...).",
    "",
    "Marker content phai chinh xac:",
    "APPROVED_CONTENT_BEGIN",
    "<noi dung bai dang hoan chinh>",
    "APPROVED_CONTENT_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    "- Trong DE_XUAT_BUOC_TIEP, ban giao lai cho pho_phong duyet; khong duoc noi 'chuyen cho truong phong duyet' hay yeu cau user duyet truc tiep.",
  ];

  return lines.join("\n");
}

/**
 * Build prompt cho sửa bài (khi bị reject).
 */
function buildContentRevisePrompt(params) {
  const {
    workflowId,
    stepId,
    originalBrief,
    feedback,
    oldContent,
    openClawHome,
    workflowGuidelines = [],
  } = params;
  const agentId = "nv_content";
  const systemPrompt = buildContentSystemPrompt(agentId, openClawHome);
  const successSection = memory.buildSuccessExamplesPromptSection(
    agentId,
    openClawHome,
    `${originalBrief}\n${feedback}`,
    3,
  );
  const guidelineSection = memory.buildWorkflowGuidelinesPromptSection(workflowGuidelines);

  const lines = [
    systemPrompt,
    successSection,
    guidelineSection,
    "",
    "BAN DANG XU LY WORKFLOW AGENT-ORCHESTRATOR-TEST.",
    `workflow_id: ${workflowId}`,
    `step_id: ${stepId}`,
    "action: content_revise",
    "",
    "NHIEM VU:",
    "User da yeu cau sua lai bai viet. Hay doc ky nhan xet, sua bai theo dung y do.",
    "Tu dung lai du lieu san pham that neu can.",
    "",
    `Brief goc: ${originalBrief}`,
    "",
    "NHAN XET TU SEP (BAT BUOC LAM THEO):",
    feedback,
    "",
    "NOI DUNG CU (BI TU CHOI):",
    oldContent || "",
    "",
    "Tra ve lai dung cac marker:",
    "- PRODUCT_NAME: ...",
    "- PRODUCT_URL: ...",
    "- IMAGE_DOWNLOAD_DIR: ...",
    "- PRIMARY_PRODUCT_IMAGE: <duong dan file anh goc san pham chinh>",
    "- APPROVED_CONTENT_BEGIN / APPROVED_CONTENT_END",
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet co dau.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    "- Trong DE_XUAT_BUOC_TIEP, ban giao lai cho pho_phong duyet; khong duoc noi 'chuyen cho truong phong duyet' hay yeu cau user duyet truc tiep.",
  ];

  return lines.join("\n");
}

/**
 * Parse reply từ nv_content — giữ nguyên logic markers cũ.
 */
function parseContentResult(reply) {
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

  const approvedContent = extractBlock(text, "APPROVED_CONTENT_BEGIN", "APPROVED_CONTENT_END");
  const productName = extractField(text, "PRODUCT_NAME");
  const productUrl = extractField(text, "PRODUCT_URL");
  const imageDir = normalizeContentReportedPath(extractField(text, "IMAGE_DOWNLOAD_DIR"));
  const primaryProductImage = mediaAgent.normalizeAgentReportedPath(
    extractField(text, "PRIMARY_PRODUCT_IMAGE"),
  );

  if (!approvedContent) {
    throw new Error("nv_content reply bi thieu APPROVED_CONTENT block.");
  }

  // Nếu agent không ghi PRIMARY_PRODUCT_IMAGE, thử tìm ảnh đầu tiên trong imageDir
  let resolvedProductImage = primaryProductImage;
  if (!resolvedProductImage && imageDir) {
    const fs = require("fs");
    try {
      if (fs.existsSync(imageDir)) {
        const files = fs.readdirSync(imageDir)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .sort();
        if (files.length > 0) {
          resolvedProductImage = path.join(imageDir, files[0]);
        }
      }
    } catch {
      // ignore — imageDir might not exist yet
    }
  }

  return {
    approvedContent,
    productName,
    productUrl,
    imageDir,
    primaryProductImage: resolvedProductImage,
    reply: text,
  };
}

module.exports = {
  ANTI_AI_RULES,
  buildContentDraftPrompt,
  buildContentRevisePrompt,
  buildContentSystemPrompt,
  fetchTrendingHashtags,
  parseContentResult,
};
