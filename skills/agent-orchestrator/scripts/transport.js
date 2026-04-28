const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");
const { loadOpenClawConfig, resolveGatewayToken } = require("./common");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const UPTEK_API_BASE = process.env.UPTEK_FE_API_URL || "http://localhost:3001/api";

function resolveConversationIdFromSession(sessionKey, agentId) {
  const raw = String(sessionKey || `agent:${agentId}:main`).trim();
  // Loại bỏ prefix agent: hoặc automation: để tạo conversation ID đồng nhất
  const normalized = raw.replace(/^(agent|automation):/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `lane_${normalized}`.slice(0, 180);
}

async function syncToUpTekFE(endpoint, data) {
  try {
    const url = `${UPTEK_API_BASE}${endpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[Sync FE] Failed ${endpoint}:`, err.error || res.statusText);
    }
  } catch (err) {
    console.error(`[Sync FE] Error connecting to ${endpoint}:`, err.message);
  }
}

function resolveSessionKey(agentId, sessionKey, workflowId) {
  const parentKey = String(sessionKey || "").trim();
  const isAutomation = parentKey.startsWith("automation:");
  const prefix = isAutomation ? "automation" : "agent";

  if (parentKey) {
    if (workflowId && /:main$/i.test(parentKey)) {
      const wfSegment = workflowId.startsWith("wf_") ? workflowId : `wf_${workflowId}`;
      return parentKey.replace(/:main$/i, `:${wfSegment}`);
    }
    // Nếu session cha đã có prefix automation, nhưng sub-agent lane chưa có prefix, thì gán prefix đó
    if (isAutomation && !parentKey.includes(`:${agentId}:`)) {
       // Chuẩn hóa Session Key để Gateway phân loại đúng Agent, tránh đẩy vào role 'main'
       return `automation:${agentId}:${workflowId ? (workflowId.startsWith("wf_") ? workflowId : "wf_" + workflowId) : "main"}`;
    }
    return parentKey;
  }

  if (workflowId) {
    return `${prefix}:${agentId}:${workflowId.startsWith("wf_") ? workflowId : "wf_" + workflowId}`;
  }
  return `${prefix}:${agentId}:main`;
}

function resolveSkillHints(step) {
  if (step.type === "product_research") {
    return [
      {
        skill: "search_product_text",
        owner: step.to,
        command: `node ${path.join(REPO_ROOT, "skills", "search_product_text", "action.js").replace(/\\/g, "/")} --keyword "<ten san pham hoac keyword sach>" --target_site "uptek.vn"`,
      },
    ];
  }

  if (step.to === "nv_media" && ["produce", "media_revise"].includes(step.type)) {
    return [
      {
        skill: "gemini_generate_image",
        owner: step.to,
        command: `node ${path.join(REPO_ROOT, "skills", "gemini_generate_image", "action.js").replace(/\\/g, "/")} '{"image_prompt":"...","image_paths":["<anh_goc>"]}'`,
      },
      {
        skill: "generate_video",
        owner: step.to,
        command: `node ${path.join(REPO_ROOT, "skills", "generate_video", "action.js").replace(/\\/g, "/")} '{"video_prompt":"...","image_paths":["<anh_goc>"]}'`,
      },
    ];
  }

  if (step.type === "publish") {
    return [
      {
        skill: "facebook_publish_post",
        owner: step.to,
        command: `node ${path.join(REPO_ROOT, "skills", "facebook_publish_post", "action.js").replace(/\\/g, "/")} '{"caption_long":"...","media_paths":["<asset>"]}'`,
      },
    ];
  }

  return [];
}

function buildTaskEnvelope(step, registry, index, total, context = {}) {
  const source = registry.byId[step.from];
  const target = registry.byId[step.to];
  const workflowId = step.workflow_id || context.workflowId || `wf_${Date.now()}`;
  const stepId = step.step_id || `step_${index + 1}`;
  const action = step.action || step.type || "task.generic";

  return {
    workflowId,
    stepId,
    action,
    taskId: step.task_id || `task_${workflowId}_${stepId}`,
    parentTaskId: step.parent_task_id || null,
    type: step.taskType || step.type || "task.generic",
    from: step.from,
    to: step.to,
    fromAgent: step.from_agent || step.from,
    toAgent: step.to_agent || step.to,
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
    requiresResponse:
      Object.prototype.hasOwnProperty.call(step, "requires_response")
        ? Boolean(step.requires_response)
        : true,
    responseSchema: step.response_schema || null,
    skillHints: Array.isArray(step.skill_hints) ? step.skill_hints : resolveSkillHints(step),
    onApprove: step.on_approve || null,
    onReject: step.on_reject || null,
    maxRetries:
      Number.isInteger(step.max_retries) && step.max_retries > 0 ? step.max_retries : 1,
    rules: [
      "Respect your role and permission boundaries.",
      "Every reply must keep workflow_id and step_id for traceability.",
      "Do not pretend another agent completed work that you did not do yourself.",
      "If your lane uses a skill, call it from your own lane and report the real result.",
      "Respond with sections: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
    ],
  };
}

function buildTaskPrompt(envelope, registry) {
  const shortGoal = String(envelope.goal || "").trim();
  const compactEnvelope = {
    workflow_id: envelope.workflowId,
    step_id: envelope.stepId,
    action: envelope.action,
    from_agent: envelope.fromAgent,
    to_agent: envelope.toAgent,
    step_index: envelope.stepIndex,
    total_steps: envelope.totalSteps,
    requires_response: envelope.requiresResponse,
    response_schema: envelope.responseSchema,
    skill_hints: envelope.skillHints,
    on_approve: envelope.onApprove,
    on_reject: envelope.onReject,
    max_retries: envelope.maxRetries,
  };

  function truncateText(text, limit = 3200) {
    const raw = String(text || "").trim();
    if (!raw) {
      return "";
    }
    if (raw.length <= limit) {
      return raw;
    }
    return `${raw.slice(0, limit)}\n...[rut gon]`;
  }

  const lines = [
    `Ban dang xu ly buoc ${envelope.stepIndex}/${envelope.totalSteps} cua workflow.`,
    `Nguoi giao: ${envelope.sourceLabel || envelope.from}. Nguoi nhan: ${envelope.targetLabel || envelope.to}.`,
    `Cong viec can lam: ${shortGoal}`,
    "",
    "Thong tin truy vet:",
    `- workflow_id: ${envelope.workflowId}`,
    `- step_id: ${envelope.stepId}`,
    `- action: ${envelope.action}`,
    `- loai_buoc: ${envelope.type}`,
    `- so_lan_thu_toi_da: ${envelope.maxRetries}`,
  ];

  if (envelope.requiresReviewBy) {
    lines.push(`- Can review boi: ${envelope.requiresReviewBy}`);
  }
  if (envelope.reportsTo) {
    lines.push(`- Cap tren truc tiep: ${envelope.reportsTo}`);
  }

  lines.push("", "Canh tay xu ly cho buoc nay:");
  if (envelope.type === "propose") {
    lines.push("- Day la buoc lap ke hoach de xin duyet, chua duoc trien khai san xuat.");
  } else if (envelope.type === "plan_execute") {
    lines.push("- Lap ke hoach thuc thi chi tiet cho doi ngay trong lane cua ban.");
    lines.push("- Khong duoc goi lai bo dieu phoi workflow tu ben trong mot workflow dang chay.");
  } else if (envelope.type === "product_research") {
    lines.push("- Tu lane cua ban, truy cap web va dung skill search_product_text de lay du lieu san pham that.");
    lines.push("- Khong duoc goi wrapper noi bo hay goi lai bo dieu phoi workflow.");
    lines.push("- Bao ro ten san pham, URL, thong so chinh, thu muc anh goc va muc do khop.");
  } else if (envelope.type === "content_revise") {
    lines.push("- Sua content theo review that, giu nguyen workflow_id va step_id trong reply.");
  } else if (envelope.type === "media_revise") {
    lines.push("- Sua media theo review that; neu can goi skill thi goi tu lane cua ban.");
  } else if (envelope.to === "nv_media") {
    lines.push("- CHI tao BOI CANH/NEN (background) bang skill gemini_generate_image trong lane cua ban.");
    lines.push("- TUYET DOI KHONG ve san pham vao prompt. San pham that se duoc ghep tu dong boi he thong.");
    lines.push("- TUYET DOI KHONG dua ten san pham, thuong hieu, hoac bat ky vat the nao vao prompt.");
    lines.push("- Logo TAN PHAT ETEK se duoc he thong TU DONG dong dau, KHONG can ve trong prompt.");
    lines.push("- De khoang trong lon o trung tam (60-70%) de ghep san pham.");
    lines.push('- Prompt tao anh bat buoc viet bang tieng Viet.');
    lines.push("- Tra ve duong dan anh nen that va ghi chu.");
  } else if (envelope.to === "nv_content") {
    lines.push("- Viet content that tu lane cua ban; neu thieu du lieu thi tu research truoc khi viet.");
  } else if (envelope.type === "content_review") {
    lines.push("- Review content that. Phai tra QUYET_DINH: approve hoac reject.");
  } else if (envelope.type === "media_review") {
    lines.push("- Review media that. Phai tra QUYET_DINH: approve hoac reject.");
  } else if (envelope.type === "compile_post") {
    lines.push("- Tu lane cua ban, dong goi content + media da duyet thanh bo publish that.");
    lines.push("- Khong duoc mo phong local pipeline ben ngoai lane nay.");
  } else if (envelope.type === "final_review") {
    lines.push("- Day la final review that cua truong_phong. Phai tra QUYET_DINH: approve hoac reject.");
  } else if (envelope.type === "publish") {
    lines.push("- Day la buoc publish that. Neu du dieu kien thi goi skill publish tu lane cua ban.");
    lines.push("- Tra ve ket qua publish that: post id, media da dang, loi neu co.");
  } else if (envelope.type === "report") {
    lines.push("- Tong hop ket qua workflow va bao cao cho cap tren.");
  }

  if (envelope.deliverToUser) {
    lines.push("- Buoc nay can tong hop ket qua de tra truc tiep nguoi dung.");
  }

  if (Array.isArray(envelope.skillHints) && envelope.skillHints.length > 0) {
    lines.push("", "Skill bat buoc:");
    lines.push("- Chi duoc dung cac skill duoi day cho buoc nay.");
    lines.push("- Khong duoc dung wrapper/script noi bo khac de gia lap ket qua.");
    for (const item of envelope.skillHints) {
      lines.push(`- skill: ${item.skill}`);
      lines.push(`  owner_lane: ${item.owner}`);
      lines.push(`  command_mau: ${item.command}`);
    }
  }

  if (envelope.handoffContext) {
    lines.push("", "Tom tat ban giao tu buoc truoc:", truncateText(envelope.handoffContext, 5000));
  }

  if (Array.isArray(envelope.completedSteps) && envelope.completedSteps.length > 0) {
    lines.push("", "Cac buoc da xong gan day:");
    for (const item of envelope.completedSteps.slice(-5)) {
      lines.push(`- ${item.stepIndex || "?"}. ${item.from} -> ${item.to} [${item.type}]`);
      if (item.summary) {
        lines.push(`  ${truncateText(item.summary, 320)}`);
      }
    }
  }

  lines.push(
    "",
    "Cach phan hoi:",
    "- Reply phai bat dau ngay bang WORKFLOW_META, khong duoc co loi mo dau hay giai thich trung gian.",
    "- Bat buoc giu nguyen workflow_id va step_id.",
    "- Bat buoc co WORKFLOW_META va TRANG_THAI trong reply.",
    "- Neu day la buoc review/final_review, them dong QUYET_DINH: approve hoac reject.",
    "- Neu co goi skill, noi ro ten skill, dau vao chinh, va ket qua that.",
    "- Tra loi tieng Viet voi cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  );

  lines.push("", "Thong tin cau truc tom tat:");
  lines.push(JSON.stringify(compactEnvelope, null, 2));

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

async function callGatewayMethod(options) {
  const gatewayUrl = resolveGatewayUrl(options.openClawHome);
  const gatewayToken = resolveGatewayToken({ openClawHome: options.openClawHome });
  if (!gatewayToken) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN.");
  }
  const { callGateway } = await loadGatewayCallModule();
  return callGateway({
    url: gatewayUrl,
    token: gatewayToken,
    method: options.method,
    params: options.params,
    expectFinal: options.expectFinal !== false,
    timeoutMs:
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 1000 ? options.timeoutMs : 180000,
  });
}

function extractTextFromPayload(item) {
  if (!item) return "";
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  if (typeof item.assistantText === "string" && item.assistantText.trim()) {
    return item.assistantText.trim();
  }
  if (typeof item.message === "string" && item.message.trim()) return item.message.trim();
  if (item.data && typeof item.data.assistant_text === "string" && item.data.assistant_text.trim()) {
    return item.data.assistant_text.trim();
  }
  if (item.data && typeof item.data.assistantText === "string" && item.data.assistantText.trim()) {
    return item.data.assistantText.trim();
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((contentItem) => {
        if (!contentItem) return "";
        if (typeof contentItem.text === "string") return contentItem.text;
        if (typeof contentItem.message === "string") return contentItem.message;
        if (typeof contentItem.content === "string") return contentItem.content;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (item.data && typeof item.data === "string") return item.data;
  return "";
}

function extractTextFromGatewayResult(result) {
  const payloads = Array.isArray(result?.result?.payloads) ? result.result.payloads : [];
  const text = payloads
    .map(extractTextFromPayload)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || result?.summary || "";
}

function correlateByWorkflowIdAndStepId(params) {
  const text = String(params.text || "");
  const workflowRegex = /workflow_id\s*[:=-]\s*([A-Za-z0-9._-]+)/i;
  const stepRegex = /step_id\s*[:=-]\s*([A-Za-z0-9._-]+)/i;
  const workflowMatch = text.match(workflowRegex);
  const stepMatch = text.match(stepRegex);
  const responseWorkflowId = workflowMatch?.[1] || params.workflowId;
  const responseStepId = stepMatch?.[1] || params.stepId;
  const matchedBy =
    workflowMatch?.[1] === params.workflowId && stepMatch?.[1] === params.stepId
      ? "reply_text"
      : "request_context";

  return {
    ok: responseWorkflowId === params.workflowId && responseStepId === params.stepId,
    workflowId: responseWorkflowId,
    stepId: responseStepId,
    matchedBy,
  };
}

function buildProgressMessage(options) {
  const lines = [`${options.title || options.message || "Cap nhat workflow"}`.trim()];
  if (options.message && options.message !== options.title) {
    lines.push(options.message);
  }
  lines.push(
    `Ma workflow: ${options.workflowId} | Buoc: ${options.stepId} | Nhan su: ${options.agentId} | Trang thai: ${options.state}`,
  );
  if (options.detail) {
    lines.push("Chi tiet:");
    lines.push(String(options.detail).trim());
  }
  return lines.join("\n");
}

async function appendSystemEnvelopeToLane(options) {
  return callGatewayMethod({
    openClawHome: options.openClawHome,
    method: "chat.inject",
    params: {
      sessionKey: resolveSessionKey(options.agentId, options.sessionKey),
      message: options.message,
      label: options.label || "workflow-system",
    },
    timeoutMs: options.timeoutMs || 30000,
  });
}

async function appendProgressEventToLane(options) {
  return appendSystemEnvelopeToLane({
    openClawHome: options.openClawHome,
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    label: options.label || "workflow-progress",
    message: buildProgressMessage(options),
    timeoutMs: options.timeoutMs || 30000,
  });
}

async function emitProgressEvent(options) {
  return appendProgressEventToLane(options);
}

async function markStepStarted(options) {
  return appendProgressEventToLane({
    ...options,
    state: "started",
    eventType: options.eventType || "task_received",
  });
}

async function markStepCompleted(options) {
  return appendProgressEventToLane({
    ...options,
    state: "completed",
    eventType: options.eventType || "completed",
  });
}

async function markStepFailed(options) {
  return appendProgressEventToLane({
    ...options,
    state: "failed",
    eventType: options.eventType || "failed",
  });
}

function sendTaskToAgentLane(options) {
  const sessionKey = resolveSessionKey(options.agentId, options.sessionKey, options.workflowId);
  const runId = options.runId || randomUUID();

  // Đồng bộ sang Front-end UpTek: Tạo cuộc hội thoại và đẩy tin nhắn yêu cầu
  void (async () => {
    const convId = resolveConversationIdFromSession(sessionKey, options.agentId);
    // 1. Đảm bảo cuộc hội thoại tồn tại trên FE
    await syncToUpTekFE("/conversations", {
      id: convId,
      title: `[Auto] ${options.agentId} • ${options.workflowId || "Moi"}`,
      agentId: options.agentId,
      sessionKey: sessionKey,
      employeeId: options.agentId, // Gán cho nhân viên sở hữu lane này
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    // 2. Lưu tin nhắn yêu cầu từ người giao (pho_phong)
    await syncToUpTekFE("/messages", {
      messages: [{
        id: `msg_${runId}_req`,
        conversationId: convId,
        role: "manager", // Hiển thị dưới dạng tin nhắn chỉ đạo
        content: options.prompt,
        timestamp: Date.now()
      }]
    });
  })();

  // Đồng bộ sang Backend UI (OpenClaw Dashboard)
  void (async () => {
    try {
      // 1. Inject vào lane của Agent con (worker)
      await callGatewayMethod({
        openClawHome: options.openClawHome,
        method: "chat.inject",
        params: {
          sessionKey,
          message: options.prompt,
          role: "user",
          label: "Manager Task Request"
        }
      });

      // 2. Mirroring: Inject vào lane của Manager (Phó phòng) để đồng bộ lịch sử
      if (options.sessionKey && options.sessionKey !== sessionKey) {
        await callGatewayMethod({
          openClawHome: options.openClawHome,
          method: "chat.inject",
          params: {
            sessionKey: options.sessionKey,
            message: `[Giao việc cho ${options.agentId}]: ${options.prompt}`,
            role: "assistant", // Hiện như phản hồi của manager trong lane của họ
            label: "Workflow Management"
          }
        });
      }
    } catch (err) {
      console.error(`[Sync Backend UI] Failed inject:`, err.message);
    }
  })();

  const timeoutMs = Number(options.timeoutMs || process.env.OPENCLAW_ORCHESTRATOR_TIMEOUT_MS || 180000);
  const pending = callGatewayMethod({
    openClawHome: options.openClawHome,
    method: "agent",
    params: {
      message: options.prompt,
      agentId: options.agentId,
      sessionKey,
      idempotencyKey: runId,
    },
    expectFinal: true,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 10000 ? timeoutMs : 180000,
  });

  return {
    runId,
    agentId: options.agentId,
    sessionKey,
    managerSessionKey: options.sessionKey, // Lưu lại để mirroring phản hồi
    workflowId: options.workflowId,
    stepId: options.stepId,
    pending,
    openClawHome: options.openClawHome
  };
}

async function waitForAgentResponse(task) {
  const result = await task.pending;
  const text = extractTextFromGatewayResult(result);

  // Đồng bộ phản hồi sang Front-end & Backend UI
  void (async () => {
    const convId = resolveConversationIdFromSession(task.sessionKey, task.agentId);
    
    // Front-end UpTek
    await syncToUpTekFE("/messages", {
      messages: [{
        id: `msg_${task.runId}_res`,
        conversationId: convId,
        role: "assistant",
        content: text,
        timestamp: Date.now()
      }]
    });

    // Mirroring Backend UI (Inject phản hồi nhân viên vào lane của Phó phòng)
    try {
      if (task.managerSessionKey && task.managerSessionKey !== task.sessionKey) {
        await callGatewayMethod({
          openClawHome: task.openClawHome,
          method: "chat.inject",
          params: {
            sessionKey: task.managerSessionKey,
            message: `[Phản hồi từ ${task.agentId}]: ${text}`,
            role: "assistant",
            label: "Workflow Result Sync"
          }
        });
      }
    } catch (e) {
      console.error(`[Mirror Result] Failed:`, e.message);
    }
  })();

  const correlation = correlateByWorkflowIdAndStepId({
    workflowId: task.workflowId,
    stepId: task.stepId,
    text,
  });
  return {
    runId: task.runId,
    agentId: task.agentId,
    sessionKey: task.sessionKey,
    text,
    result,
    correlation,
  };
}

async function sendToSession(options) {
  const task = sendTaskToAgentLane({
    agentId: options.agentId,
    openClawHome: options.openClawHome,
    sessionKey: options.sessionKey,
    prompt: options.prompt,
    workflowId: options.envelope?.workflowId,
    stepId: options.envelope?.stepId,
    timeoutMs: options.timeoutMs,
  });
  const response = await waitForAgentResponse(task);
  return response.text;
}

module.exports = {
  appendProgressEventToLane,
  appendSystemEnvelopeToLane,
  buildTaskEnvelope,
  buildTaskPrompt,
  callGatewayMethod,
  correlateByWorkflowIdAndStepId,
  emitProgressEvent,
  extractTextFromGatewayResult,
  markStepCompleted,
  markStepFailed,
  markStepStarted,
  sendTaskToAgentLane,
  sendToSession,
  waitForAgentResponse,
};
