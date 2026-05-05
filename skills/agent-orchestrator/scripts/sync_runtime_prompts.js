const fs = require("fs");
const path = require("path");
const { loadOpenClawConfig, resolveOpenClawHome } = require("./common");

const PROMPT_FILE_BY_AGENT = {
  quan_ly: "quan_ly.SOUL.md",
  truong_phong: "truong_phong.SOUL.md",
  pho_phong: "pho_phong.SOUL.md",
  nv_content: "nv_content.SOUL.md",
  nv_media: "nv_media.SOUL.md",
  media_video: "media_video.SOUL.md",
};

function resolveWorkspaceByAgent(config, registry, agentId, openClawHome) {
  const configured = config?.agents?.list?.find((agent) => agent?.id === agentId)?.workspace;
  if (typeof configured === "string" && configured.trim()) {
    return configured;
  }
  const discovered = registry?.byId?.[agentId]?.workspaceDir;
  if (typeof discovered === "string" && discovered.trim()) {
    return discovered;
  }
  const fallbacks = {
    quan_ly: path.join(openClawHome, "workspace_quanly"),
    truong_phong: path.join(openClawHome, "workspace_truongphong"),
    pho_phong: path.join(openClawHome, "workspace_phophong"),
    pho_phong_cskh: path.join(openClawHome, "workspace_phophong_cskh"),
    nv_content: path.join(openClawHome, "workspace_content"),
    nv_consultant: path.join(openClawHome, "workspace_consultant"),
    nv_media: path.join(openClawHome, "workspace_media"),
    media_video: path.join(openClawHome, "workspace_media_video"),
  };
  return fallbacks[agentId] || null;
}

function listManagedAgentIds(config, openClawHome, promptDir) {
  const configuredIds = Array.isArray(config?.agents?.list)
    ? config.agents.list.map((agent) => agent?.id)
    : [];
  const runtimeIds = listDirectories(path.join(openClawHome, "agents"));
  const promptIds = fs.existsSync(promptDir)
    ? fs
        .readdirSync(promptDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".SOUL.md"))
        .map((entry) => entry.name.slice(0, -".".length - "SOUL.md".length))
    : [];

  return unique([...configuredIds, ...runtimeIds, ...promptIds]).sort((left, right) =>
    String(left).localeCompare(String(right)),
  );
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function syncFile(sourcePath, targetPath, dryRun) {
  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, readText(sourcePath), "utf8");
  }
}

function syncRuntimePrompts(options = {}) {
  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const config = loadOpenClawConfig(openClawHome);
  const registry = discoverRegistry({ openClawHome, manifestDir: options.manifestDir });
  const promptDir = options.promptDir || path.join(__dirname, "..", "runtime-prompts");
  const dryRun = Boolean(options.dryRun);
  const direction = options.direction || "runtime-to-workspace";
  const results = [];
  const requestedAgentIds = Array.isArray(options.agentIds)
    ? options.agentIds.filter(Boolean)
    : [];
  const agentIds =
    requestedAgentIds.length > 0
      ? requestedAgentIds
      : listManagedAgentIds(config, openClawHome, promptDir);

  for (const agentId of agentIds) {
    const workspaceDir = resolveWorkspaceByAgent(config, registry, agentId, openClawHome);
    const runtimePath = path.join(promptDir, promptFileNameForAgent(agentId));
    const workspacePath = workspaceDir ? path.join(workspaceDir, "SOUL.md") : null;
    const runtimeExists = fs.existsSync(runtimePath);
    const workspaceExists = Boolean(workspacePath && fs.existsSync(workspacePath));
    const runtimeContent = runtimeExists ? readText(runtimePath) : null;
    const workspaceContent = workspaceExists ? readText(workspacePath) : null;
    const matches = runtimeExists && workspaceExists && runtimeContent === workspaceContent;

    const baseResult = {
      agentId,
      workspaceDir,
      runtimePath,
      workspacePath,
    };

    if (!runtimeExists && !workspaceExists) {
      results.push({
        ...baseResult,
        status: "missing-both",
      });
      continue;
    }

    if (direction === "check") {
      results.push({
        ...baseResult,
        status: !runtimeExists ? "missing-runtime-prompt" : !workspaceExists ? "missing-workspace" : matches ? "matched" : "drift",
      });
      continue;
    }

    if (direction === "workspace-to-runtime") {
      if (!workspaceExists) {
        results.push({
          ...baseResult,
          status: "missing-workspace",
        });
        continue;
      }
      if (!runtimeExists || !matches) {
        try {
          syncFile(workspacePath, runtimePath, dryRun);
        } catch (error) {
          results.push({
            ...baseResult,
            status: "write-error",
            error: error.message,
          });
          continue;
        }
        results.push({
          ...baseResult,
          status: dryRun ? "dry-run-workspace-to-runtime" : "synced-workspace-to-runtime",
        });
        continue;
      }
      results.push({
        ...baseResult,
        status: "matched",
      });
      continue;
    }

    if (direction === "runtime-to-workspace") {
      if (!runtimeExists) {
        results.push({
          ...baseResult,
          status: "missing-runtime-prompt",
        });
        continue;
      }
      if (!workspaceExists) {
        results.push({
          ...baseResult,
          status: "missing-workspace",
        });
        continue;
      }
      if (!matches) {
        try {
          syncFile(runtimePath, workspacePath, dryRun);
        } catch (error) {
          results.push({
            ...baseResult,
            status: "write-error",
            error: error.message,
          });
          continue;
        }
        results.push({
          ...baseResult,
          status: dryRun ? "dry-run-runtime-to-workspace" : "synced-runtime-to-workspace",
        });
        continue;
      }
      results.push({
        ...baseResult,
        status: "matched",
      });
      continue;
    }

    throw new Error(`Unsupported sync direction: ${direction}`);
  }

  return {
    openClawHome,
    dryRun,
    direction,
    results,
  };
}

function parseArgs(argv) {
  const options = {
    openClawHome: null,
    manifestDir: null,
    promptDir: null,
    dryRun: false,
    direction: "runtime-to-workspace",
    agentIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--openclaw-home") {
      options.openClawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--manifest-dir") {
      options.manifestDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--prompt-dir") {
      options.promptDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--direction") {
      options.direction = argv[index + 1] || options.direction;
      index += 1;
      continue;
    }
    if (token === "--check") {
      options.direction = "check";
      continue;
    }
    if (token === "--agent") {
      const agentId = argv[index + 1] || null;
      if (agentId) {
        options.agentIds.push(agentId);
      }
      index += 1;
    }
  }
  return options;
}

if (require.main === module) {
  const result = syncRuntimePrompts(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  listManagedAgentIds,
  promptFileNameForAgent,
  resolveWorkspaceByAgent,
  syncRuntimePrompts,
};
