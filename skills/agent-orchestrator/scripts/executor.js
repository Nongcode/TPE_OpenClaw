const { normalizeText } = require("./common");
const { buildPublishTextFromSections, extractContentSections, stripMarkdownFormatting } = require("./content_cleanup");
const {
  generateMediaAssets,
  publishCampaignPosts,
  toRepoRelative,
} = require("./campaign_pipeline");
const { createDemoProductResearchFallback, runProductResearch } = require("./product_research");
const { createSimulationArtifacts } = require("./simulation_artifacts");
const { buildTaskEnvelope, buildTaskPrompt, sendToSession } = require("./transport");

function compactReply(reply, limit = 320) {
  return String(reply || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildCompletedStepSummary(reply, targetStepType) {
  const text = String(reply || "").trim();
  if (!text) {
    return "";
  }

  const resultSection = extractSection(text, "KET_QUA");
  if (targetStepType === "final_review") {
    return (resultSection || text).slice(0, 4000);
  }

  return compactReply(resultSection || text, 320);
}

function extractSection(reply, sectionName) {
  const text = String(reply || "").trim();
  if (!text) {
    return "";
  }
  const pattern = new RegExp(
    `${sectionName}\\s*[:\\n]+([\\s\\S]*?)(?=\\n(?:KET_QUA|RUI_RO|DE_XUAT_BUOC_TIEP)\\b|$)`,
    "i",
  );
  const match = text.match(pattern);
  return match?.[1]?.trim() || "";
}

function buildHandoffContext(stepType, reply) {
  const text = String(reply || "").trim();
  if (!text) {
    return null;
  }

  if (stepType === "final_review") {
    return text.slice(0, 16000);
  }

  if (["content_review", "media_review"].includes(stepType)) {
    const resultSection = extractSection(text, "KET_QUA");
    return (resultSection || text).slice(0, 12000);
  }

  return compactReply(text, 1200);
}

function extractBestContent(reply) {
  const text = String(reply || "").trim();
  if (!text) {
    return "";
  }

  const explicitFinalContent = extractPromptByLabel(text, [
    "FINAL_CONTENT",
    "NOI_DUNG_FINAL",
    "CAPTION_LONG",
    "CAPTION_CHINH",
  ]);
  if (explicitFinalContent) {
    return sanitizeContentDraft(buildPublishTextFromSections(extractContentSections(explicitFinalContent)));
  }

  const structuredContent = buildPublishTextFromSections(extractContentSections(text));
  if (structuredContent) {
    return sanitizeContentDraft(structuredContent);
  }

  const captionProposal = extractCaptionProposal(text);
  if (captionProposal) {
    return sanitizeContentDraft(captionProposal);
  }

  return sanitizeContentDraft(extractSection(text, "KET_QUA") || text);
}

function extractCaptionProposal(text) {
  const patterns = [
    /\*{0,2}Caption đề xuất\*{0,2}\s*:\s*([\s\S]*?)(?=\n\s*\*{0,2}Caption ngắn dự phòng\*{0,2}\s*:|\n\s*\*{0,2}CTA đề xuất\*{0,2}\s*:|\n\s*\*{0,2}Hashtag đề xuất\*{0,2}\s*:|\nRUI_RO\b|\nDE_XUAT_BUOC_TIEP\b|$)/iu,
    /\*{0,2}Caption de xuat\*{0,2}\s*:\s*([\s\S]*?)(?=\n\s*\*{0,2}Caption ngan du phong\*{0,2}\s*:|\n\s*\*{0,2}CTA de xuat\*{0,2}\s*:|\n\s*\*{0,2}Hashtag de xuat\*{0,2}\s*:|\nRUI_RO\b|\nDE_XUAT_BUOC_TIEP\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return "";
}

function sanitizeContentDraft(text) {
  let cleaned = stripMarkdownFormatting(String(text || "")).trim();
  if (!cleaned) {
    return "";
  }

  const noisyPrefixes = [
    /^(?:-+\s*)?Tôi đã [\s\S]*?bản nháp content Facebook[\s\S]*?(?=\n{2,}|$)/iu,
    /^(?:-+\s*)?Toi da [\s\S]*?ban nhap content Facebook[\s\S]*?(?=\n{2,}|$)/i,
  ];
  for (const pattern of noisyPrefixes) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  return cleaned;
}

function extractPromptByLabel(reply, labels) {
  const text = String(reply || "");
  if (!text) {
    return "";
  }
  for (const label of labels) {
    const pattern = new RegExp(
      `${label}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*-?\\s*[A-Z_][A-Z0-9_\\s]*\\s*[:\\n]|$)`,
      "i",
    );
    const match = text.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return "";
}

function messageMentionsAny(normalized, patterns) {
  return patterns.some((pattern) => normalized.includes(pattern));
}

function stripNegatedRevisionPhrases(normalizedText) {
  if (!normalizedText) {
    return "";
  }
  const negatedRevisionPhrases = [
    "khong can sua",
    "khong can sua them",
    "khong yeu cau sua",
    "khong phai sua",
    "khong can bo sung",
    "khong yeu cau bo sung",
  ];
  return negatedRevisionPhrases.reduce((current, phrase) => current.split(phrase).join(" "), normalizedText);
}

function classifyReviewDecision(reply) {
  const text = String(reply || "");
  const resultSection = extractSection(text, "KET_QUA");
  const nextStepSection = extractSection(text, "DE_XUAT_BUOC_TIEP");
  const normalizedResult = normalizeText(resultSection);
  const normalizedNextStep = normalizeText(nextStepSection);
  const normalized = normalizeText(text);
  const normalizedResultForRevision = stripNegatedRevisionPhrases(normalizedResult);
  const normalizedNextStepForRevision = stripNegatedRevisionPhrases(normalizedNextStep);
  const normalizedForRevision = stripNegatedRevisionPhrases(normalized);
  const approvalSignals = [
    "duyet pass",
    "da duyet",
    "duoc duyet",
    "phe duyet",
    "chap thuan",
    "dong y trien khai",
    "cho trien khai",
    "ke hoach dat",
    "content dat",
    "media dat",
    "du dieu kien",
    "khong co hang muc sua moi",
    "khong can sua them",
    "giu nguyen",
  ];
  const strongApprovalSignals = [
    "dat yeu cau de chuyen",
    "du dieu kien chuyen",
    "co the chuyen",
    "chuyen sang brief media",
    "chuyen sang media",
    "giao sang buoc media",
    "qua gate noi dung",
    "qua gate media",
    "duyet ok",
    "trang thai san sang dang",
  ];
  const revisionSignals = [
    "khong duyet",
    "chua duyet",
    "khong dat",
    "chua dat",
    "chua ok",
    "chua on",
    "khong du dieu kien",
    "chua du dieu kien",
    "khong xac nhan",
    "can sua",
    "yeu cau sua",
    "phai sua",
    "de nghi sua",
    "lam lai",
    "tra lai",
    "sua lai",
    "can bo sung",
    "yeu cau bo sung",
    "phan bien",
  ];

  if (
    messageMentionsAny(normalizedResult, strongApprovalSignals) ||
    messageMentionsAny(normalizedNextStep, strongApprovalSignals)
  ) {
    return "approved";
  }
  if (
    messageMentionsAny(normalizedResultForRevision, revisionSignals) ||
    messageMentionsAny(normalizedNextStepForRevision, revisionSignals)
  ) {
    return "revise";
  }
  if (messageMentionsAny(normalizedResult, approvalSignals)) {
    return "approved";
  }
  if (messageMentionsAny(normalizedForRevision, revisionSignals)) {
    return "revise";
  }
  if (messageMentionsAny(normalized, approvalSignals)) {
    return "approved";
  }
  return "unknown";
}

function buildRevisionLoop(step, reply, loopCount) {
  if (loopCount >= 2) {
    return [];
  }

  if (step.type === "content_review") {
    return [
      {
        ...step,
        type: "content_revise",
        from: step.to,
        to: "nv_content",
        message: `Pho phong chua duyet content. Nhan vien content phai sua theo nhan xet sau: ${compactReply(reply)}`,
      },
      {
        ...step,
        type: "content_review",
        from: "nv_content",
        to: step.to,
        message: `Nhan vien content da sua bai theo nhan xet truoc do. Pho phong hay duyet lai. Nhan xet truoc: ${compactReply(reply)}`,
      },
    ];
  }

  if (step.type === "media_review") {
    return [
      {
        ...step,
        type: "media_revise",
        from: step.to,
        to: "nv_media",
        message: `Pho phong chua duyet media. Nhan vien media phai sua theo nhan xet sau: ${compactReply(reply)}`,
      },
      {
        ...step,
        type: "media_review",
        from: "nv_media",
        to: step.to,
        message: `Nhan vien media da sua media theo nhan xet truoc do. Pho phong hay duyet lai. Nhan xet truoc: ${compactReply(reply)}`,
      },
    ];
  }

  if (step.type === "final_review") {
    const normalized = normalizeText(reply);
    const targetsMedia = messageMentionsAny(normalized, ["media", "video", "anh", "hinh"]);
    if (targetsMedia) {
      return [
        {
          ...step,
          type: "media_revise",
          from: step.to,
          to: "nv_media",
          message: `Truong phong yeu cau sua media theo nhan xet sau: ${compactReply(reply)}`,
        },
        {
          ...step,
          type: "media_review",
          from: "nv_media",
          to: "pho_phong",
          message: `Nhan vien media da sua media theo nhan xet cua truong phong. Pho phong hay duyet lai.`,
        },
        {
          ...step,
          type: "final_review",
          from: "pho_phong",
          to: "truong_phong",
          message: `Pho phong trinh lai bo san pham sau khi media da duoc sua theo nhan xet truoc do. Nhan xet truoc: ${compactReply(reply)}`,
        },
      ];
    }
    return [
      {
        ...step,
        type: "content_revise",
        from: step.to,
        to: "nv_content",
        message: `Truong phong yeu cau sua content theo nhan xet sau: ${compactReply(reply)}`,
      },
      {
        ...step,
        type: "content_review",
        from: "nv_content",
        to: "pho_phong",
        message: `Nhan vien content da sua content theo nhan xet cua truong phong. Pho phong hay duyet lai.`,
      },
      {
        ...step,
        type: "final_review",
        from: "pho_phong",
        to: "truong_phong",
        message: `Pho phong trinh lai bo san pham sau khi content da duoc sua theo nhan xet truoc do. Nhan xet truoc: ${compactReply(reply)}`,
      },
    ];
  }

  return [];
}

function normalizeCategoryForHandoff(category) {
  if (!category) {
    return "";
  }
  if (typeof category === "string") {
    return category;
  }
  if (Array.isArray(category)) {
    return category
      .map((item) => {
        if (!item) {
          return "";
        }
        if (typeof item === "string") {
          return item;
        }
        return item.name || item.id || "";
      })
      .filter(Boolean)
      .join(", ");
  }
  if (typeof category === "object") {
    return category.name || category.id || "";
  }
  return String(category);
}

function buildPublishSimulationReply(workflowState) {
  const hasContent = Boolean(String(workflowState.finalContent || "").trim());
  const hasImagePrompt = Boolean(String(workflowState.imagePrompt || "").trim());
  const hasVideoPrompt = Boolean(String(workflowState.videoPrompt || "").trim());

  const status = hasContent && (hasImagePrompt || hasVideoPrompt) ? "READY_FOR_MAIN_BATCH" : "MISSING_INPUT";

  return [
    "KET_QUA:",
    `- Mo phong dang Facebook: ${status}.`,
    "- Khong post that. Da tao goi du lieu cho agent main xu ly batch sau.",
    `- FINAL_CONTENT: ${hasContent ? "co" : "thieu"}`,
    `- IMAGE_PROMPT: ${hasImagePrompt ? "co" : "thieu"}`,
    `- VIDEO_PROMPT: ${hasVideoPrompt ? "co" : "thieu"}`,
    "",
    "RUI_RO:",
    hasContent ? "- Khong co rui ro lon o buoc mo phong." : "- Chua co final content nen chua du dieu kien vao luong post that.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Nguoi dung goi agent main de chay skill tao anh/video va dang Facebook hang loat.",
  ].join("\n");
}

function isDemoSmoothModeEnabled(options) {
  return options?.demoSmoothMode !== false;
}

function buildDemoImagePrompt(workflowState) {
  const productName =
    workflowState?.productResearch?.data?.product_name || "cau nang o to 2 tru";
  return [
    `Realistic Vietnamese automotive garage, ${productName},`,
    "clean industrial lighting, natural technician activity,",
    "sales-focused composition, no text, social-ready hero image",
  ].join(" ");
}

function buildDemoVideoPrompt(workflowState) {
  const productName =
    workflowState?.productResearch?.data?.product_name || "cau nang o to 2 tru";
  return [
    `15-second promotional vertical video for ${productName},`,
    "garage context in Vietnam, reveal equipment details,",
    "highlight safety and productivity benefits, no text overlays",
  ].join(" ");
}

function getOriginalProductImagePaths(workflowState) {
  const items = workflowState?.productResearch?.data?.images;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => item?.file_path).filter(Boolean);
}

function formatAssetList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- (khong co file anh goc)";
  }
  return items.map((filePath) => `- ${filePath}`).join("\n");
}

function shouldForceOriginalImageMedia(step, workflowState, plan) {
  // Legacy shortcut disabled: media now runs through real generation + publish skills.
  return false;
}

function buildOriginalImageMediaReply(step, workflowState) {
  ensureDemoWorkflowBundle(workflowState);
  const imagePaths = getOriginalProductImagePaths(workflowState);
  const assetList = formatAssetList(imagePaths);

  if (step.type === "produce" || step.type === "media_revise") {
    return [
      "KET_QUA:",
      "- Da hoan tat buoc media bang anh goc san pham, khong su dung skill tao anh.",
      "- Anh goc duoc chon de dong vai tro anh final cho workflow:",
      assetList,
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "",
      "RUI_RO:",
      "- Chat luong anh phu thuoc vao bo anh goc hien co.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Chuyen sang buoc review media voi bo anh goc da chot.",
    ].join("\n");
  }

  if (step.type === "media_review") {
    return [
      "KET_QUA:",
      "- DUYET PASS media voi bo anh goc san pham.",
      "- Xac nhan bo anh goc duoc su dung truc tiep lam anh trien khai:",
      assetList,
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "",
      "RUI_RO:",
      "- Khong co rui ro blocker o buoc media review.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Chuyen compile_post de dong goi ho so trinh truong phong.",
    ].join("\n");
  }

  if (step.type === "compile_post") {
    return [
      "KET_QUA:",
      "- Da tong hop goi bai viet hoan chinh voi anh goc san pham (khong tao anh moi).",
      `- FINAL_CONTENT: ${workflowState.finalContent}`,
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "- CHECKLIST_TAI_NGUYEN:",
      "  - Content final: co",
      `  - Anh goc san pham: ${imagePaths.length > 0 ? "co" : "thieu"}`,
      "  - Prompt anh/video: co",
      "- DANH_SACH_ANH_GOC:",
      assetList,
      "",
      "RUI_RO:",
      "- Khong co rui ro blocker o buoc tong hop.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Trinh truong_phong final_review.",
    ].join("\n");
  }

  if (step.type === "final_review") {
    return [
      "KET_QUA:",
      "- Truong phong DUYET PASS goi bai viet de trinh nguoi dung.",
      "- Media su dung 100% anh goc san pham, khong dung skill tao anh.",
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "- DANH_SACH_ANH_GOC_DA_CHOT:",
      assetList,
      "",
      "RUI_RO:",
      "- Khong co rui ro blocker cho buoc mo phong tiep theo.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Cho nguoi dung xac nhan va chuyen sang publish mo phong.",
    ].join("\n");
  }

  return "";
}

function ensureDemoWorkflowBundle(workflowState) {
  if (!String(workflowState.finalContent || "").trim()) {
    const productName = workflowState?.productResearch?.data?.product_name || "san pham";
    const productUrl = workflowState?.productResearch?.data?.product_url || "";
    workflowState.finalContent = [
      `Bai viet demo da duoc duyet cho ${productName}.`,
      "Thong diep: giup gara van hanh nhanh hon, an toan hon, chuyen nghiep hon.",
      productUrl ? `Thong tin tham khao: ${productUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!String(workflowState.imagePrompt || "").trim()) {
    workflowState.imagePrompt = buildDemoImagePrompt(workflowState);
  }

  if (!String(workflowState.videoPrompt || "").trim()) {
    workflowState.videoPrompt = buildDemoVideoPrompt(workflowState);
  }
}

function buildDemoSmoothReply(step, workflowState) {
  ensureDemoWorkflowBundle(workflowState);

  if (step.type === "media_review") {
    return [
      "KET_QUA:",
      "- Da xem xet va duyet OK media cho buoc demo.",
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "",
      "RUI_RO:",
      "- Day la che do demo smooth de trinh dien quy trinh.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Tiep tuc buoc tiep theo trong luong.",
    ].join("\n");
  }

  if (step.type === "final_review") {
    return [
      "KET_QUA:",
      "- Truong phong da xem xet va duyet OK toan bo goi demo.",
      `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
      "",
      "RUI_RO:",
      "- Khong co rui ro lon trong phien ban trinh dien.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Cho nguoi dung xac nhan de qua workflow thuc thi chinh.",
    ].join("\n");
  }

  return [
    "KET_QUA:",
    "- Buoc demo da hoan thanh mượt.",
    `- IMAGE_PROMPT: ${workflowState.imagePrompt}`,
    `- VIDEO_PROMPT: ${workflowState.videoPrompt}`,
    "",
    "RUI_RO:",
    "- Day la ket qua mo phong de trinh bay quy trinh.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Tiep tuc theo dung thu tu da dinh.",
  ].join("\n");
}

function formatPathList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "- (khong co)";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function safeRepoRelative(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    return toRepoRelative(filePath);
  } catch {
    return String(filePath);
  }
}

function buildMediaProduceReply(workflowState) {
  const research = workflowState?.productResearch?.data || {};
  const referenceImages = Array.isArray(workflowState.referenceImages)
    ? workflowState.referenceImages.map(safeRepoRelative)
    : [];
  const generatedImages = Array.isArray(workflowState.generatedImagePaths)
    ? workflowState.generatedImagePaths.map(safeRepoRelative)
    : [];
  const generatedVideos = Array.isArray(workflowState.generatedVideoPaths)
    ? workflowState.generatedVideoPaths.map(safeRepoRelative)
    : [];
  const videoSkippedReason = workflowState.videoGenerationSkipped?.reason || "";

  return [
    "KET_QUA:",
    "- Nv_media da nhan content + prompt va tao media that bang skill gemini_generate_image + generate_video.",
    `- TEN_SAN_PHAM: ${research.product_name || "(khong ro)"}`,
    `- THU_MUC_ANH_GOC: ${research.image_download_dir || "(khong ro)"}`,
    `- THU_MUC_MEDIA_DA_TAO: ${safeRepoRelative(workflowState.mediaBundleDir || "") || "(khong ro)"}`,
    `- FINAL_CONTENT: ${workflowState.finalContent || workflowState.latestContentDraft || ""}`,
    `- IMAGE_PROMPT: ${workflowState.imagePrompt || ""}`,
    `- VIDEO_PROMPT: ${workflowState.videoPrompt || ""}`,
    "- ANH_GOC_THAM_CHIEU:",
    formatPathList(referenceImages),
    "- ANH_DA_TAO:",
    formatPathList(generatedImages),
    "- VIDEO_DA_TAO:",
    formatPathList(generatedVideos),
    videoSkippedReason ? `- VIDEO_SKIP_REASON: ${videoSkippedReason}` : "",
    "",
    "RUI_RO:",
    generatedVideos.length > 0
      ? "- Can pho_phong kiem nhanh do khop giua content, anh va video truoc khi dang Facebook."
      : "- Video co the da duoc bo qua do quota/gioi han; workflow van tiep tuc voi image.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Chuyen media_review de pho_phong duyet mac dinh PASS.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMediaReviewApprovedReply(workflowState) {
  const generatedImages = Array.isArray(workflowState.generatedImagePaths)
    ? workflowState.generatedImagePaths.map(safeRepoRelative)
    : [];
  const generatedVideos = Array.isArray(workflowState.generatedVideoPaths)
    ? workflowState.generatedVideoPaths.map(safeRepoRelative)
    : [];
  const videoSkippedReason = workflowState.videoGenerationSkipped?.reason || "";

  return [
    "KET_QUA:",
    "- Pho phong review media: OK. Mac dinh duyet toan bo media hien co.",
    `- THU_MUC_MEDIA_DA_TAO: ${safeRepoRelative(workflowState.mediaBundleDir || "") || "(khong ro)"}`,
    `- IMAGE_PROMPT: ${workflowState.imagePrompt || ""}`,
    `- VIDEO_PROMPT: ${workflowState.videoPrompt || ""}`,
    "- ANH_DA_DUYET:",
    formatPathList(generatedImages),
    "- VIDEO_DA_DUYET:",
    formatPathList(generatedVideos),
    videoSkippedReason ? `- VIDEO_SKIP_REASON: ${videoSkippedReason}` : "",
    "",
    "RUI_RO:",
    generatedVideos.length > 0
      ? "- Khong co blocker o buoc media_review."
      : "- Video da duoc bo qua hop le; khong block luong dang image.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Chuyen compile_post de pho_phong dong goi ho so dang bai va trinh truong_phong final_review.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCompilePostReply(workflowState) {
  const generatedImages = Array.isArray(workflowState.generatedImagePaths)
    ? workflowState.generatedImagePaths.map(safeRepoRelative)
    : [];
  const generatedVideos = Array.isArray(workflowState.generatedVideoPaths)
    ? workflowState.generatedVideoPaths.map(safeRepoRelative)
    : [];
  const videoSkippedReason = workflowState.videoGenerationSkipped?.reason || "";
  const publishState =
    generatedImages.length > 0 && generatedVideos.length > 0
      ? "READY_IMAGE_AND_VIDEO"
      : generatedImages.length > 0
        ? "READY_IMAGE_ONLY"
        : "MISSING_IMAGE";

  return [
    "KET_QUA:",
    "- Pho phong da dong goi ho so dang bai sau khi content va media da duyet.",
    `- TRANG_THAI_SAN_SANG_DANG: ${publishState}`,
    `- THU_MUC_MEDIA_DA_TAO: ${safeRepoRelative(workflowState.mediaBundleDir || "") || "(khong ro)"}`,
    `- IMAGE_POST_MEDIA: ${generatedImages[0] || "(khong co)"}`,
    `- VIDEO_POST_MEDIA: ${generatedVideos[0] || "(khong co)"}`,
    `- IMAGE_POST_CAPTION_SHORT: ${workflowState.mediaSpecificContent?.image?.caption_short || ""}`,
    `- VIDEO_POST_CAPTION_SHORT: ${workflowState.mediaSpecificContent?.video?.caption_short || ""}`,
    `- FINAL_CONTENT: ${workflowState.finalContent || workflowState.latestContentDraft || ""}`,
    `- IMAGE_PROMPT: ${workflowState.imagePrompt || ""}`,
    `- VIDEO_PROMPT: ${workflowState.videoPrompt || ""}`,
    videoSkippedReason ? `- VIDEO_SKIP_REASON: ${videoSkippedReason}` : "",
    "",
    "RUI_RO:",
    "- Chua publish Facebook o buoc nay; van co the dung final_review de chan/sua truoc khi dang that.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Trinh truong_phong final_review. Neu truong_phong duyet, he thong moi goi facebook_publish_post de dang that.",
  ]
    .filter(Boolean)
    .join("\n");
}

function appendPublishResultToFinalReply(reply, workflowState) {
  const publish = workflowState.publishResults || {};
  const imageResult = publish.image || {};
  const videoResult = publish.video || {};
  const generatedImages = Array.isArray(workflowState.generatedImagePaths)
    ? workflowState.generatedImagePaths.map(safeRepoRelative)
    : [];
  const generatedVideos = Array.isArray(workflowState.generatedVideoPaths)
    ? workflowState.generatedVideoPaths.map(safeRepoRelative)
    : [];

  const publishLines = [
    "PHAT_HANH_FACEBOOK:",
    "- He thong da goi skill facebook_publish_post sau khi truong_phong duyet.",
    `- IMAGE_POST_ID: ${imageResult.post_id || "(khong co)"}`,
    `- IMAGE_POST_MEDIA: ${generatedImages[0] || "(khong co)"}`,
  ];

  if (videoResult?.skipped) {
    publishLines.push(`- VIDEO_POST: BO_QUA (${videoResult.reason || "khong co video publishable"})`);
  } else {
    publishLines.push(`- VIDEO_POST_ID: ${videoResult.post_id || "(khong co)"}`);
    publishLines.push(`- VIDEO_POST_MEDIA: ${generatedVideos[0] || "(khong co)"}`);
  }

  publishLines.push(`- IMAGE_POST_CAPTION_SHORT: ${workflowState.mediaSpecificContent?.image?.caption_short || ""}`);
  publishLines.push(`- VIDEO_POST_CAPTION_SHORT: ${workflowState.mediaSpecificContent?.video?.caption_short || ""}`);

  return `${String(reply || "").trim()}\n\n${publishLines.join("\n")}`.trim();
}

async function executePlan(registry, plan, options) {
  const steps = [];
  const reviewLoopCounts = new Map();
  const simulation = createSimulationArtifacts(plan, options);
  const workflowState = {
    productResearch: null,
    finalContent: "",
    latestContentDraft: "",
    imagePrompt: "",
    videoPrompt: "",
    productProfile: null,
    salesContent: null,
    mediaSpecificContent: null,
    sourceArtifacts: {},
    referenceImages: [],
    videoReferenceImages: [],
    generatedImagePaths: [],
    generatedVideoPaths: [],
    mediaBundleDir: "",
    mediaGeneration: null,
    videoGenerationSkipped: null,
    publishResults: null,
  };
  const demoSmoothMode = isDemoSmoothModeEnabled(options);
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const agent = registry.byId[step.to];
    if (!agent) {
      throw new Error(`Unknown target agent: ${step.to}`);
    }

    if (step.type === "product_research") {
      let payload;
      try {
        payload = runProductResearch(step, plan, options);
      } catch (error) {
        if (!demoSmoothMode) {
          throw error;
        }
        payload = createDemoProductResearchFallback(step, plan, options);
        simulation?.addNote(
          `Demo smooth fallback at step ${index + 1} (${step.type}): ${error?.message || error}`,
        );
      }
      workflowState.productResearch = payload;
      const summary = [
        `Da lay du lieu san pham bang skill search_product_text.`,
        `San pham: ${payload?.data?.product_name || "(khong ro)"}`,
        `URL: ${payload?.data?.product_url || "(khong ro)"}`,
        `Thu muc anh: ${payload?.data?.image_download_dir || "(khong ro)"}`,
      ].join("\n");
      const record = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: "product_research",
          from: step.from,
          to: step.to,
          keyword: payload.keyword,
          targetSite: payload.targetSite,
        },
        prompt: "[local] run skills/search_product_text/action.js",
        reply: summary,
        productResearch: payload,
      };
      steps.push(record);
      simulation?.setProductResearch(payload);
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        keyword: payload.keyword,
        targetSite: payload.targetSite,
        productName: payload?.data?.product_name || null,
        productUrl: payload?.data?.product_url || null,
      });
      continue;
    }

    if (step.type === "publish") {
      const publishReply = buildPublishSimulationReply(workflowState);
      const publishRecord = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: "publish",
          from: step.from,
          to: step.to,
          simulateOnly: true,
        },
        prompt: "[local] simulate facebook publish payload",
        reply: publishReply,
      };
      steps.push(publishRecord);
      simulation?.setPublishSimulation({
        status: "SIMULATED",
        finalContent: workflowState.finalContent || "",
        imagePrompt: workflowState.imagePrompt || "",
        videoPrompt: workflowState.videoPrompt || "",
      });
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        status: "SIMULATED",
        hasFinalContent: Boolean(workflowState.finalContent),
        hasImagePrompt: Boolean(workflowState.imagePrompt),
        hasVideoPrompt: Boolean(workflowState.videoPrompt),
      });
      continue;
    }

    if (
      (step.type === "produce" || step.type === "media_revise") &&
      step.to === "nv_media"
    ) {
      const mediaResult = await generateMediaAssets(workflowState, options);
      const mediaReply = buildMediaProduceReply(workflowState);
      const mediaRecord = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: step.type,
          from: step.from,
          to: step.to,
          localSkillPipeline: true,
        },
        prompt: "[local] run gemini_generate_image + generate_video with product reference images",
        reply: mediaReply,
        mediaResult,
      };
      steps.push(mediaRecord);
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        sessionKey: mediaRecord.sessionKey,
        replyPreview: compactReply(mediaReply, 1200),
        referenceImages: Array.isArray(workflowState.referenceImages)
          ? workflowState.referenceImages.map(safeRepoRelative)
          : [],
        generatedImages: Array.isArray(workflowState.generatedImagePaths)
          ? workflowState.generatedImagePaths.map(safeRepoRelative)
          : [],
        generatedVideos: Array.isArray(workflowState.generatedVideoPaths)
          ? workflowState.generatedVideoPaths.map(safeRepoRelative)
          : [],
      });
      continue;
    }

    if (step.type === "media_review") {
      const reviewReply = buildMediaReviewApprovedReply(workflowState);
      const reviewRecord = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: "media_review",
          from: step.from,
          to: step.to,
          autoApproved: true,
        },
        prompt: "[local] auto-approve media review",
        reply: reviewReply,
      };
      steps.push(reviewRecord);
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        sessionKey: reviewRecord.sessionKey,
        replyPreview: compactReply(reviewReply, 1200),
        decision: "approved",
      });
      continue;
    }

    if (step.type === "compile_post") {
      const compileReply = buildCompilePostReply(workflowState);
      const compileRecord = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: "compile_post",
          from: step.from,
          to: step.to,
          localSkillPipeline: true,
          published: false,
        },
        prompt: "[local] compile reviewed content + media package for final approval",
        reply: compileReply,
      };
      steps.push(compileRecord);
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        sessionKey: compileRecord.sessionKey,
        replyPreview: compactReply(compileReply, 1200),
        mediaBundleDir: safeRepoRelative(workflowState.mediaBundleDir || ""),
        readyState:
          Array.isArray(workflowState.generatedImagePaths) && workflowState.generatedImagePaths.length > 0
            ? Array.isArray(workflowState.generatedVideoPaths) &&
              workflowState.generatedVideoPaths.length > 0
              ? "READY_IMAGE_AND_VIDEO"
              : "READY_IMAGE_ONLY"
            : "MISSING_IMAGE",
      });
      continue;
    }

    if (shouldForceOriginalImageMedia(step, workflowState, plan)) {
      const forcedReply = buildOriginalImageMediaReply(step, workflowState);
      const forcedRecord = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: step.type,
          from: step.from,
          to: step.to,
          forcedOriginalImages: true,
        },
        prompt: "[local] force media workflow to use original product images",
        reply: forcedReply,
      };
      steps.push(forcedRecord);

      const forcedStepRecord = {
        type: step.type,
        from: step.from,
        to: step.to,
        sessionKey: forcedRecord.sessionKey,
        replyPreview: compactReply(forcedReply, 1200),
        decision:
          ["content_review", "media_review", "final_review"].includes(step.type)
            ? classifyReviewDecision(forcedReply)
            : null,
      };
      simulation?.addStep(index, forcedStepRecord);

      const forcedImagePrompt = extractPromptByLabel(forcedReply, [
        "IMAGE_PROMPT",
        "PROMPT_ANH",
        "PROMPT TẠO ẢNH",
        "PROMPT TAO ANH",
      ]);
      const forcedVideoPrompt = extractPromptByLabel(forcedReply, [
        "VIDEO_PROMPT",
        "PROMPT_VIDEO",
        "PROMPT TẠO VIDEO",
        "PROMPT TAO VIDEO",
      ]);
      if (forcedImagePrompt) {
        workflowState.imagePrompt = forcedImagePrompt;
      }
      if (forcedVideoPrompt) {
        workflowState.videoPrompt = forcedVideoPrompt;
      }
      continue;
    }

    const priorSteps = steps.map((item) => ({
      stepIndex: item.envelope?.stepIndex ?? null,
      from: item.from,
      to: item.to,
      type: item.type,
      summary: buildCompletedStepSummary(item.reply, step.type),
    }));
    const isReviewStep = ["content_review", "media_review", "final_review"].includes(
      step.type,
    );
    const previousReply = steps.length > 0 ? steps[steps.length - 1]?.reply : null;
    let handoffContext = buildHandoffContext(step.type, previousReply);
    if (
      step.to === "nv_content" &&
      workflowState.productResearch?.data &&
      ["produce", "content_revise"].includes(step.type)
    ) {
      const research = workflowState.productResearch.data;
      const normalizedCategory = normalizeCategoryForHandoff(
        research.category || research.categories || "",
      );
      const researchSummary = [
        `TEN_SAN_PHAM: ${research.product_name || ""}`,
        `URL_SAN_PHAM: ${research.product_url || ""}`,
        `DANH_MUC: ${normalizedCategory}`,
        `THONG_SO: ${research.specifications_text || ""}`,
        `THU_MUC_ANH_GOC: ${research.image_download_dir || ""}`,
      ].join("\n");
      handoffContext = handoffContext
        ? `${handoffContext}\n\nDU_LIEU_SAN_PHAM_BAT_BUOC:\n${researchSummary}`
        : `DU_LIEU_SAN_PHAM_BAT_BUOC:\n${researchSummary}`;
    }
    const envelope = buildTaskEnvelope(step, registry, index, plan.steps.length, {
      handoffContext,
      completedSteps: isReviewStep
        ? priorSteps.map((item) =>
            step.type === "final_review"
              ? item
              : {
                  stepIndex: item.stepIndex,
                  from: item.from,
                  to: item.to,
                  type: item.type,
                },
          )
        : priorSteps,
    });
    const prompt = buildTaskPrompt(envelope, registry);
    if (options.dryRun) {
      steps.push({
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope,
        prompt,
        reply: "[dry-run] Khong goi gateway.",
      });
      continue;
    }

    let rawReply = "";
    try {
      rawReply = await sendToSession({
        agentId: agent.id,
        openClawHome: options.openClawHome,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope,
        prompt,
      });
    } catch (error) {
      if (!demoSmoothMode) {
        throw error;
      }
      simulation?.addNote(
        `Demo smooth fallback at step ${index + 1} (${step.type}): ${error?.message || error}`,
      );
      rawReply = "";
    }
    let reply = String(rawReply || "").trim();

    if (
      demoSmoothMode &&
      !reply &&
      ["produce", "media_revise", "media_review", "compile_post", "final_review"].includes(
        step.type,
      )
    ) {
      reply = buildDemoSmoothReply(step, workflowState);
    }

    steps.push({
      ...step,
      sessionKey: agent.transport?.sessionKey || agent.sessionKey,
      envelope,
      prompt,
      reply,
    });

    let decision =
      ["content_review", "media_review", "final_review"].includes(step.type)
        ? demoSmoothMode
          ? "approved"
          : classifyReviewDecision(reply)
        : null;

    if (step.type === "final_review" && decision === "approved") {
      const publishResult = await publishCampaignPosts(workflowState, options);
      reply = appendPublishResultToFinalReply(reply, workflowState);
      steps[steps.length - 1].reply = reply;
      steps[steps.length - 1].publishResult = publishResult;
      simulation?.setPublishExecution({
        image: workflowState.publishResults?.image || null,
        video: workflowState.publishResults?.video || null,
        generatedImagePaths: Array.isArray(workflowState.generatedImagePaths)
          ? workflowState.generatedImagePaths.map(safeRepoRelative)
          : [],
        generatedVideoPaths: Array.isArray(workflowState.generatedVideoPaths)
          ? workflowState.generatedVideoPaths.map(safeRepoRelative)
          : [],
        mediaBundleDir: safeRepoRelative(workflowState.mediaBundleDir || ""),
      });
    }

    const stepRecord = {
      type: step.type,
      from: step.from,
      to: step.to,
      sessionKey: agent.transport?.sessionKey || agent.sessionKey,
      replyPreview: compactReply(reply, 1200),
      decision,
    };
    simulation?.addStep(index, stepRecord);

    if (step.to === "nv_content" && ["produce", "content_revise"].includes(step.type)) {
      const candidate = extractBestContent(reply);
      if (candidate) {
        workflowState.latestContentDraft = candidate;
      }
    }
    if (step.type === "content_review") {
      if (decision === "approved" && workflowState.latestContentDraft) {
        workflowState.finalContent = workflowState.latestContentDraft;
      }
    }
    if (["produce", "media_review", "compile_post"].includes(step.type)) {
      const imagePrompt = extractPromptByLabel(reply, [
        "IMAGE_PROMPT",
        "PROMPT_ANH",
        "PROMPT TẠO ẢNH",
        "PROMPT TAO ANH",
      ]);
      const videoPrompt = extractPromptByLabel(reply, [
        "VIDEO_PROMPT",
        "PROMPT_VIDEO",
        "PROMPT TẠO VIDEO",
        "PROMPT TAO VIDEO",
      ]);
      if (imagePrompt) {
        workflowState.imagePrompt = imagePrompt;
      }
      if (videoPrompt) {
        workflowState.videoPrompt = videoPrompt;
      }
    }

    if (
      demoSmoothMode &&
      ["produce", "media_revise", "media_review", "compile_post", "final_review"].includes(step.type)
    ) {
      ensureDemoWorkflowBundle(workflowState);
    }

    if (["content_review", "media_review", "final_review"].includes(step.type)) {
      if (options.dryRun) {
        continue;
      }

      const loopCount = reviewLoopCounts.get(step.type) || 0;
      if (decision !== "approved") {
        reviewLoopCounts.set(step.type, loopCount + 1);
        const revisionSteps = buildRevisionLoop(step, reply, loopCount);
        if (revisionSteps.length > 0) {
          plan.steps.splice(index + 1, 0, ...revisionSteps);
        } else {
          throw new Error(
            `Workflow blocked: step ${step.type} not approved after ${loopCount + 1} review attempts.`,
          );
        }
      }
    }
  }

  if (demoSmoothMode) {
    ensureDemoWorkflowBundle(workflowState);
  }

  simulation?.setFinalContent(workflowState.finalContent);
  simulation?.setImagePrompt(workflowState.imagePrompt);
  simulation?.setVideoPrompt(workflowState.videoPrompt);
  simulation?.setBatchInput({
    workflowMode: plan.mode,
    fromAgent: plan.from,
    taskType: plan.taskType || null,
    message: plan.message || "",
    finalContent: workflowState.finalContent || "",
    imagePrompt: workflowState.imagePrompt || "",
    videoPrompt: workflowState.videoPrompt || "",
    productResearch: workflowState.productResearch?.data || null,
    productOriginalImages: Array.isArray(workflowState.productResearch?.data?.images)
      ? workflowState.productResearch.data.images
          .map((item) => item?.file_path)
          .filter(Boolean)
      : [],
    readyForBatchExecution:
      Boolean(String(workflowState.finalContent || "").trim()) &&
      (Boolean(String(workflowState.imagePrompt || "").trim()) ||
        Boolean(String(workflowState.videoPrompt || "").trim())),
  });

  const result = {
    ...plan,
    executedSteps: steps,
    finalReply: steps[steps.length - 1]?.reply || "",
    simulationArtifacts: simulation ? { runDir: simulation.runDir } : null,
  };

  simulation?.finalize(result);

  return {
    ...result,
  };
}

module.exports = {
  extractBestContent,
  buildOriginalImageMediaReply,
  shouldForceOriginalImageMedia,
  classifyReviewDecision,
  executePlan,
};
