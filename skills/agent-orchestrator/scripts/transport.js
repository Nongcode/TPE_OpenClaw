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
  if (envelope.type === "customer_data_research") {
    lines.push(
      "- Day la buoc pho_phong_cskh lay du lieu khach hang muc tieu. Bat buoc dung skill db-reader de truy cap database, tim khach hang mua nhieu hang nhat va tong hop email + danh sach san pham da mua.",
    );
    lines.push(
      "- Ket qua phai neu ro: ten khach, email, cac san pham da mua, tong quan mua hang, ly do de xuat gui email cham soc/ban tiep.",
    );
  }
  if (envelope.type === "consultant_produce") {
    lines.push(
      "- Day la buoc nv_consultant soan noi dung email dua tren du lieu khach hang da duoc pho_phong_cskh tong hop.",
    );
    lines.push(
      "- Noi dung phai la BAN NHAP EMAIL de trinh duyet, KHONG duoc tu gui mail o buoc nay.",
    );
    lines.push(
      "- Hay viet day du: SUBJECT, LOI CHAO, NOI DUNG CHINH, CTA, va ghi ro ly do email nay phu hop voi lich su mua hang cua khach.",
    );
  }
  if (envelope.type === "consultant_revise") {
    lines.push(
      "- Day la buoc nv_consultant sua lai ban nhap email/tu van theo nhan xet review. Van chi trinh ban nhap, KHONG duoc tu gui mail.",
    );
  }
  if (envelope.type === "consultant_review") {
    lines.push(
      "- Day la buoc pho_phong_cskh review ban nhap email cua nv_consultant. Neu chua dat thi tra lai nv_consultant sua. Neu dat thi moi duoc trinh truong_phong duyet.",
    );
  }
  if (envelope.type === "product_research") {
    lines.push(
      "- Day la buoc thu thap du lieu san pham bat buoc cho content. Hay su dung skill search_product_text de lay text day du + anh goc san pham.",
    );
    lines.push(
      "- Ket qua phai neu ro: ten san pham, url, thong so chinh, duong dan thu muc anh goc, danh sach anh tai ve.",
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
  if (envelope.to === "nv_media") {
    lines.push(
      "- Quy dinh bat buoc cho nhan vien media: nhan content da duyet + image_prompt + video_prompt, sau do goi skill gemini_generate_image va generate_video de tao media that.",
    );
    lines.push(
      "- Bat buoc dung anh goc san pham trong THU_MUC_ANH_GOC / danh sach anh da research lam anh tham chieu cho ca tao anh va tao video.",
    );
  }
  if (envelope.type === "content_review") {
    lines.push(
      "- Day la buoc duyet noi dung. Neu content chua dat, yeu cau lam lai dung vao phan noi dung, chua chuyen sang media. Neu content da dat, luc do moi duoc brief media.",
    );
    if (envelope.deliverToUser && envelope.approvalGate === "content") {
      lines.push(
        "- Day la diem dung tam thoi de tra ban content ve cho nguoi dung phe duyet. KHONG duoc tu y mo lane media cho den khi nguoi dung xac nhan duyet content.",
      );
    } else if (envelope.deliverToUser) {
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
  if (envelope.type === "compile_post") {
    lines.push(
      "- Day la buoc pho phong tong hop content da duyet + media da duyet thanh ho so san sang dang.",
    );
    if (envelope.approvalGate === "media") {
      lines.push(
        "- Day la diem dung tam thoi de tra goi media da chot ve cho nguoi dung phe duyet. KHONG dang Facebook o buoc nay; phai cho nguoi dung xac nhan media dat truoc khi goi auto-content.",
      );
    } else {
      lines.push(
        "- KHONG dang Facebook o buoc nay. Ket qua phai neu ro media da chot, caption tom tat, prompt da chot va trang thai san sang de truong_phong final_review.",
      );
    }
  }
  if (envelope.type === "final_review") {
    lines.push(
      "- Day la buoc truong phong review goi bai viet cuoi cung truoc khi he thong goi facebook_publish_post.",
    );
    lines.push(
      "- Neu truong_phong duyet PASS, he thong se dang bai that sau buoc nay: uu tien 1 bai image, va 1 bai video neu video da tao thanh cong; neu video bi quota thi chi dang image.",
    );
    if (envelope.from === "pho_phong_cskh") {
      lines.push(
        "- Day la buoc truong_phong duyet NOI DUNG EMAIL/TU VAN. Neu duyet PASS thi chi moi mo buoc email_send; KHONG duoc tu gui mail o buoc nay.",
      );
    }
  }
  if (envelope.type === "email_send") {
    lines.push(
      "- Day la buoc pho_phong_cskh gui email that sau khi truong_phong da duyet noi dung.",
    );
    lines.push(
      "- Bat buoc dung skill auto-email de gui mail. Khong duoc tuyen bo da gui neu chua co ket qua terminal thanh cong.",
    );
    lines.push(
      "- Ket qua phai neu ro: email da gui cho ai, tieu de mail, trang thai gui, va bang chung thanh cong/that bai.",
    );
  }
  if (envelope.type === "publish") {
    lines.push(
      "- Day la buoc mo phong dang bai sau khi nguoi dung da xac nhan ro rang rang duoc phep dang.",
    );
    lines.push(
      "- KHONG dang that. Chi tao bao cao mo phong dang bai va luu thong tin can post de he thong main xu ly sau.",
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
    "- Khong duoc bo qua thu tu: truong phong lap ke hoach va cho nguoi dung duyet -> pho phong brief content -> phe duyet content -> media -> phe duyet media -> pho phong dong goi ho so dang -> truong phong final_review -> he thong moi dang Facebook that.",
    "- Truong phong khong duoc tu san xuat noi dung, prompt anh, prompt video, caption, hay bai dang hoan chinh cho dau viec nhieu buoc. Truong phong phai giao xuong pho phong de trien khai.",
    "- Tra loi bang tieng Viet.",
    "- Bat buoc dung 3 muc: KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    "- Khi step type la compile_post, ket qua phai phan anh trang thai san sang dang, KHONG duoc bao la da publish.",
    "",
    "TASK_ENVELOPE_JSON:",
    JSON.stringify(envelope, null, 2),
  );

  return lines.join("\n");
}

function resolveRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function resolveGatewayRuntimeHome() {
  return path.join(resolveRepoRoot(), "artifacts", "agent-orchestrator", "gateway-runtime");
}

async function withGatewayRuntimeHome(fn) {
  const runtimeHome = resolveGatewayRuntimeHome();
  const runtimeStateDir = path.join(runtimeHome, ".openclaw");
  fs.mkdirSync(runtimeStateDir, { recursive: true });
  const previousHome = process.env.OPENCLAW_HOME;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = runtimeHome;
  process.env.OPENCLAW_STATE_DIR = runtimeStateDir;
  try {
    return await fn(runtimeHome, runtimeStateDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousHome;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  }
}

function resolveGatewayUrl(openClawHome) {
  const config = loadOpenClawConfig(openClawHome);
  const remoteUrl = config?.gateway?.mode === "remote" ? config?.gateway?.remote?.url : null;
  if (typeof remoteUrl === "string" && remoteUrl.trim()) {
    return remoteUrl.trim();
  }
  const port = Number(config?.gateway?.port) || 18789;
  const protocol = config?.gateway?.tls?.enabled === true ? "wss" : "ws";
  return process.env.OPENCLAW_GATEWAY_URL || `${protocol}://127.0.0.1:${port}`;
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

function ensureGatewayAvailable(openClawHome) {
  const token = resolveGatewayToken({ openClawHome });
  if (!token) {
    throw new Error(
      "Missing OPENCLAW_GATEWAY_TOKEN. Set env OPENCLAW_GATEWAY_TOKEN or gateway.auth.token in openclaw.json",
    );
  }
  try {
    // This will throw if the built module is not present or not matching.
    resolveGatewayCallModulePath();
  } catch (err) {
    throw new Error(
      `Gateway call module missing or invalid in dist/. Run 'pnpm build' at repository root. Underlying: ${err?.message || err}`,
    );
  }
}

async function loadGatewayCallModule() {
  if (!gatewayCallModulePromise) {
    const moduleUrl = pathToFileURL(resolveGatewayCallModulePath()).href;
    gatewayCallModulePromise = import(moduleUrl);
  }
  return gatewayCallModulePromise;
}

function buildGatewayAgentRequest(options) {
  const timeoutMs = options.timeoutMs || 900000;
  const configPath = path.join(options.openClawHome || "", "openclaw.json");
  return {
    url: resolveGatewayUrl(options.openClawHome),
    token: resolveGatewayToken({ openClawHome: options.openClawHome }),
    config: loadOpenClawConfig(options.openClawHome),
    configPath,
    method: "agent",
    params: {
      message: options.prompt,
      agentId: options.agentId,
      sessionKey: options.sessionKey || `agent:${options.agentId}:main`,
      timeout: Math.max(10, Math.ceil(timeoutMs / 1000)),
      idempotencyKey: randomUUID(),
    },
    expectFinal: true,
    timeoutMs,
  };
}

async function sendToSession(options) {
  const request = buildGatewayAgentRequest(options);
  if (!request.token) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN.");
  }
  options.onProgress?.({
    phase: "gateway-send",
    agentId: options.agentId,
    sessionKey: request.params.sessionKey,
    message: `Dang gui yeu cau toi ${options.agentId} (${request.params.sessionKey}).`,
  });
  const heartbeatMs =
    Number.isFinite(Number(options.heartbeatMs)) && Number(options.heartbeatMs) >= 5000
      ? Number(options.heartbeatMs)
      : 15000;
  const softTimeoutSec =
    Number.isFinite(Number(options.softTimeoutSec)) && Number(options.softTimeoutSec) >= 10
      ? Number(options.softTimeoutSec)
      : 45;
  const startedAt = Date.now();
  let heartbeat = null;
  let slowWarningSent = false;
  try {
    heartbeat = setInterval(() => {
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (!slowWarningSent && elapsedSec >= softTimeoutSec) {
        slowWarningSent = true;
        options.onProgress?.({
          phase: "gateway-slow",
          agentId: options.agentId,
          sessionKey: request.params.sessionKey,
          elapsedSec,
          softTimeoutSec,
          message: `Canh bao: ${options.agentId} da cham hon nguong mem ${softTimeoutSec}s (${elapsedSec}s).`,
        });
      }
      options.onProgress?.({
        phase: "gateway-wait",
        agentId: options.agentId,
        sessionKey: request.params.sessionKey,
        elapsedSec,
        message: `Van dang cho ${options.agentId} phan hoi (${elapsedSec}s).`,
      });
    }, heartbeatMs);
    const result = await withGatewayRuntimeHome(async () => {
      const { callGateway } = await loadGatewayCallModule();
      return await callGateway(request);
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

    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    options.onProgress?.({
      phase: "gateway-done",
      agentId: options.agentId,
      sessionKey: request.params.sessionKey,
      elapsedSec,
      message: `${options.agentId} da tra loi sau ${elapsedSec}s.`,
    });

    return text || result?.summary || "";
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

module.exports = {
  buildTaskEnvelope,
  buildTaskPrompt,
  buildGatewayAgentRequest,
  sendToSession,
  ensureGatewayAvailable,
  resolveGatewayUrl,
  withGatewayRuntimeHome,
};
