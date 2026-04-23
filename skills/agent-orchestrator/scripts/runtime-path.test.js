const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("auto-content bridge points to production orchestrator runtime", () => {
  const bridgePath = path.join(__dirname, "..", "..", "auto-content", "agent_bridge.js");
  const source = fs.readFileSync(bridgePath, "utf8");

  assert.match(source, /agent-orchestrator\/scripts\/orchestrator/);
  assert.doesNotMatch(source, /agent-orchestrator-test/);
});
