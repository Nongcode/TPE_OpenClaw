const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGatewayAgentRequest,
  resolveGatewayUrl,
  withGatewayRuntimeHome,
} = require("./transport");

test("buildGatewayAgentRequest keeps resolved session key instead of forcing main", () => {
  const request = buildGatewayAgentRequest({
    openClawHome: "C:/mock-openclaw",
    agentId: "pho_phong",
    sessionKey: "agent:pho_phong:acp:child-1",
    prompt: "Xin brief task",
    timeoutMs: 123000,
  });

  assert.equal(request.method, "agent");
  assert.equal(request.params.agentId, "pho_phong");
  assert.equal(request.params.sessionKey, "agent:pho_phong:acp:child-1");
  assert.equal(request.params.timeout, 123);
  assert.equal(request.timeoutMs, 123000);
});

test("resolveGatewayUrl prefers remote gateway url from config", () => {
  const originalEnv = process.env.OPENCLAW_GATEWAY_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-transport-"));

  try {
    fs.writeFileSync(
      path.join(tempRoot, "openclaw.json"),
      JSON.stringify({
        gateway: {
          mode: "remote",
          remote: { url: "wss://gateway.example.test" },
        },
      }),
      "utf8",
    );

    assert.equal(resolveGatewayUrl(tempRoot), "wss://gateway.example.test");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = originalEnv;
    }
    if (originalToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    }
  }
});

test("resolveGatewayUrl uses local tls when enabled", () => {
  const originalEnv = process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_URL;

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-transport-"));

  try {
    fs.writeFileSync(
      path.join(tempRoot, "openclaw.json"),
      JSON.stringify({
        gateway: {
          port: 23456,
          tls: { enabled: true },
        },
      }),
      "utf8",
    );

    assert.equal(resolveGatewayUrl(tempRoot), "wss://127.0.0.1:23456");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = originalEnv;
    }
  }
});

test("buildGatewayAgentRequest keeps explicit config and configPath", () => {
  const path = require("path");
  const request = buildGatewayAgentRequest({
    openClawHome: "C:/mock-openclaw",
    agentId: "nv_content",
    prompt: "Tra loi ngan gon",
  });

  assert.equal(request.configPath, path.join("C:/mock-openclaw", "openclaw.json"));
  assert.equal(typeof request.config, "object");
});

test("withGatewayRuntimeHome temporarily isolates OPENCLAW_HOME", async () => {
  const originalHome = process.env.OPENCLAW_HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let insideHome = null;
  let insideStateDir = null;

  try {
    process.env.OPENCLAW_HOME = "C:/original-openclaw-home";
    process.env.OPENCLAW_STATE_DIR = "C:/original-openclaw-home/.openclaw";
    await withGatewayRuntimeHome(async (runtimeHome, runtimeStateDir) => {
      insideHome = process.env.OPENCLAW_HOME;
      insideStateDir = process.env.OPENCLAW_STATE_DIR;
      assert.equal(insideHome, runtimeHome);
      assert.equal(insideStateDir, runtimeStateDir);
      assert.match(runtimeHome, /artifacts[\\/]+agent-orchestrator[\\/]+gateway-runtime$/);
      assert.match(
        runtimeStateDir,
        /artifacts[\\/]+agent-orchestrator[\\/]+gateway-runtime[\\/]+\.openclaw$/,
      );
    });
    assert.equal(process.env.OPENCLAW_HOME, "C:/original-openclaw-home");
    assert.equal(process.env.OPENCLAW_STATE_DIR, "C:/original-openclaw-home/.openclaw");
  } finally {
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  }
});
