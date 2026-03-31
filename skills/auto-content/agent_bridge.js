const { runCli } = require("../agent-orchestrator/scripts/orchestrator");

runCli(process.argv.slice(2)).catch((error) => {
  console.error("\n[AUTO-CONTENT BRIDGE ERROR]");
  console.error(error.message);
  process.exit(1);
});
