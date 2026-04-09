const fs = require("fs");
const path = require("path");
const {
  listDirectories,
  readJsonIfExists,
  resolveOpenClawHome,
  unique,
} = require("./common");

function inferManifest(agentId) {
  const defaults = {
    id: agentId,
    label: agentId,
    role: "agent",
    reportsTo: null,
    canDelegateTo: [],
    capabilities: [],
    taskTypes: [],
    requiresReviewBy: null,
  };

  if (agentId === "quan_ly") {
    return {
      ...defaults,
      label: "Quan ly cap cao",
      role: "executive manager",
      canDelegateTo: ["truong_phong"],
      capabilities: ["strategy", "approval", "delegation"],
    };
  }
  if (agentId === "main") {
    return {
      ...defaults,
      label: "Main coordinator",
      role: "system owner",
      canDelegateTo: ["quan_ly"],
      capabilities: ["oversight", "delegation", "approval"],
    };
  }
  if (agentId === "truong_phong") {
    return {
      ...defaults,
      label: "Truong phong",
      role: "department head",
      reportsTo: "quan_ly",
      canDelegateTo: ["pho_phong", "pho_phong_cskh"],
      capabilities: ["review", "approval", "publish-decision"],
    };
  }
  if (agentId === "pho_phong") {
    return {
      ...defaults,
      label: "Pho phong",
      role: "operations lead",
      reportsTo: "truong_phong",
      canDelegateTo: ["nv_content", "nv_media"],
      requiresReviewBy: "truong_phong",
      capabilities: ["workflow", "coordination", "task-splitting"],
    };
  }
  if (agentId === "pho_phong_cskh") {
    return {
      ...defaults,
      label: "Pho phong cham soc khach hang",
      role: "customer care lead",
      reportsTo: "truong_phong",
      canDelegateTo: ["nv_consultant"],
      requiresReviewBy: "truong_phong",
      capabilities: ["customer-care", "consulting-workflow", "support-coordination", "email-send"],
      taskTypes: ["consultant.review", "consultant.execute", "customer.email", "email.send"],
    };
  }
  if (agentId === "nv_content") {
    return {
      ...defaults,
      label: "Nhan vien content",
      role: "content specialist",
      reportsTo: "pho_phong",
      requiresReviewBy: "pho_phong",
      capabilities: ["write", "content", "copywriting", "facebook-post"],
      taskTypes: ["content.write"],
    };
  }
  if (agentId === "nv_media") {
    return {
      ...defaults,
      label: "Nhan vien media",
      role: "media specialist",
      reportsTo: "pho_phong",
      requiresReviewBy: "pho_phong",
      capabilities: ["image", "visual", "design", "creative"],
      taskTypes: ["media.create"],
    };
  }
  if (agentId === "nv_consultant") {
    return {
      ...defaults,
      label: "Nhan vien tu van khach hang",
      role: "customer support specialist",
      reportsTo: "pho_phong_cskh",
      requiresReviewBy: "pho_phong_cskh",
      capabilities: ["customer-support", "chat-reply", "product-consulting", "sales-closing"],
      taskTypes: ["consultant.reply", "consultant.research", "consultant.email_draft"],
    };
  }

  return defaults;
}

function loadManifest(agentId, manifestDir) {
  const manifestPath = path.join(manifestDir, `${agentId}.json`);
  return readJsonIfExists(manifestPath, inferManifest(agentId));
}

function deriveWorkspaceDir(openClawHome, agentId, mainSession) {
  const metadataWorkspace = mainSession?.systemPromptReport?.workspaceDir;
  if (metadataWorkspace) {
    return metadataWorkspace;
  }
  const withoutUnderscores = agentId.replace(/_/g, "");
  const withoutPrefix = agentId.replace(/^[^_]+_/, "");
  const fallbackNames = [
    path.join(openClawHome, `workspace_${withoutPrefix}`),
    path.join(openClawHome, `workspace_${agentId.replace(/_/g, "")}`),
    path.join(openClawHome, `workspace-${agentId}`),
    path.join(openClawHome, `workspace_${agentId}`),
    path.join(openClawHome, `workspace_${withoutUnderscores}`),
    path.join(openClawHome, "workspace"),
  ];
  return fallbackNames.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadAgentRuntime(openClawHome, agentId) {
  const agentBaseDir = path.join(openClawHome, "agents", agentId);
  const sessionsFile = path.join(agentBaseDir, "sessions", "sessions.json");
  const sessions = readJsonIfExists(sessionsFile, {});
  const preferredSessionKey = `agent:${agentId}:main`;
  const mainSession =
    sessions[preferredSessionKey] ||
    Object.entries(sessions).find(([sessionKey]) => sessionKey.startsWith(`agent:${agentId}:`))?.[1] ||
    null;

  return {
    id: agentId,
    agentBaseDir,
    agentDir: path.join(agentBaseDir, "agent"),
    sessionsDir: path.join(agentBaseDir, "sessions"),
    sessionKey: mainSession?.systemPromptReport?.sessionKey || preferredSessionKey,
    sessionFile: mainSession?.sessionFile || null,
    workspaceDir: deriveWorkspaceDir(openClawHome, agentId, mainSession),
    model: mainSession?.model || null,
    provider: mainSession?.modelProvider || null,
    runtimeMetadata: mainSession || null,
  };
}

function discoverRegistry(options = {}) {
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const manifestDir =
    options.manifestDir || path.join(__dirname, "..", "manifests");
  // Prefer union of runtime agent folders and manifest-declared agents so
  // plans referencing manifest-only agents are resolved.
  const runtimeAgentIds = listDirectories(path.join(openClawHome, "agents"));
  let manifestAgentIds = [];
  try {
    manifestAgentIds = fs
      .readdirSync(manifestDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/i, ""));
  } catch {
    manifestAgentIds = [];
  }
  const agentIds = unique([...(runtimeAgentIds || []), ...(manifestAgentIds || [])]);

  const agents = agentIds.map((agentId) => {
    const runtime = loadAgentRuntime(openClawHome, agentId);
    const manifest = loadManifest(agentId, manifestDir);
    return {
      ...runtime,
      ...manifest,
      transport: {
        type: "openclaw-session",
        sessionKey: manifest.transport?.sessionKey || runtime.sessionKey,
      },
    };
  });

  return {
    openClawHome,
    manifestDir,
    agents,
    byId: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
  };
}

module.exports = {
  discoverRegistry,
};
