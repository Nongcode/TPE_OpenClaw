const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");
const { loadOpenClawConfig, resolveGatewayToken } = require("./common");

function buildTaskEnvelope(step, registry, index, total, context = {}) {
  const source = registry.byId[step.from];
  const target = registry.byId[step.to];

  return {
    taskId: `task_${Date.now()}_${index + 1}`,
    parentTaskId: null,
    type: step.taskType || step.type || "task.generic",
    from: step.from,
    to: step.to,
    sourceRole: source?.role || step.from,
    targetRole: target?.role || step.to,
    sourceLabel: source?.label || step.from,
    targetLabel: target?.label || step.to,
    stepIndex: index + 1,
    totalSteps: total,
    goal: step.message,
    handoffContext: context.handoffContext || null,
    completedSteps: context.completedSteps || [],
    reportsTo: target?.reportsTo || null,
    requiresReviewBy: target?.requiresReviewBy || null,
    rules: [
      "Respect your role and permission boundaries.",
      "If the task requires escalation, name the next agent explicitly.",
      "Respond with sections: KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    ],
  };
}

function buildTaskPrompt(envelope, registry) {
  const source = registry.byId[envelope.from];
  const target = registry.byId[envelope.to];
  const lines = [
    `[HE THONG DIEU PHOI] Buoc ${envelope.stepIndex}/${envelope.totalSteps}`,
    "",
    `${envelope.sourceLabel || envelope.from} (${envelope.from}) dang giao viec cho ${envelope.targetLabel || envelope.to} (${envelope.to}).`,
    "",
    "NHIEM VU:",
    envelope.goal,
    "",
    "THONG TIN DIEU PHOI:",
    `- Nguoi giao viec: ${envelope.sourceLabel || envelope.from}`,
    `- Vai tro nguoi giao: ${envelope.sourceRole}`,
    `- Nguoi nhan viec: ${envelope.targetLabel || envelope.to}`,
    `- Vai tro nguoi nhan: ${envelope.targetRole}`,
    `- Loai buoc: ${envelope.type}`,
  ];

  if (source?.canDelegateTo?.length) {
    lines.push(`- Nguon co the giao cho: ${source.canDelegateTo.join(", ")}`);
  }
  if (target?.canDelegateTo?.length) {
    lines.push(`- Dich co the giao tiep cho: ${target.canDelegateTo.join(", ")}`);
  }
  if (envelope.requiresReviewBy) {
    lines.push(`- Ket qua can duoc review boi: ${envelope.requiresReviewBy}`);
  }
  if (envelope.reportsTo) {
    lines.push(`- Cap tren truc tiep cua ban: ${envelope.reportsTo}`);
  }
  if (envelope.handoffContext) {
    lines.push("", "BAN GIAO TU BUOC TRUOC:", envelope.handoffContext);
  }
  if (Array.isArray(envelope.completedSteps) && envelope.completedSteps.length > 0) {
    lines.push("", "TOM TAT CAC BUOC DA HOAN THANH:");
    for (const item of envelope.completedSteps) {
      lines.push(`- ${item.stepIndex}. ${item.from} -> ${item.to} [${item.type}]`);
      if (item.summary) {
        lines.push(`  ${item.summary}`);
      }
    }
  }

  lines.push(
    "",
    "YEU CAU TRA LOI:",
    "- Lam dung vai tro cua ban.",
    "- Neu can giao tiep cho cap duoi hoac cap tren, neu ro ten agent tiep theo trong phan DE_XUAT_BUOC_TIEP.",
    "- Tra loi bang tieng Viet.",
    "- Bat buoc dung 3 muc: KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    "- Neu day la buoc publish, hay xac nhan ro ket qua dang bai va trang thai hoan tat.",
    "",
    "TASK_ENVELOPE_JSON:",
    JSON.stringify(envelope, null, 2),
  );

  return lines.join("\n");
}

function resolveRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function resolveGatewayUrl(openClawHome) {
  const config = loadOpenClawConfig(openClawHome);
  const port = Number(config?.gateway?.port) || 18789;
  return process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`;
}

let gatewayCallModulePromise = null;

function resolveGatewayCallModulePath() {
  const repoRoot = resolveRepoRoot();
  const distDir = path.join(repoRoot, "dist");
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => /^call-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, "utf8");
    if (source.includes("export { buildGatewayConnectionDetails, callGateway,")) {
      return candidate;
    }
  }
  throw new Error("Cannot locate built gateway call module in dist/.");
}

async function loadGatewayCallModule() {
  if (!gatewayCallModulePromise) {
    const moduleUrl = pathToFileURL(resolveGatewayCallModulePath()).href;
    gatewayCallModulePromise = import(moduleUrl);
  }
  return gatewayCallModulePromise;
}

async function sendToSession(options) {
  const gatewayUrl = resolveGatewayUrl(options.openClawHome);
  const gatewayToken = resolveGatewayToken({ openClawHome: options.openClawHome });
  if (!gatewayToken) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN.");
  }
  const { callGateway } = await loadGatewayCallModule();
  const result = await callGateway({
    url: gatewayUrl,
    token: gatewayToken,
    method: "agent",
    params: {
      message: options.prompt,
      agentId: options.agentId,
      sessionKey: `agent:${options.agentId}:main`,
      idempotencyKey: randomUUID(),
    },
    expectFinal: true,
    timeoutMs: options.timeoutMs || 300000,
  });
  const payloads = Array.isArray(result?.result?.payloads) ? result.result.payloads : [];
  const text = payloads
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || result?.summary || "";
}

module.exports = {
  buildTaskEnvelope,
  buildTaskPrompt,
  sendToSession,
};
