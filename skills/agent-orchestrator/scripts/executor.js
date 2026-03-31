const { buildTaskEnvelope, buildTaskPrompt, sendToSession } = require("./transport");

function compactReply(reply) {
  return String(reply || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

async function executePlan(registry, plan, options) {
  const steps = [];
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
      summary: compactReply(item.reply),
    }));
    const handoffContext =
      steps.length > 0 ? compactReply(steps[steps.length - 1]?.reply) : null;
    const envelope = buildTaskEnvelope(step, registry, index, plan.steps.length, {
      handoffContext,
      completedSteps: priorSteps,
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
  }

  return {
    ...plan,
    executedSteps: steps,
    finalReply: steps[steps.length - 1]?.reply || "",
  };
}

module.exports = {
  executePlan,
};
