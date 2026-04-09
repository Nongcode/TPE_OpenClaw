const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function resolveStateDir() {
  if (process.env.OPENCLAW_AGENT_ORCHESTRATOR_STATE_DIR) {
    return path.resolve(process.env.OPENCLAW_AGENT_ORCHESTRATOR_STATE_DIR);
  }
  return path.join(REPO_ROOT, "artifacts", "campaigns", "agent-orchestrator-state");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getPhoPhongWorkflowStatePath() {
  return path.join(resolveStateDir(), "pho_phong-facebook-workflow.json");
}

function loadPhoPhongWorkflowState() {
  const filePath = getPhoPhongWorkflowStatePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function savePhoPhongWorkflowState(payload) {
  const dirPath = resolveStateDir();
  ensureDir(dirPath);
  fs.writeFileSync(
    getPhoPhongWorkflowStatePath(),
    `${JSON.stringify(
      {
        ...payload,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function clearPhoPhongWorkflowState() {
  const filePath = getPhoPhongWorkflowStatePath();
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

module.exports = {
  loadPhoPhongWorkflowState,
  savePhoPhongWorkflowState,
  clearPhoPhongWorkflowState,
  getPhoPhongWorkflowStatePath,
};
