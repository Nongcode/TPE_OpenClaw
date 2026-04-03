const { normalizeText } = require("./common");
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

function messageMentionsAny(normalized, patterns) {
  return patterns.some((pattern) => normalized.includes(pattern));
}

function classifyReviewDecision(reply) {
  const text = String(reply || "");
  const resultSection = extractSection(text, "KET_QUA");
  const nextStepSection = extractSection(text, "DE_XUAT_BUOC_TIEP");
  const normalizedResult = normalizeText(resultSection);
  const normalizedNextStep = normalizeText(nextStepSection);
  const normalized = normalizeText(text);
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
    "chua duyet",
    "chua dat",
    "chua ok",
    "chua on",
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

  if (messageMentionsAny(normalizedResult, approvalSignals)) {
    return "approved";
  }
  if (
    messageMentionsAny(normalizedResult, revisionSignals) ||
    messageMentionsAny(normalizedNextStep, revisionSignals)
  ) {
    return "revise";
  }
  if (messageMentionsAny(normalized, approvalSignals)) {
    return "approved";
  }
  if (messageMentionsAny(normalized, revisionSignals)) {
    return "revise";
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

async function executePlan(registry, plan, options) {
  const steps = [];
  const reviewLoopCounts = new Map();
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const agent = registry.byId[step.to];
    if (!agent) {
      throw new Error(`Unknown target agent: ${step.to}`);
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
    const handoffContext = buildHandoffContext(step.type, previousReply);
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

    const reply = await sendToSession({
      agentId: agent.id,
      openClawHome: options.openClawHome,
      sessionKey: agent.transport?.sessionKey || agent.sessionKey,
      envelope,
      prompt,
    });

    steps.push({
      ...step,
      sessionKey: agent.transport?.sessionKey || agent.sessionKey,
      envelope,
      prompt,
      reply,
    });

    if (["content_review", "media_review", "final_review"].includes(step.type)) {
      const loopCount = reviewLoopCounts.get(step.type) || 0;
      const decision = classifyReviewDecision(reply);
      if (decision === "revise") {
        reviewLoopCounts.set(step.type, loopCount + 1);
        const revisionSteps = buildRevisionLoop(step, reply, loopCount);
        if (revisionSteps.length > 0) {
          plan.steps.splice(index + 1, 0, ...revisionSteps);
        }
      }
    }
  }

  return {
    ...plan,
    executedSteps: steps,
    finalReply: steps[steps.length - 1]?.reply || "",
  };
}

module.exports = {
  classifyReviewDecision,
  executePlan,
};
