const { normalizeText } = require("./common");

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

  const normalized = normalizeText(message);
  const wantsContent =
    normalized.includes("viet") ||
    normalized.includes("content") ||
    normalized.includes("facebook") ||
    normalized.includes("bai");
  const wantsMedia =
    normalized.includes("image") ||
    normalized.includes("anh") ||
    normalized.includes("banner") ||
    normalized.includes("media");
  const wantsPublish =
    normalized.includes("dang bai") ||
    normalized.includes("dang facebook") ||
    normalized.includes("facebook") ||
    normalized.includes("post");

  const steps = [];
  let currentOwner = fromAgentId;

  const handoff = (to, kind) => {
    steps.push({
      type: kind,
      from: currentOwner,
      to,
      taskType,
      message,
    });
    currentOwner = to;
  };

  if (fromAgent.canDelegateTo?.includes("quan_ly")) {
    handoff("quan_ly", "delegate");
  }
  if (registry.byId[currentOwner]?.canDelegateTo?.includes("truong_phong")) {
    handoff("truong_phong", "delegate");
  }
  if (registry.byId[currentOwner]?.canDelegateTo?.includes("pho_phong")) {
    handoff("pho_phong", "delegate");
  }
  if (wantsContent && registry.byId[currentOwner]?.canDelegateTo?.includes("nv_content")) {
    handoff("nv_content", "produce");
    handoff("pho_phong", "review");
  }
  if (wantsMedia && registry.byId[currentOwner]?.canDelegateTo?.includes("nv_media")) {
    handoff("nv_media", "produce");
    handoff("pho_phong", "review");
  }
  if (registry.byId[currentOwner]?.reportsTo === "truong_phong") {
    handoff("truong_phong", "review");
  }
  if (wantsPublish && currentOwner === "truong_phong") {
    handoff("truong_phong", "publish");
  }
  if (registry.byId[currentOwner]?.reportsTo === "quan_ly") {
    handoff("quan_ly", wantsPublish ? "report" : "approve");
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
    });
  }

  return {
    mode: "hierarchy",
    from: fromAgentId,
    taskType,
    message,
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
