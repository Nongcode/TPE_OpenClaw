const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { syncRuntimePrompts } = require("./sync_runtime_prompts");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-sync-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

test("syncRuntimePrompts copies runtime prompts into configured workspaces", () => {
  const openClawHome = makeTempHome();
  const promptDir = path.join(openClawHome, "runtime-prompts");
  const workspaceDir = path.join(openClawHome, "workspace_phophong");
  writeJson(path.join(openClawHome, "openclaw.json"), {
    agents: {
      list: [{ id: "pho_phong", workspace: workspaceDir }],
    },
  });
  writeText(path.join(workspaceDir, "SOUL.md"), "workspace-old");
  writeText(path.join(promptDir, "pho_phong.SOUL.md"), "runtime-new");

  const result = syncRuntimePrompts({
    openClawHome,
    promptDir,
    direction: "runtime-to-workspace",
  });

  const phoPhongResult = result.results.find((item) => item.agentId === "pho_phong");
  assert.equal(phoPhongResult?.status, "synced-runtime-to-workspace");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"), "runtime-new");
});

test("syncRuntimePrompts can pull workspace prompts back into runtime-prompts", () => {
  const openClawHome = makeTempHome();
  const promptDir = path.join(openClawHome, "runtime-prompts");
  const workspaceDir = path.join(openClawHome, "workspace_consultant");
  writeJson(path.join(openClawHome, "openclaw.json"), {
    agents: {
      list: [{ id: "nv_consultant", workspace: workspaceDir }],
    },
  });
  writeText(path.join(workspaceDir, "SOUL.md"), "workspace-source");
  const runtimePath = path.join(promptDir, "nv_consultant.SOUL.md");
  writeText(runtimePath, "runtime-old");

  const result = syncRuntimePrompts({
    openClawHome,
    promptDir,
    direction: "workspace-to-runtime",
  });

  const consultantResult = result.results.find((item) => item.agentId === "nv_consultant");
  assert.equal(consultantResult?.status, "synced-workspace-to-runtime");
  assert.equal(fs.readFileSync(runtimePath, "utf8"), "workspace-source");
});

test("syncRuntimePrompts check mode reports drift without writing", () => {
  const openClawHome = makeTempHome();
  const promptDir = path.join(openClawHome, "runtime-prompts");
  const workspaceDir = path.join(openClawHome, "workspace_truongphong");
  writeJson(path.join(openClawHome, "openclaw.json"), {
    agents: {
      list: [{ id: "truong_phong", workspace: workspaceDir }],
    },
  });
  writeText(path.join(workspaceDir, "SOUL.md"), "workspace-version");
  const runtimePath = path.join(promptDir, "truong_phong.SOUL.md");
  writeText(runtimePath, "runtime-version");

  const result = syncRuntimePrompts({
    openClawHome,
    promptDir,
    direction: "check",
  });

  const truongPhongResult = result.results.find((item) => item.agentId === "truong_phong");
  assert.equal(truongPhongResult?.status, "drift");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"), "workspace-version");
  assert.equal(fs.readFileSync(runtimePath, "utf8"), "runtime-version");
});
