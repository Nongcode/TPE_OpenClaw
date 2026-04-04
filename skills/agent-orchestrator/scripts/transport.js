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
    requestedProductKeyword: context.requestedProductKeyword || null,
    researchedProductName: context.researchedProductName || null,
    productAlignmentStatus: context.productAlignmentStatus || null,
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
    `[HỆ THỐNG ĐIỀU PHỐI] Bước ${envelope.stepIndex}/${envelope.totalSteps}`,
    "",
    `${envelope.sourceLabel || envelope.from} (${envelope.from}) đang giao việc cho ${envelope.targetLabel || envelope.to} (${envelope.to}).`,
    "",
    "NHIỆM VỤ:",
    envelope.goal,
    "",
    "THÔNG TIN ĐIỀU PHỐI:",
    `- Người giao việc: ${envelope.sourceLabel || envelope.from}`,
    `- Vai trò người giao: ${envelope.sourceRole}`,
    `- Người nhận việc: ${envelope.targetLabel || envelope.to}`,
    `- Vai trò người nhận: ${envelope.targetRole}`,
    `- Loại bước: ${envelope.type}`,
  ];

  if (source?.canDelegateTo?.length) {
    lines.push(`- Nguồn có thể giao cho: ${source.canDelegateTo.join(", ")}`);
  }
  if (target?.canDelegateTo?.length) {
    lines.push(`- Đích có thể giao tiếp cho: ${target.canDelegateTo.join(", ")}`);
  }
  if (envelope.requiresReviewBy) {
    lines.push(`- Kết quả cần được review bởi: ${envelope.requiresReviewBy}`);
  }
  if (envelope.deliverToUser) {
    lines.push("- Sau khi bước này đạt, bạn phải tổng hợp kết quả và trả thẳng cho người dùng trong chính khung chat này.");
  }
  if (envelope.reportsTo) {
    lines.push(`- Cấp trên trực tiếp của bạn: ${envelope.reportsTo}`);
  }
  lines.push(
    `- Có cần phê duyệt cấp quản lý không: ${envelope.requiresExecutiveApproval ? "có" : "không"}`,
  );
  if (envelope.requestedProductKeyword) {
    lines.push(`- Yêu cầu gốc về sản phẩm: ${envelope.requestedProductKeyword}`);
  }
  if (envelope.researchedProductName) {
    lines.push(`- Sản phẩm đã research: ${envelope.researchedProductName}`);
  }
  if (envelope.productAlignmentStatus) {
    lines.push(`- Trạng thái khớp sản phẩm: ${envelope.productAlignmentStatus}`);
  }
  if (!envelope.requiresExecutiveApproval) {
    lines.push(
      "- Việc nằm trong thẩm quyền vận hành thường ngày của phòng. Trưởng phòng được quyền tự duyệt và cho triển khai.",
    );
  }
  if (envelope.type === "propose") {
    lines.push(
      "- Đây là bước LẬP KẾ HOẠCH ĐỂ XIN DUYỆT. Tuyệt đối KHÔNG tự triển khai, KHÔNG tự viết bài đăng hoàn chỉnh, KHÔNG tự tạo media, KHÔNG tự đăng bài.",
    );
  }
  if (envelope.type === "plan") {
    lines.push(
      "- Đây là bước phó phòng bóc tách kế hoạch đã được trưởng phòng chốt thành đầu việc thực thi cho đội sản xuất.",
    );
    lines.push(
      "- Sau khi nhận lệnh này, phó phòng phải brief cho `nv_content` viết bài. Chưa được giao media trước khi content đã được phó phòng duyệt.",
    );
  }
  if (envelope.type === "plan_execute") {
    lines.push(
      "- Đây là bước mở pha triển khai theo kế hoạch đã được chốt. Bắt đầu từ content, không được nhảy thẳng sang media.",
    );
  }
  if (envelope.type === "product_research") {
    lines.push(
      "- Đây là bước thu thập dữ liệu sản phẩm bắt buộc cho content. Hãy dùng skill `search_product_text` để lấy text đầy đủ và ảnh gốc sản phẩm.",
    );
    lines.push(
      "- Kết quả phải nêu rõ: tên sản phẩm, URL, thông số chính, đường dẫn thư mục ảnh gốc, danh sách ảnh tải về.",
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
      "- Quy dinh bat buoc cho nhan vien media: KHONG su dung skill tao anh. Chi duoc kiem tra anh goc san pham (THU_MUC_ANH_GOC) va ban giao chinh bo anh goc do cho cac buoc tiep theo.",
    );
    lines.push(
      "- Xem anh goc la anh da duoc tao hop le trong workflow nay; khong yeu cau render/artifact moi.",
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
  if (envelope.type === "compile_post") {
    lines.push(
      "- Day la buoc pho phong tong hop content da duyet + media da duyet thanh goi bai viet hoan chinh de trinh truong phong.",
    );
    lines.push(
      "- Bat buoc tra ve: noi dung bai final, prompt tao anh final, prompt tao video final, checklist tai nguyen kem theo.",
    );
  }
  if (envelope.type === "final_review") {
    lines.push(
      "- Day la buoc truong phong nhan ban hoan chinh tu pho phong de chot noi bo va trinh len nguoi dung. Khong duoc tu dang bai neu nguoi dung chua xac nhan dang.",
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
          ? "BẢN NHÁP CONTENT TỪ BƯỚC TRƯỚC:"
          : envelope.type === "media_review"
            ? "BẢN NHÁP MEDIA TỪ BƯỚC TRƯỚC:"
            : "BÀN GIAO TỪ BƯỚC TRƯỚC:";
    lines.push("", handoffHeading, envelope.handoffContext);
  }
  if (Array.isArray(envelope.completedSteps) && envelope.completedSteps.length > 0) {
    lines.push("", "TÓM TẮT CÁC BƯỚC ĐÃ HOÀN THÀNH:");
    for (const item of envelope.completedSteps) {
      lines.push(`- ${item.stepIndex}. ${item.from} -> ${item.to} [${item.type}]`);
      if (item.summary && (envelope.type === "final_review" || !envelope.type.endsWith("_review"))) {
        lines.push(`  ${item.summary}`);
      }
    }
  }

  lines.push(
    "",
    "YÊU CẦU TRẢ LỜI:",
    "- Làm đúng vai trò của bạn.",
    "- Nếu cần giao tiếp cho cấp dưới hoặc cấp trên, nêu rõ tên agent tiếp theo trong phần ĐỀ_XUẤT_BƯỚC_TIẾP.",
    "- Nếu task KHÔNG cần phê duyệt cấp quản lý, không đề xuất xin duyệt lên `quan_ly` chỉ để chờ phê duyệt hình thức.",
    "- Nếu đang ở bước `propose`, chỉ trả bản kế hoạch để xin duyệt và dừng lại chờ quyết định của cấp trên.",
    "- Không được bỏ qua thứ tự: trưởng phòng lập kế hoạch và chờ người dùng duyệt -> phó phòng brief content -> phê duyệt content -> media -> phê duyệt media -> trưởng phòng chốt nội bộ -> chờ người dùng xác nhận đăng bài.",
    "- Trong workflow này, không được đăng Facebook thật. Chỉ mô phỏng và lưu artifact để cho workflow `main` thực thi sau.",
    "- Trưởng phòng không được tự sản xuất nội dung, prompt ảnh, prompt video, caption, hay bài đăng hoàn chỉnh cho đầu việc nhiều bước. Trưởng phòng phải giao xuống phó phòng để triển khai.",
    "- Trả lời bằng tiếng Việt có dấu.",
    "- Bắt buộc dùng 3 mục: KẾT_QUẢ, RỦI_RO, ĐỀ_XUẤT_BƯỚC_TIẾP.",
    "- Chỉ khi `step type` là `publish` và người dùng đã xác nhận đăng bài thì mới được xác nhận kết quả đăng bài.",
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
