const fs = require("fs");
const path = require("path");
const { loadOpenClawConfig, resolveOpenClawHome } = require("./common");

const PROMPT_FILE_BY_AGENT = {
  quan_ly: "quan_ly.SOUL.md",
  truong_phong: "truong_phong.SOUL.md",
  pho_phong: "pho_phong.SOUL.md",
  nv_content: "nv_content.SOUL.md",
  nv_media: "nv_media.SOUL.md",
};

function resolveWorkspaceByAgent(config, agentId, openClawHome) {
  const configured = config?.agents?.list?.find((agent) => agent?.id === agentId)?.workspace;
  if (typeof configured === "string" && configured.trim()) {
    return configured;
  }
  const fallbacks = {
    quan_ly: path.join(openClawHome, "workspace_quanly"),
    truong_phong: path.join(openClawHome, "workspace_truongphong"),
    pho_phong: path.join(openClawHome, "workspace_phophong"),
    nv_content: path.join(openClawHome, "workspace_content"),
    nv_media: path.join(openClawHome, "workspace_media"),
  };
  return fallbacks[agentId] || null;
}

function syncRuntimePrompts(options = {}) {
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const promptDir = path.join(__dirname, "..", "runtime-prompts");
  const dryRun = Boolean(options.dryRun);
  const results = [];

  for (const [agentId, promptFile] of Object.entries(PROMPT_FILE_BY_AGENT)) {
    const workspaceDir = resolveWorkspaceByAgent(config, agentId, openClawHome);
    const sourcePath = path.join(promptDir, promptFile);
    const targetPath = workspaceDir ? path.join(workspaceDir, "SOUL.md") : null;
    const exists = Boolean(targetPath && fs.existsSync(workspaceDir));

    if (!exists) {
      results.push({
        agentId,
        status: "missing-workspace",
        workspaceDir,
        targetPath,
      });
      continue;
    }

    const content = fs.readFileSync(sourcePath, "utf8");
    if (!dryRun) {
      fs.writeFileSync(targetPath, content, "utf8");
    }
    results.push({
      agentId,
      status: dryRun ? "dry-run" : "synced",
      workspaceDir,
      targetPath,
      sourcePath,
    });
  }

  return {
    openClawHome,
    dryRun,
    results,
  };
}

function parseArgs(argv) {
  const options = {
    openClawHome: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--openclaw-home") {
      options.openClawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
    }
  }
  return options;
}

if (require.main === module) {
  const result = syncRuntimePrompts(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  syncRuntimePrompts,
};
