const { normalizeText } = require("./common");
const {
  buildPublishTextFromSections,
  extractContentSections,
  stripMarkdownFormatting,
} = require("./content_cleanup");
const { toRepoRelative } = require("./campaign_pipeline");
const transport = require("./transport");

function compactReply(reply, limit = 320) {
  return String(reply || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function extractSection(reply, sectionName) {
  const text = String(reply || "").trim();
  if (!text) {
    return "";
  }
  const pattern = new RegExp(
    `${sectionName}\\s*[:\\n]+([\\s\\S]*?)(?=\\n(?:WORKFLOW_META|TRANG_THAI|KET_QUA|RUI_RO|DE_XUAT_BUOC_TIEP|QUYET_DINH)\\b|$)`,
    "i",
  );
  const directMatch = text.match(pattern);
  if (directMatch?.[1]?.trim()) {
    return directMatch[1].trim();
  }

  const normalizedSection = normalizeText(sectionName);
  const knownHeaders = [
    "WORKFLOW_META",
    "TRANG_THAI",
    "KET_QUA",
    "RUI_RO",
    "DE_XUAT_BUOC_TIEP",
    "QUYET_DINH",
  ].map((item) => normalizeText(item));
  const lines = text.split(/\r?\n/);
  let collecting = false;
  const collected = [];

  for (const line of lines) {
    const normalizedLine = normalizeText(line);
    const matchedHeader = knownHeaders.find(
      (header) => normalizedLine === header || normalizedLine.startsWith(`${header}:`),
    );

    if (!collecting) {
      if (matchedHeader === normalizedSection) {
        collecting = true;
        const suffix = line.replace(/^[^:]+:\s*/, "").trim();
        if (suffix) {
          collected.push(suffix);
        }
      }
      continue;
    }

    if (matchedHeader) {
      break;
    }
    collected.push(line);
  }

  return collected.join("\n").trim();
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
  return compactReply(text, 1600);
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

function extractBestContent(reply) {
  const text = String(reply || "").trim();
  if (!text) {
    return "";
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
  const decisionMatch = normalizeText(text).match(
    /quyet[_\s]dinh\s*[:=-]\s*(approve|approved|pass|reject|rejected|revise)/i,
  );
  if (decisionMatch?.[1]) {
    const explicit = decisionMatch[1];
    if (["approve", "approved", "pass"].includes(explicit)) {
      return "approved";
    }
    if (["reject", "rejected", "revise"].includes(explicit)) {
      return "revise";
    }
  }

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
        message: `Pho phong chua duyet content. Nhan vien content phai sua theo nhan xet sau: ${compactReply(reply, 1200)}`,
      },
      {
        ...step,
        type: "content_review",
        from: "nv_content",
        to: step.to,
        message: `Nhan vien content da sua bai theo nhan xet truoc do. Pho phong hay duyet lai. Nhan xet truoc: ${compactReply(reply, 1200)}`,
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
        message: `Pho phong chua duyet media. Nhan vien media phai sua theo nhan xet sau: ${compactReply(reply, 1200)}`,
      },
      {
        ...step,
        type: "media_review",
        from: "nv_media",
        to: step.to,
        message: `Nhan vien media da sua media theo nhan xet truoc do. Pho phong hay duyet lai. Nhan xet truoc: ${compactReply(reply, 1200)}`,
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
          message: `Truong phong yeu cau sua media theo nhan xet sau: ${compactReply(reply, 1200)}`,
        },
        {
          ...step,
          type: "media_review",
          from: "nv_media",
          to: "pho_phong",
          message: "Nhan vien media da sua media theo nhan xet cua truong phong. Pho phong hay duyet lai.",
        },
        {
          ...step,
          type: "final_review",
          from: "pho_phong",
          to: "truong_phong",
          message: `Pho phong trinh lai bo san pham sau khi media da duoc sua theo nhan xet truoc do. Nhan xet truoc: ${compactReply(reply, 1200)}`,
        },
      ];
    }
    return [
      {
        ...step,
        type: "content_revise",
        from: step.to,
        to: "nv_content",
        message: `Truong phong yeu cau sua content theo nhan xet sau: ${compactReply(reply, 1200)}`,
      },
      {
        ...step,
        type: "content_review",
        from: "nv_content",
        to: "pho_phong",
        message: "Nhan vien content da sua content theo nhan xet cua truong phong. Pho phong hay duyet lai.",
      },
      {
        ...step,
        type: "final_review",
        from: "pho_phong",
        to: "truong_phong",
        message: `Pho phong trinh lai bo san pham sau khi content da duoc sua theo nhan xet truoc do. Nhan xet truoc: ${compactReply(reply, 1200)}`,
      },
    ];
  }

  return [];
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

function shouldForceOriginalImageMedia() {
  return false;
}

function buildOriginalImageMediaReply(step, workflowState) {
  const imagePaths = getOriginalProductImagePaths(workflowState);
  const assetList = formatAssetList(imagePaths);
  if (step.type === "media_review") {
    return [
      "WORKFLOW_META:",
      `- workflow_id: ${workflowState.workflowId || "wf_demo"}`,
      `- step_id: ${workflowState.stepId || "step_demo"}`,
      `- action: media_review`,
      "",
      "TRANG_THAI:",
      "- status: completed",
      "",
      "QUYET_DINH: approve",
      "",
      "KET_QUA:",
      "- DUYET PASS media voi bo anh goc san pham.",
      "- Xac nhan bo anh goc duoc su dung truc tiep lam anh trien khai:",
      assetList,
      `- IMAGE_PROMPT: ${workflowState.imagePrompt || ""}`,
      `- VIDEO_PROMPT: ${workflowState.videoPrompt || ""}`,
      "",
      "RUI_RO:",
      "- Khong co rui ro blocker o buoc media review.",
      "",
      "DE_XUAT_BUOC_TIEP:",
      "- Chuyen compile_post de dong goi ho so trinh truong phong.",
    ].join("\n");
  }

  return [
    "WORKFLOW_META:",
    `- workflow_id: ${workflowState.workflowId || "wf_demo"}`,
    `- step_id: ${workflowState.stepId || "step_demo"}`,
    `- action: ${step.type || "produce"}`,
    "",
    "TRANG_THAI:",
    "- status: completed",
    "",
    "KET_QUA:",
    "- Da xu ly bo anh goc san pham.",
    assetList,
    "",
    "RUI_RO:",
    "- Chat luong anh phu thuoc vao bo anh goc hien co.",
    "",
    "DE_XUAT_BUOC_TIEP:",
    "- Chuyen sang review media.",
  ].join("\n");
}

function buildStepResponseSchema(step) {
  if (step.response_schema) {
    return step.response_schema;
  }
  return {
    sections: ["WORKFLOW_META", "TRANG_THAI", "KET_QUA", "RUI_RO", "DE_XUAT_BUOC_TIEP"],
  };
}

function createDynamicStep(step, workflowId, sequence) {
  const isReviewStep = ["content_review", "media_review", "final_review"].includes(step.type);
  return {
    ...step,
    workflow_id: workflowId,
    step_id: `${step.type}_retry_${String(sequence).padStart(2, "0")}`,
    from_agent: step.from,
    to_agent: step.to,
    action: step.type,
    requires_response: true,
    response_schema: buildStepResponseSchema(step),
    on_approve: step.on_approve || "advance",
    on_reject: step.on_reject || (isReviewStep ? "request_revision" : "fail_workflow"),
    max_retries:
      Number.isInteger(step.max_retries) && step.max_retries > 0
        ? step.max_retries
        : isReviewStep
          ? 2
          : 1,
  };
}

function buildStepAssignmentMessage(envelope) {
  const goal = String(envelope.goal || "").trim();
  return [
    `${envelope.sourceLabel || envelope.from} dang giao viec cho ${envelope.targetLabel || envelope.to}.`,
    `Cong viec hien tai: ${goal || "Chua co mo ta cong viec."}`,
    `Ma workflow: ${envelope.workflowId} | Buoc: ${envelope.stepId} | Hanh dong: ${envelope.action}`,
  ].join("\n");
}

function getStepStartProgress(step) {
  const base = [
    {
      eventType: "task_received",
      title: "Da nhan cong viec",
      message: "Da nhan buoc workflow va bat dau xu ly.",
    },
  ];

  if (step.type === "plan_execute") {
    return [
      ...base,
      {
        eventType: "planning",
        title: "Dang lap ke hoach thuc hien",
        message: "Dang lap ke hoach thuc hien.",
      },
    ];
  }
  if (step.type === "product_research") {
    return [
      ...base,
      {
        eventType: "researching",
        title: "Dang truy cap trang web de lay thong tin san pham",
        message: "Dang truy cap trang web de lay thong tin san pham.",
      },
      {
        eventType: "skill_running",
        title: "Dang dung skill search_product_text de tim du lieu san pham",
        message: "Dang dung skill search_product_text de tim du lieu san pham.",
      },
    ];
  }
  if (step.to === "nv_content" && step.type === "produce") {
    return [
      ...base,
      {
        eventType: "writing_content",
        title: "Dang viet noi dung bai dang",
        message: "Dang viet noi dung bai dang.",
      },
    ];
  }
  if (step.to === "nv_content" && step.type === "content_revise") {
    return [
      ...base,
      {
        eventType: "revising",
        title: "Dang sua noi dung theo review",
        message: "Dang sua noi dung theo review.",
      },
    ];
  }
  if (step.type === "content_review") {
    return [
      ...base,
      {
        eventType: "waiting_review",
        title: "Dang review noi dung",
        message: "Dang review noi dung.",
      },
    ];
  }
  if (step.to === "nv_media" && step.type === "produce") {
    return [
      ...base,
      {
        eventType: "generating_image",
        title: "Dang tao anh",
        message: "Dang tao anh.",
      },
      {
        eventType: "generating_video",
        title: "Dang tao video",
        message: "Dang tao video.",
      },
    ];
  }
  if (step.to === "nv_media" && step.type === "media_revise") {
    return [
      ...base,
      {
        eventType: "revising",
        title: "Dang sua media theo review",
        message: "Dang sua media theo review.",
      },
      {
        eventType: "generating_image",
        title: "Dang tao anh",
        message: "Dang tao lai anh theo review.",
      },
      {
        eventType: "generating_video",
        title: "Dang tao video",
        message: "Dang tao lai video theo review.",
      },
    ];
  }
  if (step.type === "media_review") {
    return [
      ...base,
      {
        eventType: "waiting_review",
        title: "Dang review media",
        message: "Dang review media.",
      },
    ];
  }
  if (step.type === "compile_post") {
    return [
      ...base,
      {
        eventType: "preparing_publish",
        title: "Dang chuan bi noi dung publish",
        message: "Dang chuan bi noi dung publish.",
      },
    ];
  }
  if (step.type === "final_review") {
    return [
      ...base,
      {
        eventType: "waiting_review",
        title: "Dang final review",
        message: "Dang final review.",
      },
    ];
  }
  if (step.type === "publish") {
    return [
      ...base,
      {
        eventType: "publishing",
        title: "Dang dang bai len page",
        message: "Dang dang bai len page.",
      },
    ];
  }

  return [
    ...base,
    {
      eventType: "processing",
      title: "Dang xu ly",
      message: "Dang xu ly buoc workflow.",
    },
  ];
}

function validateAgentReply(step, reply, correlation) {
  const text = String(reply || "").trim();
  const normalized = normalizeText(text);
  const errors = [];
  const requiredSections = ["WORKFLOW_META", "TRANG_THAI", "KET_QUA", "RUI_RO", "DE_XUAT_BUOC_TIEP"];

  const hasSectionHeading = (sourceText, sectionName) => {
    const normalizedSection = normalizeText(sectionName);
    const lines = String(sourceText || "").split(/\r?\n/);
    return lines.some((line) => {
      const normalizedLine = normalizeText(line);
      return (
        normalizedLine === normalizedSection ||
        normalizedLine.startsWith(`${normalizedSection}:`) ||
        normalizedLine.startsWith(`${normalizedSection} `)
      );
    });
  };

  if (!text) {
    errors.push("empty reply");
  }
  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstNonEmptyLine && !["workflow_meta", "workflow_meta:"].includes(normalizeText(firstNonEmptyLine))) {
    errors.push("reply must start directly with WORKFLOW_META");
  }
  for (const section of requiredSections) {
    if (!hasSectionHeading(text, section)) {
      errors.push(`missing section ${section}`);
    }
  }
  if (!correlation?.ok) {
    errors.push(
      `workflow metadata mismatch: expected ${step.workflow_id}/${step.step_id}, got ${correlation?.workflowId || "?"}/${correlation?.stepId || "?"}`,
    );
  }

  const forbiddenInternalWrappers = ["product_research.js", "campaign_pipeline.js"];
  for (const wrapper of forbiddenInternalWrappers) {
    if (normalized.includes(wrapper)) {
      errors.push(`reply references forbidden internal wrapper ${wrapper}`);
    }
  }

  if (["plan_execute", "product_research"].includes(step.type)) {
    const recursiveOrchestratorSignals = [
      "da goi skill agent orchestrator",
      "da goi skill: agent orchestrator",
      "goi lai agent orchestrator",
      "chay agent orchestrator",
      "da chay agent orchestrator",
      "orchestrator tra ve",
      "da goi orchestrator",
      "da chay orchestrator",
      "toi se goi orchestrator",
      "toi dang goi orchestrator",
    ];
    if (recursiveOrchestratorSignals.some((signal) => normalized.includes(signal))) {
      errors.push(`${step.type} must not recursively call agent-orchestrator`);
    }
  }

  if (step.type === "product_research" && !normalized.includes("search_product_text")) {
    errors.push("product_research must use skill search_product_text");
  }

  if (step.to === "nv_media" && ["produce", "media_revise"].includes(step.type)) {
    if (!normalized.includes("gemini_generate_image")) {
      errors.push("media production must use skill gemini_generate_image");
    }
    const mentionsVideoSkill = normalized.includes("generate_video");
    const mentionsVideoQuota =
      normalized.includes("quota_exceeded") ||
      normalized.includes("quota reached") ||
      normalized.includes("gioi han tao video") ||
      normalized.includes("gioi han video") ||
      normalized.includes("da dat den gioi han tao video");
    if (!mentionsVideoSkill && !mentionsVideoQuota) {
      errors.push("media production must use skill generate_video or report a real quota failure");
    }
  }

  if (step.type === "publish" && !normalized.includes("facebook_publish_post")) {
    errors.push("publish must use skill facebook_publish_post");
  }

  let decision = null;
  if (["content_review", "media_review", "final_review"].includes(step.type)) {
    const classified = classifyReviewDecision(text);
    if (classified === "approved") {
      decision = "approved";
    } else if (classified === "revise") {
      decision = "reject";
    } else {
      errors.push("missing explicit review decision");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    decision,
  };
}

async function emitStepStartMarkers(step, agent, sessionKey, envelope, options) {
  await transport.appendSystemEnvelopeToLane({
    openClawHome: options.openClawHome,
    agentId: agent.id,
    sessionKey,
    message: buildStepAssignmentMessage(envelope),
  });

  for (const item of getStepStartProgress(step)) {
    await transport.markStepStarted({
      openClawHome: options.openClawHome,
      agentId: agent.id,
      sessionKey,
      workflowId: envelope.workflowId,
      stepId: envelope.stepId,
      action: envelope.action,
      eventType: item.eventType,
      title: item.title,
      message: item.message,
    });
  }
}

async function emitStepCompletionMarkers(step, agent, sessionKey, envelope, reply, decision, options) {
  await transport.markStepCompleted({
    openClawHome: options.openClawHome,
    agentId: agent.id,
    sessionKey,
    workflowId: envelope.workflowId,
    stepId: envelope.stepId,
    action: envelope.action,
    title: `Da hoan thanh buoc ${envelope.action}`,
    message: `Da hoan thanh buoc ${envelope.action}.`,
    detail: compactReply(reply, 600),
  });

  if (step.to === "nv_content" && ["produce", "content_revise"].includes(step.type)) {
    await transport.emitProgressEvent({
      openClawHome: options.openClawHome,
      agentId: agent.id,
      sessionKey,
      workflowId: envelope.workflowId,
      stepId: envelope.stepId,
      action: envelope.action,
      state: "waiting_review",
      eventType: "waiting_review",
      title: "Dang cho phan hoi review",
      message: "Dang cho pho_phong review noi dung.",
    });
  }

  if (step.to === "nv_media" && ["produce", "media_revise"].includes(step.type)) {
    await transport.emitProgressEvent({
      openClawHome: options.openClawHome,
      agentId: agent.id,
      sessionKey,
      workflowId: envelope.workflowId,
      stepId: envelope.stepId,
      action: envelope.action,
      state: "waiting_review",
      eventType: "waiting_review",
      title: "Dang cho phan hoi review",
      message: "Dang cho pho_phong review media.",
    });
  }

  if (decision === "reject") {
    await transport.emitProgressEvent({
      openClawHome: options.openClawHome,
      agentId: agent.id,
      sessionKey,
      workflowId: envelope.workflowId,
      stepId: envelope.stepId,
      action: envelope.action,
      state: "completed",
      eventType: "revision_requested",
      title: "Buoc review yeu cau sua",
      message: "Buoc review da hoan thanh voi ket qua reject.",
    });
  }
}

function buildCompletedStepsHistory(executedSteps, currentStepType) {
  return executedSteps.map((item, itemIndex) => ({
    stepIndex: item.envelope?.stepIndex ?? itemIndex + 1,
    from: item.from,
    to: item.to,
    type: item.type,
    summary: buildCompletedStepSummary(item.reply, currentStepType),
  }));
}

function findExecutedStep(executedSteps, type) {
  for (let index = executedSteps.length - 1; index >= 0; index -= 1) {
    if (executedSteps[index]?.type === type) {
      return executedSteps[index];
    }
  }
  return null;
}

function extractProductResearchContext(reply) {
  const text = String(reply || "");
  if (!text) {
    return "";
  }

  const lines = [];
  const productName = text.match(/product_name\s*:\s*`?([^\n`]+)`?/i)?.[1]?.trim();
  const productUrl = text.match(/product_url\s*:\s*`?([^\n`]+)`?/i)?.[1]?.trim();
  const sourceUrl = text.match(/source_url\s*:\s*`?([^\n`]+)`?/i)?.[1]?.trim();
  const imageDir = text.match(/image_download_dir\s*:\s*`?([^\n`]+)`?/i)?.[1]?.trim();
  const primaryImage = text.match(/primary_image\s*:\s*`?([^\n`]+)`?/i)?.[1]?.trim();

  if (productName) lines.push(`- TEN_SAN_PHAM: ${productName}`);
  if (productUrl) lines.push(`- PRODUCT_URL: ${productUrl}`);
  if (sourceUrl) lines.push(`- SOURCE_URL: ${sourceUrl}`);
  if (imageDir) lines.push(`- THU_MUC_ANH_GOC: ${imageDir}`);
  if (primaryImage) lines.push(`- ANH_GOC_CHINH: ${primaryImage}`);

  const imagePathMatches = [...text.matchAll(/(?:file_path|asset_paths)\s*:\s*`?([A-Za-z]:[^\n`]+|artifacts\/[^\n`]+)`?/gi)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  if (imagePathMatches.length > 0) {
    lines.push("- DANH_SACH_ANH_THAM_CHIEU:");
    for (const imagePath of imagePathMatches.slice(0, 6)) {
      lines.push(`  - ${imagePath}`);
    }
  }

  return lines.join("\n");
}

function buildStepHandoffContext(step, executedSteps) {
  const previousReply = executedSteps.length > 0 ? executedSteps[executedSteps.length - 1]?.reply : null;
  const segments = [];
  const base = buildHandoffContext(step.type, previousReply);
  if (base) {
    segments.push(base);
  }

  const productResearchStep = findExecutedStep(executedSteps, "product_research");
  if (
    productResearchStep &&
    (step.to === "nv_content" ||
      step.to === "nv_media" ||
      step.type === "compile_post" ||
      step.type === "final_review")
  ) {
    const researchContext = extractProductResearchContext(productResearchStep.reply);
    if (researchContext) {
      segments.push(`DU_LIEU_SAN_PHAM_BAT_BUOC:\n${researchContext}`);
    }
  }

  if (step.to === "nv_media") {
    segments.push(
      [
        "RANG_BUOC_MEDIA_BAT_BUOC:",
        "- Prompt tao anh va prompt tao video phai viet bang tieng Viet.",
        '- Bat buoc dat logo "TÂN PHÁT ETEK" o goc trai ben tren anh.',
        '- Bat buoc dat logo "TÂN PHÁT ETEK" o goc trai ben tren cac canh chinh cua video.',
        "- Phai uu tien dung anh goc/anh tham chieu da research.",
      ].join("\n"),
    );
  }

  return segments.filter(Boolean).join("\n\n");
}

async function executePlan(registry, plan, options) {
  const executedSteps = [];
  const reviewLoopCounts = new Map();
  const workflowId = plan.workflow_id || `wf_${Date.now()}`;
  let dynamicStepSequence = 0;
  const workflowState = {
    workflowId,
    status: "running",
    currentStepId: null,
    steps: [],
  };

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const agent = registry.byId[step.to];
    if (!agent) {
      throw new Error(`Unknown target agent: ${step.to}`);
    }

    const sessionKey = agent.transport?.sessionKey || agent.sessionKey;
    const envelope = transport.buildTaskEnvelope(step, registry, index, plan.steps.length, {
      workflowId,
      handoffContext: buildStepHandoffContext(step, executedSteps),
      completedSteps: buildCompletedStepsHistory(executedSteps, step.type),
    });
    const prompt = transport.buildTaskPrompt(envelope, registry);
    const stepState = {
      stepId: envelope.stepId,
      action: envelope.action,
      from: step.from,
      to: step.to,
      sessionKey,
      status: "queued",
      startedAt: Date.now(),
    };
    workflowState.steps.push(stepState);
    workflowState.currentStepId = envelope.stepId;

    if (options.dryRun) {
      stepState.status = "completed";
      stepState.endedAt = Date.now();
      executedSteps.push({
        ...step,
        sessionKey,
        envelope,
        prompt,
        reply: "[dry-run] Khong goi gateway.",
      });
      continue;
    }

    stepState.status = "started";
    await emitStepStartMarkers(step, agent, sessionKey, envelope, options);

    const pendingTask = transport.sendTaskToAgentLane({
      agentId: agent.id,
      openClawHome: options.openClawHome,
      sessionKey,
      prompt,
      workflowId: envelope.workflowId,
      stepId: envelope.stepId,
      timeoutMs: options.timeoutMs,
    });

    let response;
    try {
      response = await transport.waitForAgentResponse(pendingTask);
    } catch (error) {
      stepState.status = "failed";
      stepState.endedAt = Date.now();
      workflowState.status = "failed";
      await transport.markStepFailed({
        openClawHome: options.openClawHome,
        agentId: agent.id,
        sessionKey,
        workflowId: envelope.workflowId,
        stepId: envelope.stepId,
        action: envelope.action,
        title: `Buoc ${envelope.action} that bai`,
        message: `Buoc ${envelope.action} that bai.`,
        detail: error?.message || String(error),
      });
      throw error;
    }

    const reply = String(response.text || "").trim();
    const validation = validateAgentReply(step, reply, response.correlation);
    if (!validation.ok) {
      stepState.status = "failed";
      stepState.endedAt = Date.now();
      workflowState.status = "failed";
      await transport.markStepFailed({
        openClawHome: options.openClawHome,
        agentId: agent.id,
        sessionKey,
        workflowId: envelope.workflowId,
        stepId: envelope.stepId,
        action: envelope.action,
        title: `Buoc ${envelope.action} that bai`,
        message: `Buoc ${envelope.action} that bai do phan hoi khong hop le.`,
        detail: validation.errors.join("; "),
      });
      throw new Error(
        `Invalid reply for ${step.type} (${envelope.stepId}): ${validation.errors.join("; ")}`,
      );
    }

    await emitStepCompletionMarkers(
      step,
      agent,
      sessionKey,
      envelope,
      reply,
      validation.decision,
      options,
    );

    stepState.status = "completed";
    stepState.endedAt = Date.now();
    stepState.runId = response.runId;
    stepState.replyPreview = compactReply(reply, 1200);
    stepState.decision = validation.decision;

    executedSteps.push({
      ...step,
      sessionKey,
      envelope,
      prompt,
      reply,
      runId: response.runId,
      correlation: response.correlation,
      validation,
    });

    if (["content_review", "media_review", "final_review"].includes(step.type)) {
      const loopCount = reviewLoopCounts.get(step.type) || 0;
      if (validation.decision !== "approved") {
        reviewLoopCounts.set(step.type, loopCount + 1);
        const revisionSteps = buildRevisionLoop(step, reply, loopCount);
        if (revisionSteps.length === 0) {
          workflowState.status = "failed";
          throw new Error(
            `Workflow blocked: step ${step.type} not approved after ${loopCount + 1} review attempts.`,
          );
        }
        const hydratedRevisionSteps = revisionSteps.map((revisionStep) => {
          dynamicStepSequence += 1;
          return createDynamicStep(revisionStep, workflowId, dynamicStepSequence);
        });
        plan.steps.splice(index + 1, 0, ...hydratedRevisionSteps);
      }
    }
  }

  workflowState.status = "completed";
  workflowState.currentStepId = null;

  return {
    ...plan,
    workflowState,
    executedSteps,
    finalReply: executedSteps[executedSteps.length - 1]?.reply || "",
    simulationArtifacts: null,
  };
}

module.exports = {
  extractBestContent,
  buildOriginalImageMediaReply,
  shouldForceOriginalImageMedia,
  classifyReviewDecision,
  executePlan,
};
