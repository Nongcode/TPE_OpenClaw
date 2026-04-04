const { normalizeText } = require("./common");
const {
  createDemoProductResearchFallback,
  extractProductKeywordFromMessage,
  runProductResearch,
} = require("./product_research");
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
  return extractSection(text, "KET_QUA") || text;
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
  const imagePaths = getOriginalProductImagePaths(workflowState);
  if (imagePaths.length === 0) {
    return false;
  }
  if (step.type === "produce" && step.to === "nv_media") {
    return true;
  }
  if (["media_revise", "media_review", "compile_post"].includes(step.type)) {
    return true;
  }
  if (step.type === "final_review") {
    return Array.isArray(plan?.steps) && plan.steps.some((item) => item?.type === "media_review");
  }
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

function tokenizeProductIntent(value) {
  const stopwords = new Set([
    "san",
    "pham",
    "may",
    "thiet",
    "bi",
    "cho",
    "de",
    "va",
    "voi",
    "trong",
    "ngoai",
    "hang",
    "loai",
    "cao",
    "cap",
    "dong",
    "goi",
    "bai",
    "facebook",
    "quang",
    "ba",
    "trien",
    "khai",
    "nhanh",
  ]);
  return Array.from(
    new Set(
      normalizeText(value)
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !stopwords.has(token)),
    ),
  );
}

function assessProductResearchAlignment(requestedKeyword, productName) {
  const requested = String(requestedKeyword || "").trim();
  const actual = String(productName || "").trim();
  if (!requested || !actual) {
    return {
      aligned: false,
      reason: "missing-data",
      overlapTokens: [],
      requestedTokens: tokenizeProductIntent(requested),
      actualTokens: tokenizeProductIntent(actual),
    };
  }

  const normalizedRequested = normalizeText(requested);
  const normalizedActual = normalizeText(actual);
  if (normalizedActual.includes(normalizedRequested)) {
    return {
      aligned: true,
      reason: "full-substring-match",
      overlapTokens: tokenizeProductIntent(requested),
      requestedTokens: tokenizeProductIntent(requested),
      actualTokens: tokenizeProductIntent(actual),
    };
  }

  const requestedTokens = tokenizeProductIntent(requested);
  const actualTokens = tokenizeProductIntent(actual);
  const overlapTokens = requestedTokens.filter((token) => actualTokens.includes(token));
  const ratio = requestedTokens.length === 0 ? 0 : overlapTokens.length / requestedTokens.length;

  return {
    aligned: overlapTokens.length >= 2 && ratio >= 0.6,
    reason: overlapTokens.length >= 2 && ratio >= 0.6 ? "token-overlap" : "weak-overlap",
    overlapTokens,
    requestedTokens,
    actualTokens,
  };
}

function buildProductResearchMismatchReply(params) {
  const requested = params.requestedKeyword || "(không rõ)";
  const actual = params.productName || "(không rõ)";
  const overlap = params.alignment?.overlapTokens?.length
    ? params.alignment.overlapTokens.join(", ")
    : "(không có)";

  return [
    "KẾT_QUẢ:",
    "- Dừng workflow tại bước nghiên cứu sản phẩm vì dữ liệu tìm được không khớp đủ với yêu cầu gốc.",
    `- YÊU_CẦU_GỐC_SẢN_PHẨM: ${requested}`,
    `- SẢN_PHẨM_ĐÃ_TÌM_ĐƯỢC: ${actual}`,
    `- URL_SẢN_PHẨM: ${params.productUrl || "(không rõ)"}`,
    `- TOKEN_KHỚP: ${overlap}`,
    "",
    "RỦI_RO:",
    "- Nếu tiếp tục giao xuống content/media, toàn bộ workflow có nguy cơ viết sai sản phẩm.",
    "",
    "ĐỀ_XUẤT_BƯỚC_TIẾP:",
    "- Xác nhận lại đúng keyword hoặc cung cấp URL sản phẩm chuẩn.",
    "- Sau khi keyword đúng, chạy lại workflow từ bước research.",
  ].join("\n");
}

async function executePlan(registry, plan, options) {
  const steps = [];
  const reviewLoopCounts = new Map();
  const simulation = createSimulationArtifacts(plan, options);
  const workflowState = {
    requestedProductKeyword:
      String(options?.productKeyword || "").trim() ||
      extractProductKeywordFromMessage(plan?.message || ""),
    productResearch: null,
    finalContent: "",
    imagePrompt: "",
    videoPrompt: "",
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
      const alignment = assessProductResearchAlignment(
        workflowState.requestedProductKeyword,
        payload?.data?.product_name || "",
      );
      workflowState.productResearch = {
        ...payload,
        alignment,
      };
      const mismatchReply = !alignment.aligned
        ? buildProductResearchMismatchReply({
            requestedKeyword: workflowState.requestedProductKeyword,
            productName: payload?.data?.product_name || "",
            productUrl: payload?.data?.product_url || "",
            alignment,
          })
        : "";
      const summary = [
        `Đã lấy dữ liệu sản phẩm bằng skill search_product_text.`,
        `YÊU_CẦU_GỐC_SẢN_PHẨM: ${workflowState.requestedProductKeyword || "(không rõ)"}`,
        `SẢN_PHẨM_ĐÃ_TÌM_ĐƯỢC: ${payload?.data?.product_name || "(không rõ)"}`,
        `URL: ${payload?.data?.product_url || "(không rõ)"}`,
        `THƯ_MỤC_ẢNH: ${payload?.data?.image_download_dir || "(không rõ)"}`,
        !alignment.aligned ? `TRẠNG_THÁI_KHỚP: KHÔNG_ĐẠT (${alignment.reason})` : "TRẠNG_THÁI_KHỚP: ĐẠT",
      ].join("\n");
      const record = {
        ...step,
        sessionKey: agent.transport?.sessionKey || agent.sessionKey,
        envelope: {
          type: "product_research",
          from: step.from,
          to: step.to,
          keyword: payload.keyword,
          requestedKeyword: workflowState.requestedProductKeyword,
          targetSite: payload.targetSite,
          alignment,
        },
        prompt: "[local] run skills/search_product_text/action.js",
        reply: !alignment.aligned ? mismatchReply : summary,
        productResearch: payload,
      };
      steps.push(record);
      simulation?.setProductResearch(payload);
      simulation?.addStep(index, {
        type: step.type,
        from: step.from,
        to: step.to,
        keyword: payload.keyword,
        requestedKeyword: workflowState.requestedProductKeyword,
        targetSite: payload.targetSite,
        productName: payload?.data?.product_name || null,
        productUrl: payload?.data?.product_url || null,
        aligned: alignment.aligned,
        alignmentReason: alignment.reason,
      });
      if (!alignment.aligned) {
        break;
      }
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
        `YÊU_CẦU_GỐC_SẢN_PHẨM: ${workflowState.requestedProductKeyword || ""}`,
        `TÊN_SẢN_PHẨM: ${research.product_name || ""}`,
        `URL_SẢN_PHẨM: ${research.product_url || ""}`,
        `DANH_MỤC: ${normalizedCategory}`,
        `THÔNG_SỐ: ${research.specifications_text || ""}`,
        `THƯ_MỤC_ẢNH_GỐC: ${research.image_download_dir || ""}`,
      ].join("\n");
      handoffContext = handoffContext
        ? `${handoffContext}\n\nDỮ_LIỆU_SẢN_PHẨM_BẮT_BUỘC:\n${researchSummary}`
        : `DỮ_LIỆU_SẢN_PHẨM_BẮT_BUỘC:\n${researchSummary}`;
    }
    const envelope = buildTaskEnvelope(step, registry, index, plan.steps.length, {
      requestedProductKeyword: workflowState.requestedProductKeyword || null,
      researchedProductName: workflowState.productResearch?.data?.product_name || null,
      productAlignmentStatus:
        workflowState.productResearch?.alignment?.aligned === true
          ? "ĐẠT"
          : workflowState.productResearch?.alignment?.aligned === false
            ? `KHÔNG_ĐẠT:${workflowState.productResearch.alignment.reason}`
            : null,
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

    const stepRecord = {
      type: step.type,
      from: step.from,
      to: step.to,
      sessionKey: agent.transport?.sessionKey || agent.sessionKey,
      replyPreview: compactReply(reply, 1200),
      decision:
        ["content_review", "media_review", "final_review"].includes(step.type)
          ? classifyReviewDecision(reply)
          : null,
    };
    simulation?.addStep(index, stepRecord);

    if (step.type === "content_review" || step.type === "final_review") {
      const candidate = extractBestContent(reply);
      if (candidate) {
        workflowState.finalContent = candidate;
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
      const decision = demoSmoothMode ? "approved" : classifyReviewDecision(reply);
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
  assessProductResearchAlignment,
  buildProductResearchMismatchReply,
  buildOriginalImageMediaReply,
  shouldForceOriginalImageMedia,
  classifyReviewDecision,
  executePlan,
};
