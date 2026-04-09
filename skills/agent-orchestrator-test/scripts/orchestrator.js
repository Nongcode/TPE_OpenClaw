const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawnSync } = require("child_process");

const {
  normalizeText,
  resolveOpenClawHome,
  loadOpenClawConfig,
} = require("../../agent-orchestrator/scripts/common");
const { discoverRegistry } = require("../../agent-orchestrator/scripts/registry");
const transport = require("../../agent-orchestrator/scripts/transport");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function parseArgs(argv) {
  const options = {
    json: false,
    from: "pho_phong",
    openClawHome: null,
    message: "",
    messageFile: null,
    reset: false,
    timeoutMs: 900000,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--from") {
      options.from = argv[index + 1] || options.from;
      index += 1;
      continue;
    }
    if (token === "--openclaw-home") {
      options.openClawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--message-file") {
      options.messageFile = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--reset") {
      options.reset = true;
      continue;
    }
    if (token === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] || options.timeoutMs);
      index += 1;
      continue;
    }
    positional.push(token);
  }

  options.message = positional.join(" ").trim();
  return options;
}

function loadMessage(options) {
  if (options.messageFile) {
    return fs.readFileSync(options.messageFile, "utf8").replace(/^\uFEFF/, "").trim();
  }
  return String(options.message || "").trim();
}

function getPhoPhongWorkspace(config, openClawHome) {
  const workspace =
    config?.agents?.list?.find((agent) => agent?.id === "pho_phong")?.workspace ||
    path.join(openClawHome, "workspace_phophong");
  return path.resolve(workspace);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function getMediaTimeoutMs(baseTimeoutMs) {
  const numeric = Number(baseTimeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 900000;
  }
  return Math.max(numeric, 900000);
}

function buildPaths(workspaceDir) {
  const baseDir = path.join(workspaceDir, "agent-orchestrator-test");
  const historyDir = path.join(baseDir, "history");
  const currentFile = path.join(baseDir, "current-workflow.json");
  ensureDir(baseDir);
  ensureDir(historyDir);
  return { baseDir, historyDir, currentFile };
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.summary || JSON.stringify(result, null, 2));
}

function buildResult(params) {
  return {
    workflow_id: params.workflowId || null,
    stage: params.stage || null,
    status: params.status || "ok",
    summary: params.summary || "",
    data: params.data || {},
  };
}

function buildReplySections(lines) {
  return lines.filter(Boolean).join("\n");
}

function extractBlock(text, startMarker, endMarker) {
  const source = String(text || "");
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) {
    return "";
  }
  const fromStart = source.slice(startIndex + startMarker.length);
  const endIndex = fromStart.indexOf(endMarker);
  return (endIndex >= 0 ? fromStart.slice(0, endIndex) : fromStart).trim();
}

function extractField(text, label) {
  const match = String(text || "").match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"));
  return match?.[1]?.trim() || "";
}

function extractFirstExistingPath(text, extensions) {
  const source = String(text || "");
  const windowsMatches = source.match(/[A-Za-z]:\\[^\r\n"]+/g) || [];
  const repoMatches = source.match(/artifacts\/[^\r\n"]+/g) || [];
  const candidates = [...windowsMatches, ...repoMatches]
    .map((item) => item.trim().replace(/[`"'.,]+$/g, ""))
    .filter(Boolean);

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (extensions.length > 0 && !extensions.includes(ext)) {
      continue;
    }
    const resolved = candidate.startsWith("artifacts/")
      ? path.join(REPO_ROOT, candidate.replace(/\//g, path.sep))
      : candidate;
    if (fs.existsSync(resolved)) {
      return path.resolve(resolved);
    }
  }
  return "";
}

function buildTaskPrompt(params) {
  const lines = [
    "Ban dang xu ly workflow agent-orchestrator-test.",
    `workflow_id: ${params.workflowId}`,
    `step_id: ${params.stepId}`,
    `action: ${params.action}`,
    "",
    params.instructions.trim(),
  ];

  if (params.context) {
    lines.push("", "NGU_CANH:", params.context.trim());
  }

  lines.push(
    "",
    "BAT BUOC:",
    "- Tra loi 100% tieng Viet.",
    "- Tra loi bat dau ngay bang WORKFLOW_META.",
    "- Giu dung workflow_id va step_id.",
    "- Khong giai thich noi bo.",
    "- Bat buoc co cac muc: WORKFLOW_META, TRANG_THAI, KET_QUA, RUI_RO, DE_XUAT_BUOC_TIEP.",
  );

  return lines.join("\n");
}

function validateCommonReply(reply, workflowId, stepId) {
  const text = String(reply || "").trim();
  if (!text) {
    throw new Error("Agent reply is empty.");
  }
  const requiredTokens = [
    "WORKFLOW_META",
    "TRANG_THAI",
    "KET_QUA",
    "RUI_RO",
    "DE_XUAT_BUOC_TIEP",
    workflowId,
    stepId,
  ];
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      throw new Error(`Agent reply is missing token: ${token}`);
    }
  }
  return text;
}

function buildContentPrompt(workflowId, stepId, brief) {
  return buildTaskPrompt({
    workflowId,
    stepId,
    action: "content_draft",
    instructions: `
Ban la nv_content. Hay tu dung skill search_product_text trong lane cua ban de lay du lieu san pham that, gom thong tin va anh goc, sau do viet 1 bai Facebook nhap de pho_phong dua cho user duyet.

Khong tao media. Khong publish. Khong nho pho_phong research thay ban.

Trong KET_QUA, bat buoc ghi dung cac marker sau:
- PRODUCT_NAME: ...
- PRODUCT_URL: ...
- IMAGE_DOWNLOAD_DIR: ...
- APPROVED_CONTENT_BEGIN / APPROVED_CONTENT_END

Luu y: marker content phai viet chinh xac la:
APPROVED_CONTENT_BEGIN
<noi dung bai dang hoan chinh de publish>
APPROVED_CONTENT_END

Brief user:
${brief}
    `,
  });
}

function parseContentReply(reply) {
  const approvedContent = extractBlock(reply, "APPROVED_CONTENT_BEGIN", "APPROVED_CONTENT_END");
  const productName = extractField(reply, "PRODUCT_NAME");
  const productUrl = extractField(reply, "PRODUCT_URL");
  const imageDir = extractField(reply, "IMAGE_DOWNLOAD_DIR");

  if (!approvedContent) {
    throw new Error("nv_content reply is missing APPROVED_CONTENT block.");
  }

  return {
    approvedContent,
    productName,
    productUrl,
    imageDir,
    reply,
  };
}

function buildMediaPrompt(workflowId, stepId, state) {
  const context = [
    `Brief goc: ${state.original_brief}`,
    state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
    state.content?.productUrl ? `URL san pham: ${state.content.productUrl}` : "",
    state.content?.imageDir ? `Thu muc anh goc: ${state.content.imageDir}` : "",
    "Noi dung da duyet:",
    state.content?.approvedContent || "",
  ]
    .filter(Boolean)
    .join("\n");

  return buildTaskPrompt({
    workflowId,
    stepId,
    action: "media_generate",
    context,
    instructions: `
Ban la nv_media. Hay tu sinh 1 image prompt bang tieng Viet dua tren noi dung da duyet va du lieu san pham, sau do dung skill gemini_generate_image trong lane cua ban de tao dung 1 anh that de dang Facebook.

Khong publish. Khong viet lai content. Khong gia lap asset path.
Bat buoc tao anh quang cao sach, hien dai, tap trung vao san pham chinh.
Bat buoc dat logo "TAN PHAT ETEK" ro rang o goc tren ben trai.
Tuyet doi khong chen caption, slogan, thong so, hoac bat ky doan chu tieng Viet nao len trong anh de tranh loi font.
Neu can hien thi nhan dien thuong hieu, chi dung duy nhat chu Latin khong dau "TAN PHAT ETEK" nhu logo.

Trong KET_QUA, bat buoc ghi dung cac marker sau:
IMAGE_PROMPT_BEGIN
<prompt tieng Viet da dung de tao anh>
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: <duong dan anh that vua tao>
    `,
  });
}

function parseMediaReply(reply) {
  const imagePrompt = extractBlock(reply, "IMAGE_PROMPT_BEGIN", "IMAGE_PROMPT_END");
  const generatedImagePath =
    extractField(reply, "GENERATED_IMAGE_PATH") ||
    extractFirstExistingPath(reply, [".png", ".jpg", ".jpeg", ".webp"]);

  if (!imagePrompt) {
    throw new Error("nv_media reply is missing IMAGE_PROMPT block.");
  }
  if (!generatedImagePath) {
    throw new Error("nv_media reply is missing a generated image path.");
  }

  return {
    imagePrompt,
    generatedImagePath,
    reply,
  };
}

async function runAgentStep(params) {
  const task = transport.sendTaskToAgentLane({
    agentId: params.agentId,
    openClawHome: params.openClawHome,
    sessionKey: params.sessionKey,
    prompt: params.prompt,
    workflowId: params.workflowId,
    stepId: params.stepId,
    timeoutMs: params.timeoutMs,
  });
  const response = await transport.waitForAgentResponse(task);
  return validateCommonReply(response.text, params.workflowId, params.stepId);
}

function parseJsonFromOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function runLocalSkill(skillName, payload) {
  const scriptPath = path.join(REPO_ROOT, "skills", skillName, "action.js");
  const run = spawnSync(process.execPath, [scriptPath, JSON.stringify(payload)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
  });

  if (run.error) {
    throw run.error;
  }

  const parsed = parseJsonFromOutput(run.stdout);
  if (!parsed?.success) {
    throw new Error(parsed?.error?.details || parsed?.message || run.stderr || `${skillName} failed`);
  }

  return parsed;
}

function classifyContentDecision(message) {
  const normalized = normalizeText(message);
  const approveSignals = [
    "duyet content",
    "duyet bai",
    "ok content",
    "ok bai",
    "dong y content",
    "cho lam anh",
    "tao anh",
    "lam anh",
    "duyet noi dung",
  ];
  const rejectSignals = [
    "sua content",
    "viet lai",
    "chua duyet content",
    "bai chua dat",
    "chua duyet bai",
    "sua bai",
  ];

  if (rejectSignals.some((item) => normalized.includes(item))) {
    return "reject";
  }
  if (approveSignals.some((item) => normalized.includes(item))) {
    return "approve";
  }
  return "unknown";
}

function classifyMediaDecision(message) {
  const normalized = normalizeText(message);
  const approveSignals = [
    "duyet media",
    "duyet anh",
    "ok anh",
    "ok media",
    "dang bai",
    "publish",
    "dang len page",
    "dang facebook",
    "duyet hinh",
  ];
  const rejectSignals = [
    "sua anh",
    "lam lai anh",
    "chua duyet media",
    "anh chua dat",
    "media chua dat",
    "chua duyet anh",
  ];

  if (rejectSignals.some((item) => normalized.includes(item))) {
    return "reject";
  }
  if (approveSignals.some((item) => normalized.includes(item))) {
    return "approve";
  }
  return "unknown";
}

function archiveWorkflow(paths, state) {
  if (!state?.workflow_id) {
    return;
  }
  const targetPath = path.join(paths.historyDir, `${state.workflow_id}.json`);
  writeJson(targetPath, state);
  if (fs.existsSync(paths.currentFile)) {
    fs.unlinkSync(paths.currentFile);
  }
}

function saveWorkflow(paths, state) {
  const payload = { ...state, updated_at: nowIso() };
  writeJson(paths.currentFile, payload);
  return payload;
}

async function startNewWorkflow(context) {
  const workflowId = `wf_test_${randomUUID()}`;
  const stepId = "step_01_content";
  const contentReply = await runAgentStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt: buildContentPrompt(workflowId, stepId, context.message),
  });

  const content = parseContentReply(contentReply);
  const state = saveWorkflow(context.paths, {
    workflow_id: workflowId,
    created_at: nowIso(),
    status: "pending",
    stage: "awaiting_content_approval",
    original_brief: context.message,
    content,
    media: null,
    publish: null,
  });

  const summary = [
    "Da tao ban nhap content va dang cho user duyet.",
    content.productName ? `San pham: ${content.productName}` : "",
    "",
    "NOI_DUNG_DE_DUYET:",
    content.approvedContent,
    "",
    "Lenh tiep theo nen dung:",
    '- "Duyet content, tao anh" de chuyen sang media.',
    '- Hoac ghi ro yeu cau sua content neu can chinh.',
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult({
    workflowId,
    stage: state.stage,
    summary,
    data: {
      content,
      next_expected_action: "content_approval",
    },
  });
}

async function reviseContent(context, state) {
  const stepId = "step_01b_content_revise";
  const revisePrompt = buildTaskPrompt({
    workflowId: state.workflow_id,
    stepId,
    action: "content_revise",
    context: `Brief goc: ${state.original_brief}\nNhan xet user: ${context.message}\nNoi dung cu:\n${state.content.approvedContent}`,
    instructions: `
Ban la nv_content. User yeu cau sua lai bai viet. Hay tu dung lai du lieu san pham that neu can, sua bai theo dung nhan xet user, va tra ve lai dung cac marker:
- PRODUCT_NAME: ...
- PRODUCT_URL: ...
- IMAGE_DOWNLOAD_DIR: ...
- APPROVED_CONTENT_BEGIN / APPROVED_CONTENT_END
    `,
  });
  const reply = await runAgentStep({
    agentId: "nv_content",
    sessionKey: context.registry.byId.nv_content.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: context.options.timeoutMs,
    prompt: revisePrompt,
  });
  const content = parseContentReply(reply);
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_content_approval",
    content,
  });

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: [
      "Da sua lai content theo nhan xet user va dang cho duyet lai.",
      "",
      "NOI_DUNG_DE_DUYET:",
      content.approvedContent,
    ].join("\n"),
    data: { content, next_expected_action: "content_approval" },
  });
}

async function generateMedia(context, state) {
  const stepId = "step_02_media";
  const mediaReply = await runAgentStep({
    agentId: "nv_media",
    sessionKey: context.registry.byId.nv_media.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
    prompt: buildMediaPrompt(state.workflow_id, stepId, state),
  });

  const media = parseMediaReply(mediaReply);
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_media_approval",
    media,
  });

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: [
      "Da tao anh media va dang cho user duyet.",
      `Anh da tao: ${media.generatedImagePath}`,
      "",
      "Lenh tiep theo nen dung:",
      '- "Duyet anh va dang bai" de publish.',
      '- Hoac ghi ro yeu cau sua anh neu can chinh.',
    ].join("\n"),
    data: {
      media,
      approved_content: state.content.approvedContent,
      next_expected_action: "media_approval",
    },
  });
}

async function reviseMedia(context, state) {
  const stepId = "step_02b_media_revise";
  const revisePrompt = buildTaskPrompt({
    workflowId: state.workflow_id,
    stepId,
    action: "media_revise",
    context: [
      `Brief goc: ${state.original_brief}`,
      `Nhan xet user: ${context.message}`,
      state.content?.productName ? `Ten san pham: ${state.content.productName}` : "",
      state.content?.imageDir ? `Thu muc anh goc: ${state.content.imageDir}` : "",
      "Noi dung da duyet:",
      state.content?.approvedContent || "",
      state.media?.imagePrompt ? `Prompt cu:\n${state.media.imagePrompt}` : "",
      state.media?.generatedImagePath ? `Anh cu: ${state.media.generatedImagePath}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    instructions: `
Ban la nv_media. User yeu cau sua lai anh. Hay tu sinh lai prompt tieng Viet neu can, dung skill gemini_generate_image de tao lai 1 anh that.
Bat buoc giu logo "TAN PHAT ETEK" ro rang o goc tren ben trai.
Tuyet doi khong chen bat ky chu tieng Viet nao len trong anh.
Tra ve lai dung cac marker:
IMAGE_PROMPT_BEGIN
<prompt moi>
IMAGE_PROMPT_END
GENERATED_IMAGE_PATH: <duong dan anh moi>
    `,
  });
  const reply = await runAgentStep({
    agentId: "nv_media",
    sessionKey: context.registry.byId.nv_media.transport.sessionKey,
    openClawHome: context.openClawHome,
    workflowId: state.workflow_id,
    stepId,
    timeoutMs: getMediaTimeoutMs(context.options.timeoutMs),
    prompt: revisePrompt,
  });
  const media = parseMediaReply(reply);
  const nextState = saveWorkflow(context.paths, {
    ...state,
    stage: "awaiting_media_approval",
    media,
  });

  return buildResult({
    workflowId: state.workflow_id,
    stage: nextState.stage,
    summary: [
      "Da sua lai media theo nhan xet user va dang cho duyet lai.",
      `Anh moi: ${media.generatedImagePath}`,
    ].join("\n"),
    data: { media, next_expected_action: "media_approval" },
  });
}

async function publishApprovedPost(context, state) {
  const publishRun = runLocalSkill("facebook_publish_post", {
    caption_long: state.content.approvedContent,
    media_paths: [state.media.generatedImagePath],
  });
  const publishState = {
    ...state,
    status: "completed",
    stage: "published",
    publish: publishRun,
    updated_at: nowIso(),
  };
  archiveWorkflow(context.paths, publishState);

  const postId = publishRun?.data?.post_id || publishRun?.data?.raw_fb_response?.id || "";
  return buildResult({
    workflowId: state.workflow_id,
    stage: "published",
    summary: [
      "Da publish bai viet len Fanpage.",
      postId ? `Post ID: ${postId}` : "",
      `Anh da dang: ${state.media.generatedImagePath}`,
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      post_id: postId,
      media_path: state.media.generatedImagePath,
      publish_result: publishRun,
    },
  });
}

function buildBlockedResult(state, message) {
  const stageLabel =
    state?.stage === "awaiting_content_approval"
      ? "dang cho duyet content"
      : state?.stage === "awaiting_media_approval"
        ? "dang cho duyet media"
        : "dang cho xu ly";
  return buildResult({
    workflowId: state?.workflow_id || null,
    stage: state?.stage || null,
    status: "blocked",
    summary: [
      `Dang co workflow pending ${stageLabel}.`,
      `Tin nhan hien tai chua duoc nhan dien la lenh duyet/sua hop le: ${message}`,
    ].join("\n"),
    data: {
      expected_stage: state?.stage || null,
    },
  });
}

async function continueWorkflow(context, state) {
  if (state.stage === "awaiting_content_approval") {
    const decision = classifyContentDecision(context.message);
    if (decision === "approve") {
      return generateMedia(context, state);
    }
    if (decision === "reject") {
      return reviseContent(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  if (state.stage === "awaiting_media_approval") {
    const decision = classifyMediaDecision(context.message);
    if (decision === "approve") {
      return publishApprovedPost(context, state);
    }
    if (decision === "reject") {
      return reviseMedia(context, state);
    }
    return buildBlockedResult(state, context.message);
  }

  archiveWorkflow(context.paths, state);
  return startNewWorkflow(context);
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const workspaceDir = getPhoPhongWorkspace(config, openClawHome);
  const paths = buildPaths(workspaceDir);

  if (options.reset) {
    if (fs.existsSync(paths.currentFile)) {
      const current = readJsonIfExists(paths.currentFile, {});
      archiveWorkflow(paths, current);
    }
    printResult(
      buildResult({
        status: "reset",
        summary: "Da reset workflow pending cua agent-orchestrator-test.",
      }),
      options.json,
    );
    return;
  }

  const message = loadMessage(options);
  if (!message) {
    throw new Error("Missing task message.");
  }

  const registry = discoverRegistry({ openClawHome });
  if (!registry.byId.pho_phong || !registry.byId.nv_content || !registry.byId.nv_media) {
    throw new Error("Missing required agents pho_phong / nv_content / nv_media in runtime registry.");
  }

  const currentState = readJsonIfExists(paths.currentFile, null);
  const context = {
    message,
    options,
    openClawHome,
    registry,
    paths,
  };

  const result = currentState
    ? await continueWorkflow(context, currentState)
    : await startNewWorkflow(context);

  printResult(result, options.json);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(
      JSON.stringify(
        buildResult({
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
        }),
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

module.exports = {
  classifyContentDecision,
  classifyMediaDecision,
  extractBlock,
  extractField,
  parseContentReply,
  parseMediaReply,
};
