const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveOpenClawHome(explicitHome) {
  if (explicitHome) {
    return explicitHome;
  }
  if (process.env.OPENCLAW_HOME) {
    return process.env.OPENCLAW_HOME;
  }
  const userProfile = process.env.USERPROFILE || os.homedir();
  return path.join(userProfile, ".openclaw");
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function listDirectories(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadOpenClawConfig(explicitHome) {
  const openClawHome = resolveOpenClawHome(explicitHome);
  return readJsonIfExists(path.join(openClawHome, "openclaw.json"), {});
}

function resolveGatewayToken(options = {}) {
  if (options.gatewayToken) {
    return String(options.gatewayToken).trim();
  }
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return String(process.env.OPENCLAW_GATEWAY_TOKEN).trim();
  }
  const config = loadOpenClawConfig(options.openClawHome);
  const fromConfig = config?.gateway?.auth?.token;
  return typeof fromConfig === "string" ? fromConfig.trim() : "";
}

module.exports = {
  listDirectories,
  loadOpenClawConfig,
  normalizeText,
  readJsonIfExists,
  resolveGatewayToken,
  resolveOpenClawHome,
  unique,
};
