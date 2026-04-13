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
    requiresReviewBy:
      Object.prototype.hasOwnProperty.call(step, "requiresReviewBy")
        ? step.requiresReviewBy
        : target?.requiresReviewBy || null,
    deliverToUser: Boolean(step.deliverToUser),
    requiresExecutiveApproval: Boolean(step.requiresExecutiveApproval),
    rules: [
      "Respect your role and permission boundaries.",
      "If the task requires escalation, name the next agent explicitly.",
      "Routine department execution should be approved at the department-head level and must not wait for executive approval unless the task is flagged as exceptional.",
      "Respond with sections: KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    ],
  };
}

function buildTaskPrompt(envelope, registry) {
  const source = registry.byId[envelope.from];
  const target = registry.byId[envelope.to];
  
  const lines = [
    `[HỆ THỐNG ĐIỀU PHỐI] Bước ${envelope.stepIndex}/${envelope.totalSteps}`,
    `Từ: ${envelope.sourceLabel || envelope.from} (${envelope.sourceRole || 'unknown'}) -> Đến: ${envelope.targetLabel || envelope.to} (${envelope.targetRole || 'unknown'})`,
    "",
    "📝 NHIỆM VỤ:",
    envelope.goal,
    ""
  ];

  if (envelope.handoffContext) {
    const handoffHeading =
      envelope.type === "content_review" ? "BẢN NHÁP CONTENT TỪ BƯỚC TRƯỚC:" :
      envelope.type === "media_review" ? "BẢN NHÁP MEDIA TỪ BƯỚC TRƯỚC:" :
      "BÀN GIAO TỪ BƯỚC TRƯỚC:";
    lines.push(handoffHeading, envelope.handoffContext, "");
  }

  lines.push("📌 YÊU CẦU TRẢ LỜI & LUẬT VẬN HÀNH:");
  lines.push("- Bắt buộc dùng tiếng Việt có dấu, đáp ứng đúng chuyên môn.");
  lines.push("- Ghi đúng 3 đề mục: KẾT_QUẢ (giải quyết yêu cầu), RỦI_RO (nếu có), ĐỀ_XUẤT_BƯỚC_TIẾP (chỉ đích danh agent nhận việc tiếp theo).");

  if (envelope.type === "propose") {
    lines.push("- Lên kế hoạch xin ý kiến, tuyệt đối chưa viết bài hay làm media.");
  }
  if (envelope.type === "plan_execute" || envelope.type === "plan") {
    lines.push("- Bóc tách kế hoạch thành việc cho cấp dưới. Phải qua content xong mới gọi media.");
  }
  if (envelope.type === "product_research") {
    lines.push("- Bắt buộc gọi lệnh lấy data chuẩn. Trả ra thông số text & list đường dẫn ảnh gốc.");
  }
  if (envelope.type === "content_revise") {
    lines.push("- Bạn phải sửa nháp content hiện tại ngay theo yêu cầu feedback.");
  }
  if (envelope.type === "media_revise") {
    lines.push("- Bạn phải render lại ảnh/video khác theo yêu cầu sửa.");
  }
  if (envelope.to === "nv_media") {
    lines.push("- Dùng bài content đã chốt và gọi tool render media. Phải gắn ảnh reference nếu có yêu cầu.");
  }
  if (envelope.type === "content_review" || envelope.type === "media_review") {
    lines.push("- Đánh giá đầu ra của cấp dưới. Khen chê công tâm để có cớ cho qua hoặc bắt làm lại.");
  }
  if (envelope.type === "compile_post") {
    lines.push("- Gom gọn content + media lại, kiểm tra thành phẩm bài đăng (Chưa upload FB).");
  }
  if (envelope.type === "publish") {
    lines.push("- Đã được cấp thẻ Publish. Gọi tool đăng Facebook hoặc ghi nhận log.");
  }
  if (envelope.deliverToUser) {
    lines.push("- Hãy dừng lại, đợi Người dùng xác nhận quyết định ở màn hình chat này rồi mới tính tiếp.");
  }

  if (Array.isArray(envelope.completedSteps) && envelope.completedSteps.length > 0) {
    lines.push("", "✅ TÓM TẮT TIẾN ĐỘ:");
    for (const item of envelope.completedSteps) {
      lines.push(`- Bước ${item.stepIndex}: ${item.from} -> ${item.to} [${item.type}]`);
      if (item.summary) lines.push(`  ${item.summary}`);
    }
  }

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
    timeoutMs: options.timeoutMs || 900000,
  });
  const payloads = Array.isArray(result?.result?.payloads) ? result.result.payloads : [];

  function extractTextFromPayload(item) {
    if (!item) return "";
    if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
    if (typeof item.assistantText === "string" && item.assistantText.trim()) return item.assistantText.trim();
    if (typeof item.message === "string" && item.message.trim()) return item.message.trim();
    if (item.data && typeof item.data.assistant_text === "string" && item.data.assistant_text.trim()) return item.data.assistant_text.trim();
    if (item.data && typeof item.data.assistantText === "string" && item.data.assistantText.trim()) return item.data.assistantText.trim();
    if (Array.isArray(item.content)) {
      return item.content
        .map((c) => {
          if (!c) return "";
          if (typeof c.text === "string") return c.text;
          if (typeof c.message === "string") return c.message;
          if (typeof c.content === "string") return c.content;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    if (item.data && typeof item.data === "string") return item.data;
    return "";
  }

  const text = payloads
    .map(extractTextFromPayload)
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
