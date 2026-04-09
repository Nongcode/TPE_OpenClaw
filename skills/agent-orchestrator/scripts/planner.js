const { randomUUID } = require("crypto");
const { normalizeText } = require("./common");

function messageMentionsAny(normalized, patterns) {
  const normalizePhrase = (value) =>
    ` ${String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()} `;
  const haystack = normalizePhrase(normalized);
  return patterns.some((pattern) => haystack.includes(normalizePhrase(pattern)));
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
  const asksDetailedPlan = messageMentionsAny(normalized, [
    "lap ke hoach chi tiet",
    "ke hoach chi tiet",
    "len ke hoach chi tiet",
    "xay dung ke hoach chi tiet",
    "plan chi tiet",
  ]);
  const hasApprovedPlan = messageMentionsAny(normalized, [
    "da duyet ke hoach",
    "duoc duyet ke hoach",
    "ke hoach da duoc duyet",
    "duyet ke hoach roi",
    "ke hoach da chot",
    "cho trien khai theo ke hoach da duyet",
    "trien khai theo ke hoach da duyet",
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
      "kem video",
      "tao anh",
      "lam anh",
      "tao video",
      "lam video",
      "goi media",
      "visual key",
    ]);
  const wantsPublish =
    messageMentionsAny(normalized, ["dang bai", "dang facebook", "facebook", "post", "xuat ban"]);

  return {
    forbidsMedia,
    wantsExplicitPublish,
    wantsPlanOnly,
    asksDetailedPlan,
    hasApprovedPlan,
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

function createStep(params) {
  return {
    type: params.type,
    from: params.from,
    to: params.to,
    taskType: params.taskType,
    message: params.message,
    requiresExecutiveApproval: params.requiresExecutiveApproval,
    ...(params.requiresReviewBy ? { requiresReviewBy: params.requiresReviewBy } : {}),
    ...(params.deliverToUser ? { deliverToUser: true } : {}),
    ...(params.requiresPlanApproval ? { requiresPlanApproval: true } : {}),
    ...(params.simulateOnly ? { simulateOnly: true } : {}),
  };
}

function buildResponseSchemaForStep(step) {
  const baseSchema = {
    sections: ["WORKFLOW_META", "TRANG_THAI", "KET_QUA", "RUI_RO", "DE_XUAT_BUOC_TIEP"],
    workflow_meta: ["workflow_id", "step_id", "action"],
  };

  if (["content_review", "media_review", "final_review"].includes(step.type)) {
    return {
      ...baseSchema,
      review_decision: ["approve", "reject"],
    };
  }

  if (step.type === "product_research") {
    return {
      ...baseSchema,
      required_fields: ["product_name", "product_url", "specifications_text", "images"],
    };
  }

  if (step.to === "nv_media" || step.type === "publish") {
    return {
      ...baseSchema,
      required_fields: ["asset_paths", "tool_result"],
    };
  }

  return baseSchema;
}

function getStepLifecyclePolicy(step, steps, index) {
  const nextStep = steps[index + 1];

  if (["content_review", "media_review", "final_review"].includes(step.type)) {
    return {
      requires_response: true,
      response_schema: buildResponseSchemaForStep(step),
      on_approve: nextStep ? `advance:${nextStep.type}` : "complete_workflow",
      on_reject: "request_revision",
      max_retries: 2,
    };
  }

  return {
    requires_response: true,
    response_schema: buildResponseSchemaForStep(step),
    on_approve: nextStep ? `advance:${nextStep.type}` : "complete_workflow",
    on_reject: "fail_workflow",
    max_retries: 1,
  };
}

function attachWorkflowMetadata(plan) {
  const workflowId = plan.workflow_id || `wf_${randomUUID()}`;
  const enrichedSteps = plan.steps.map((step, index, steps) => {
    const lifecycle = getStepLifecyclePolicy(step, steps, index);
    return {
      ...step,
      workflow_id: workflowId,
      step_id: step.step_id || `step_${String(index + 1).padStart(2, "0")}`,
      from_agent: step.from,
      to_agent: step.to,
      action: step.action || step.type,
      ...lifecycle,
    };
  });

  return {
    ...plan,
    workflow_id: workflowId,
    steps: enrichedSteps,
  };
}

function buildDepartmentExecutionSteps(params) {
  const {
    fromAgentId,
    taskType,
    message,
    requiresExecutiveApproval,
    includePlanExecute,
    includeDepartmentFinalReview,
    finalDeliverAgentId,
    wantsMedia,
  } = params;
  const steps = [];

  if (includePlanExecute) {
    steps.push(
      createStep({
        type: "plan_execute",
        from: fromAgentId,
        to: "pho_phong",
        taskType,
        message,
        requiresExecutiveApproval,
      }),
    );
  }

  steps.push(
    createStep({
      type: "product_research",
      from: "pho_phong",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
    }),
    createStep({
      type: "produce",
      from: "pho_phong",
      to: "nv_content",
      taskType,
      message,
      requiresExecutiveApproval,
    }),
    createStep({
      type: "content_review",
      from: "nv_content",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      requiresReviewBy: "pho_phong",
      deliverToUser: !wantsMedia && finalDeliverAgentId === "pho_phong",
    }),
  );

  if (!wantsMedia) {
    if (includeDepartmentFinalReview) {
      steps.push(
        createStep({
          type: "final_review",
          from: "pho_phong",
          to: "truong_phong",
          taskType,
          message,
          requiresExecutiveApproval,
          deliverToUser: finalDeliverAgentId === "truong_phong",
        }),
      );
      if (finalDeliverAgentId === "quan_ly") {
        steps.push(
          createStep({
            type: "report",
            from: "truong_phong",
            to: "quan_ly",
            taskType,
            message,
            requiresExecutiveApproval,
            deliverToUser: true,
          }),
        );
      }
    }
    return steps;
  }

  steps.push(
    createStep({
      type: "produce",
      from: "pho_phong",
      to: "nv_media",
      taskType,
      message,
      requiresExecutiveApproval,
    }),
    createStep({
      type: "media_review",
      from: "nv_media",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      requiresReviewBy: "pho_phong",
    }),
  );

  if (finalDeliverAgentId === "pho_phong") {
    steps.push(
      createStep({
        type: "compile_post",
        from: "pho_phong",
        to: "pho_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        deliverToUser: true,
      }),
    );
    return steps;
  }

  steps.push(
    createStep({
      type: "compile_post",
      from: "pho_phong",
      to: "pho_phong",
      taskType,
      message,
      requiresExecutiveApproval,
    }),
    createStep({
      type: "final_review",
      from: "pho_phong",
      to: "truong_phong",
      taskType,
      message,
      requiresExecutiveApproval,
      deliverToUser: finalDeliverAgentId === "truong_phong",
    }),
  );

  if (finalDeliverAgentId === "quan_ly") {
    steps.push(
      createStep({
        type: "report",
        from: "truong_phong",
        to: "quan_ly",
        taskType,
        message,
        requiresExecutiveApproval,
        deliverToUser: true,
      }),
    );
  }

  return steps;
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
    asksDetailedPlan,
    hasApprovedPlan,
    wantsCampaign,
    wantsContent,
    wantsMedia,
  } = classifyWorkflow(normalized, fromAgentId);

  const steps = [];
  let currentOwner = fromAgentId;
  const userDirectToDeputy = fromAgentId === "pho_phong";
  const isDepartmentManager = fromAgentId === "truong_phong" || fromAgentId === "quan_ly";
  const needsManagedExecution = isDepartmentManager && wantsCampaign;
  const needsPlanApprovalGate =
    needsManagedExecution &&
    ((fromAgentId === "quan_ly" && !hasApprovedPlan) || (fromAgentId === "truong_phong" && asksDetailedPlan && !hasApprovedPlan));
  const canExecuteManagedFlow = needsManagedExecution && !needsPlanApprovalGate;

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

  if (needsPlanApprovalGate) {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: [
        createStep({
          type: "propose",
          from: fromAgentId,
          to: fromAgentId,
          taskType,
          message,
          requiresExecutiveApproval,
          deliverToUser: true,
          requiresPlanApproval: true,
        }),
      ],
    };
  }

  if (canExecuteManagedFlow && fromAgentId === "quan_ly") {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: [
        createStep({
          type: "plan_execute",
          from: "quan_ly",
          to: "truong_phong",
          taskType,
          message,
          requiresExecutiveApproval,
        }),
        ...buildDepartmentExecutionSteps({
          fromAgentId: "truong_phong",
          taskType,
          message,
          requiresExecutiveApproval,
          includePlanExecute: true,
          includeDepartmentFinalReview: true,
          finalDeliverAgentId: "quan_ly",
          wantsMedia,
        }),
      ],
    };
  }

  if (canExecuteManagedFlow && fromAgentId === "truong_phong") {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: buildDepartmentExecutionSteps({
        fromAgentId: "truong_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        includePlanExecute: true,
        includeDepartmentFinalReview: true,
        finalDeliverAgentId: "truong_phong",
        wantsMedia,
      }),
    };
  }

  if (fromAgentId === "pho_phong" && wantsCampaign) {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: buildDepartmentExecutionSteps({
        fromAgentId: "pho_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        includePlanExecute: false,
        includeDepartmentFinalReview: false,
        finalDeliverAgentId: "pho_phong",
        wantsMedia,
      }),
    };
  }

  if (fromAgentId === "nv_content") {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: [
        createStep({
          type: "direct",
          from: "nv_content",
          to: "nv_content",
          taskType,
          message,
          requiresExecutiveApproval,
          deliverToUser: true,
        }),
      ],
    };
  }

  if (fromAgentId === "nv_media") {
    return {
      mode: "hierarchy",
      from: fromAgentId,
      taskType,
      message,
      requiresExecutiveApproval,
      reportBackToOrigin: false,
      steps: [
        createStep({
          type: "direct",
          from: "nv_media",
          to: "nv_media",
          taskType,
          message,
          requiresExecutiveApproval,
          deliverToUser: true,
        }),
      ],
    };
  }

  const handoff = (to, kind) => {
    steps.push(
      createStep({
        type: kind,
        from: currentOwner,
        to,
        taskType,
        message,
        requiresExecutiveApproval,
      }),
    );
    currentOwner = to;
  };

  if (fromAgent.canDelegateTo?.includes("quan_ly")) {
    handoff("quan_ly", "delegate");
  }
  if (wantsPlanOnly && fromAgentId === "truong_phong") {
    steps.push(
      createStep({
        type: "propose",
        from: "truong_phong",
        to: "truong_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        deliverToUser: true,
      }),
    );
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
    steps.push(
      createStep({
        type: "content_review",
        from: "nv_content",
        to: "pho_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        requiresReviewBy: "pho_phong",
        deliverToUser: userDirectToDeputy && !wantsMedia,
      }),
    );
    currentOwner = "pho_phong";
  }
  if (wantsMedia && registry.byId[currentOwner]?.canDelegateTo?.includes("nv_media")) {
    handoff("nv_media", "produce");
    steps.push(
      createStep({
        type: "media_review",
        from: "nv_media",
        to: "pho_phong",
        taskType,
        message,
        requiresExecutiveApproval,
        requiresReviewBy: "pho_phong",
        deliverToUser: userDirectToDeputy,
      }),
    );
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
      ...createStep({
        type: "delegate",
        from: fromAgentId,
        to: best.agent.id,
        taskType,
        message,
        requiresExecutiveApproval,
      }),
      score: best.score,
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
    return attachWorkflowMetadata({
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
    });
  }

  if (mode === "auto") {
    const best = chooseBestAllowedChild(registry, options.from, options.message, options.taskType);
    return attachWorkflowMetadata({
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
    });
  }

  if (mode === "hierarchy") {
    return attachWorkflowMetadata(
      buildHierarchyPlan(registry, options.from, options.message, options.taskType || null),
    );
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

module.exports = {
  createPlan,
};
