const { normalizeText } = require("./common");

function messageMentionsAny(normalized, patterns) {
  return patterns.some((pattern) => normalized.includes(pattern));
}

function classifyApprovalPolicy(message, fromAgentId) {
  const normalized = normalizeText(message);
  const hasExecutiveRisk = messageMentionsAny(normalized, [
    "ngan sach",
    "chi phi",
    "bao gia",
    "gia ban",
    "khuyen mai",
    "uu dai",
    "phap ly",
    "thuong hieu",
    "khung hoang",
    "truyen thong",
    "lien phong",
    "lien phong ban",
    "lien bo phan",
    "chinh sach",
    "dinh huong",
  ]);
  const hasExecutiveApprovalRequest =
    messageMentionsAny(normalized, [
      "phe duyet cap quan ly",
      "xin duyet quan ly",
      "xin duyet sep",
      "xin duyet giam doc",
      "trinh quan ly duyet",
      "trinh sep duyet",
      "trinh giam doc duyet",
      "ban giam doc",
      "giam doc",
      "quan ly cap cao",
    ]) &&
    !messageMentionsAny(normalized, [
      "truong phong duyet",
      "trinh truong phong duyet",
      "ke hoach chi tiet de trinh truong phong duyet",
      "chi trinh lai ban ke hoach chi tiet de truong_phong duyet",
    ]);
  const requiresExecutiveApproval = hasExecutiveRisk || hasExecutiveApprovalRequest;
  const reportBackToOrigin =
    fromAgentId === "main" || fromAgentId === "quan_ly" || requiresExecutiveApproval;

  return {
    normalized,
    requiresExecutiveApproval,
    reportBackToOrigin,
  };
}

function classifyWorkflow(normalized, fromAgentId) {
  const forbidsMedia = messageMentionsAny(normalized, [
    "khong can anh",
    "khong can hinh",
    "khong can hinh anh",
    "khong can media",
    "khong lam media",
    "khong can video",
    "text only",
    "text-only",
    "only text",
    "chi co text",
    "chi gom text",
    "chi can content",
    "chi viet bai",
    "chi can bai viet",
    "khong can visual",
    "khong can banner",
  ]);
  const wantsExplicitPublish =
    fromAgentId === "truong_phong" &&
    messageMentionsAny(normalized, [
      "xac nhan dang bai",
      "xac nhan dang facebook",
      "dang bai di",
      "dang facebook di",
      "cho dang bai",
      "duoc dang bai",
      "duoc dang facebook",
      "hay dang bai",
      "hay dang facebook",
    ]) &&
    !messageMentionsAny(normalized, [
      "viet bai",
      "viet content",
      "bai content",
      "lam bai",
      "tao bai",
      "caption",
      "nghien cuu",
      "brief",
      "quang ba",
      "khong can media",
      "khong lam media",
      "chi gom text",
      "chi co text",
      "chi can content",
    ]);
  const wantsPlanOnly =
    (fromAgentId === "truong_phong" || fromAgentId === "quan_ly") &&
    messageMentionsAny(normalized, [
      "lap ke hoach",
      "ke hoach",
      "chien dich",
      "ban hang",
    ]) &&
    !messageMentionsAny(normalized, [
      "da duyet",
      "duoc duyet",
      "trien khai",
      "thuc hien",
      "viet bai",
      "tao bai",
      "dang facebook",
      "dang bai",
      "san xuat",
    ]);

  const wantsCampaign =
    messageMentionsAny(normalized, ["chien dich", "ke hoach", "ban hang", "trien khai"]) ||
    messageMentionsAny(normalized, ["viet bai", "facebook", "dang bai", "dang facebook"]);
  const wantsContent =
    wantsCampaign ||
    messageMentionsAny(normalized, ["viet", "content", "facebook", "bai", "caption", "copy"]);
  const wantsMedia =
    !forbidsMedia &&
    messageMentionsAny(normalized, [
      "image",
      "anh",
      "hinh",
      "hinh anh",
      "banner",
      "media",
      "video",
      "visual",
      "kem anh",
      "kem hinh",
      "tao anh",
      "lam anh",
      "tao video",
      "lam video",
    ]);
  const wantsPublish =
    messageMentionsAny(normalized, ["dang bai", "dang facebook", "facebook", "post", "xuat ban"]);

  return {
    forbidsMedia,
    wantsExplicitPublish,
    wantsPlanOnly,
    wantsCampaign,
    wantsContent,
    wantsMedia,
    wantsPublish,
  };
}

function scoreAgent(agent, taskText, taskType) {
  const haystack = normalizeText(`${taskType || ""} ${taskText}`);
  let score = 0;

  for (const capability of agent.capabilities || []) {
    if (haystack.includes(normalizeText(capability))) {
      score += 20;
    }
  }

  for (const type of agent.taskTypes || []) {
    if (haystack.includes(normalizeText(type))) {
      score += 25;
    }
  }

  if (agent.role?.includes("manager")) {
    score += 5;
  }

  return score;
}

function chooseBestAllowedChild(registry, fromAgentId, message, taskType) {
  const fromAgent = registry.byId[fromAgentId];
  if (!fromAgent) {
    throw new Error(`Unknown source agent: ${fromAgentId}`);
  }

  const candidateIds =
    fromAgent.canDelegateTo && fromAgent.canDelegateTo.length > 0
      ? fromAgent.canDelegateTo
      : registry.agents.filter((agent) => agent.id !== fromAgentId).map((agent) => agent.id);

  const candidates = candidateIds
    .map((agentId) => registry.byId[agentId])
    .filter(Boolean)
    .map((agent) => ({
      agent,
      score: scoreAgent(agent, message, taskType),
    }))
    .sort((left, right) => right.score - left.score);

  if (candidates.length === 0) {
    throw new Error(`No candidate agents available for ${fromAgentId}`);
  }

  return candidates[0];
}

function buildHierarchyPlan(registry, fromAgentId, message, taskType) {
  const fromAgent = registry.byId[fromAgentId];
  if (!fromAgent) {
    throw new Error(`Unknown source agent: ${fromAgentId}`);
  }

  const { normalized, requiresExecutiveApproval, reportBackToOrigin } = classifyApprovalPolicy(
    message,
    fromAgentId,
  );
  const {
    wantsExplicitPublish,
    wantsPlanOnly,
    wantsCampaign,
    wantsContent,
    wantsMedia,
    wantsPublish,
  } = classifyWorkflow(normalized, fromAgentId);

  const steps = [];
  let currentOwner = fromAgentId;
  const userDirectToDeputy = fromAgentId === "pho_phong";

  if (wantsExplicitPublish) {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin,
      steps: [
        {
          type: "publish",
          from: "truong_phong",
          to: "truong_phong",
          taskType,
          message,
          requiresExecutiveApproval,
        },
      ],
    };
  }

  const handoff = (to, kind) => {
    steps.push({
      type: kind,
      from: currentOwner,
      to,
      taskType,
      message,
      requiresExecutiveApproval,
    });
    currentOwner = to;
  };

  if (fromAgent.canDelegateTo?.includes("quan_ly")) {
    handoff("quan_ly", "delegate");
  }
  if (wantsPlanOnly && fromAgentId === "truong_phong") {
    steps.push({
      type: "propose",
      from: "truong_phong",
      to: "truong_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      deliverToUser: true,
    });
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin,
      steps,
    };
  }
  if (registry.byId[currentOwner]?.canDelegateTo?.includes("truong_phong")) {
    handoff("truong_phong", "delegate");
  }
  if (registry.byId[currentOwner]?.canDelegateTo?.includes("pho_phong")) {
    handoff("pho_phong", wantsCampaign ? "plan_execute" : "delegate");
  }
  if (wantsContent && registry.byId[currentOwner]?.canDelegateTo?.includes("nv_content")) {
    handoff("nv_content", "produce");
    steps.push({
      type: "content_review",
      from: "nv_content",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      requiresReviewBy: "pho_phong",
      deliverToUser: userDirectToDeputy && !wantsMedia,
    });
    currentOwner = "pho_phong";
  }
  if (wantsMedia && registry.byId[currentOwner]?.canDelegateTo?.includes("nv_media")) {
    handoff("nv_media", "produce");
    steps.push({
      type: "media_review",
      from: "nv_media",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      requiresReviewBy: "pho_phong",
      deliverToUser: userDirectToDeputy,
    });
    currentOwner = "pho_phong";
  }
  if (!userDirectToDeputy && registry.byId[currentOwner]?.reportsTo === "truong_phong") {
    handoff("truong_phong", "final_review");
  }
  if (requiresExecutiveApproval && registry.byId[currentOwner]?.reportsTo === "quan_ly") {
    handoff("quan_ly", "approve");
    if (fromAgentId === "main" && currentOwner === "quan_ly") {
      handoff("main", "report");
    }
  } else if (reportBackToOrigin && currentOwner === "truong_phong" && fromAgentId === "quan_ly") {
    handoff("quan_ly", "report");
  } else if (reportBackToOrigin && currentOwner === "quan_ly" && fromAgentId === "main") {
    handoff("main", "report");
  } else if (reportBackToOrigin && currentOwner === "truong_phong" && fromAgentId === "main") {
    handoff("quan_ly", "report");
    handoff("main", "report");
  }

  if (steps.length === 0) {
    const best = chooseBestAllowedChild(registry, fromAgentId, message, taskType);
      steps.push({
        type: "delegate",
        from: fromAgentId,
        to: best.agent.id,
        taskType,
        message,
        score: best.score,
        requiresExecutiveApproval,
      });
  }

  return {
    mode: "hierarchy",
    from: fromAgentId,
    taskType,
    message,
    requiresExecutiveApproval,
    reportBackToOrigin,
    steps,
  };
}

function createPlan(registry, options) {
  const mode = options.mode || "direct";

  if (mode === "direct") {
    return {
      mode,
      from: options.from,
      taskType: options.taskType || null,
      message: options.message,
      steps: [
        {
          type: "direct",
          from: options.from,
          to: options.target,
          taskType: options.taskType || null,
          message: options.message,
        },
      ],
    };
  }

  if (mode === "auto") {
    const best = chooseBestAllowedChild(registry, options.from, options.message, options.taskType);
    return {
      mode,
      from: options.from,
      taskType: options.taskType || null,
      message: options.message,
      selectedByScore: best.score,
      steps: [
        {
          type: "auto",
          from: options.from,
          to: best.agent.id,
          taskType: options.taskType || null,
          message: options.message,
          score: best.score,
        },
      ],
    };
  }

  if (mode === "hierarchy") {
    return buildHierarchyPlan(registry, options.from, options.message, options.taskType || null);
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

module.exports = {
  createPlan,
};
