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
  const normalizedGoal = String(envelope.goal || "").toLowerCase();
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
  if (envelope.deliverToUser) {
    lines.push("- Sau khi buoc nay dat, ban phai tong hop ket qua va tra thang cho nguoi dung trong chinh khung chat nay.");
  }
  if (envelope.reportsTo) {
    lines.push(`- Cap tren truc tiep cua ban: ${envelope.reportsTo}`);
  }
  lines.push(
    `- Co can phe duyet cap quan ly khong: ${envelope.requiresExecutiveApproval ? "co" : "khong"}`,
  );
  if (!envelope.requiresExecutiveApproval) {
    lines.push(
      "- Viec nam trong tham quyen van hanh thuong ngay cua phong. Truong phong duoc quyen tu duyet va cho trien khai.",
    );
  }
  if (envelope.type === "propose") {
    lines.push(
      "- Day la buoc LAP KE HOACH DE XIN DUYET. Tuyet doi KHONG tu trien khai, KHONG tu viet bai dang hoan chinh, KHONG tu tao media, KHONG tu dang bai.",
    );
  }
  if (envelope.type === "plan") {
    lines.push(
      "- Day la buoc pho phong boc tach ke hoach da duoc truong phong chot thanh dau viec thuc thi cho doi san xuat.",
    );
    lines.push(
      "- Sau khi nhan lenh nay, pho phong phai brief cho nv_content viet bai. Chua duoc giao media truoc khi content da duoc pho phong duyet.",
    );
  }
  if (envelope.type === "plan_execute") {
    lines.push(
      "- Day la buoc pho phong mo pha trien khai theo ke hoach da duoc truong phong va nguoi dung chot. Bat dau tu content, khong duoc nhay thang sang media.",
    );
  }
  if (envelope.type === "content_revise") {
    lines.push(
      "- Day la buoc nhan vien content sua lai noi dung theo nhan xet review. Chua duoc nhay sang media cho den khi content duoc duyet lai.",
    );
  }
  if (envelope.type === "media_revise") {
    lines.push(
      "- Day la buoc nhan vien media sua lai media theo nhan xet review. Chi tap trung sua media bi loi.",
    );
  }
  if (envelope.type === "content_review") {
    lines.push(
      "- Day la buoc duyet noi dung. Neu content chua dat, yeu cau lam lai dung vao phan noi dung, chua chuyen sang media. Neu content da dat, luc do moi duoc brief media.",
    );
    if (envelope.deliverToUser) {
      lines.push(
        "- Day la diem ket thuc workflow cho yeu cau chi can content. Neu content dat, tra truc tiep ban content final cho nguoi dung, khong trinh truong_phong.",
      );
    }
  }
  if (envelope.type === "media_review") {
    lines.push(
      "- Day la buoc duyet media. Chi xac nhan dat khi media khop voi content da duoc duyet.",
    );
    if (envelope.deliverToUser) {
      lines.push(
        "- Day la diem ket thuc workflow cho yeu cau nguoi dung giao truc tiep cho pho_phong. Neu media dat, tra truc tiep goi ket qua gom content va anh cho nguoi dung, khong trinh truong_phong.",
      );
    }
  }
  if (envelope.type === "final_review") {
    lines.push(
      "- Day la buoc truong phong nhan ban hoan chinh tu pho phong de chot noi bo va trinh len nguoi dung. Khong duoc tu dang bai neu nguoi dung chua xac nhan dang.",
    );
  }
  if (envelope.type === "publish") {
    lines.push(
      "- Day la buoc dang bai sau khi nguoi dung da xac nhan ro rang rang duoc phep dang.",
    );
  }
  if (envelope.handoffContext) {
    const handoffHeading =
      envelope.type === "content_review"
          ? "BAN NHAP CONTENT TU BUOC TRUOC:"
          : envelope.type === "media_review"
            ? "BAN NHAP MEDIA TU BUOC TRUOC:"
            : "BAN GIAO TU BUOC TRUOC:";
    lines.push("", handoffHeading, envelope.handoffContext);
  }
  if (Array.isArray(envelope.completedSteps) && envelope.completedSteps.length > 0) {
    lines.push("", "TOM TAT CAC BUOC DA HOAN THANH:");
    for (const item of envelope.completedSteps) {
      lines.push(`- ${item.stepIndex}. ${item.from} -> ${item.to} [${item.type}]`);
      if (item.summary && (envelope.type === "final_review" || !envelope.type.endsWith("_review"))) {
        lines.push(`  ${item.summary}`);
      }
    }
  }

  lines.push(
    "",
    "YEU CAU TRA LOI:",
    "- Lam dung vai tro cua ban.",
    "- Neu can giao tiep cho cap duoi hoac cap tren, neu ro ten agent tiep theo trong phan DE_XUAT_BUOC_TIEP.",
    "- Neu task KHONG can phe duyet cap quan ly, khong de xuat xin duyet len quan_ly chi de cho phe duyet hinh thuc.",
    "- Neu dang o buoc propose, chi tra ban ke hoach de xin duyet va dung lai cho quyet dinh cua cap tren.",
    "- Khong duoc bo qua thu tu: truong phong lap ke hoach va cho nguoi dung duyet -> pho phong brief content -> phe duyet content -> media -> phe duyet media -> truong phong chot noi bo -> cho nguoi dung xac nhan dang bai.",
    "- Truong phong khong duoc tu san xuat noi dung, prompt anh, prompt video, caption, hay bai dang hoan chinh cho dau viec nhieu buoc. Truong phong phai giao xuong pho phong de trien khai.",
    "- Tra loi bang tieng Viet.",
    "- Bat buoc dung 3 muc: KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    "- Chi khi step type la publish va nguoi dung da xac nhan dang bai thi moi duoc xac nhan ket qua dang bai.",
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
