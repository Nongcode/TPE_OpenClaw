const { discoverRegistry } = require("./registry");
const { createPlan } = require("./planner");
const { executePlan } = require("./executor");

function parseArgs(argv) {
  const options = {
    mode: "direct",
    from: "quan_ly",
    target: null,
    taskType: null,
    message: "",
    json: false,
    dryRun: false,
    planOnly: false,
    list: false,
    openClawHome: null,
    manifestDir: null,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--from") {
      options.from = argv[index + 1] || options.from;
      index += 1;
      continue;
    }
    if (token === "--task-type") {
      options.taskType = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--plan-only") {
      options.planOnly = true;
      continue;
    }
    if (token === "--list") {
      options.list = true;
      continue;
    }
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
    positional.push(token);
  }

  if (options.list) {
    return options;
  }

  if (positional[0] === "auto") {
    options.mode = "auto";
    options.message = positional.slice(1).join(" ").trim();
    return options;
  }
  if (positional[0] === "hierarchy") {
    options.mode = "hierarchy";
    options.message = positional.slice(1).join(" ").trim();
    return options;
  }

  options.target = positional[0] || null;
  options.message = positional.slice(1).join(" ").trim();
  return options;
}

function printRegistry(registry, asJson) {
  if (asJson) {
    console.log(
      JSON.stringify(
        registry.agents.map((agent) => ({
          id: agent.id,
          label: agent.label || agent.id,
          role: agent.role || "agent",
          reportsTo: agent.reportsTo || null,
          canDelegateTo: agent.canDelegateTo || [],
          workspaceDir: agent.workspaceDir || null,
          sessionKey: agent.transport?.sessionKey || agent.sessionKey,
          model: agent.model || null,
        })),
        null,
        2,
      ),
    );
    return;
  }
  for (const agent of registry.agents) {
    console.log(`- ${agent.id}: ${agent.label || agent.id}`);
    console.log(`  role: ${agent.role || "agent"}`);
    console.log(`  workspace: ${agent.workspaceDir || "(unknown)"}`);
    console.log(`  session: ${agent.transport?.sessionKey || agent.sessionKey}`);
    console.log(`  delegates: ${(agent.canDelegateTo || []).join(", ") || "(none)"}`);
  }
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[PLAN] mode=${result.mode} from=${result.from}`);
  for (const [index, step] of result.executedSteps.entries()) {
    console.log(`\n[STEP ${index + 1}] ${step.from} -> ${step.to}`);
    console.log(`session=${step.sessionKey}`);
    console.log("----------------------------------------");
    console.log(step.reply);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const registry = discoverRegistry({
    openClawHome: options.openClawHome,
    manifestDir: options.manifestDir,
  });

  if (options.list) {
    printRegistry(registry, options.json);
    return;
  }

  if (!options.message) {
    throw new Error("Missing task message.");
  }
  if (options.mode === "direct" && !options.target) {
    throw new Error("Missing target agent.");
  }

  const plan = createPlan(registry, options);
  if (options.planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const result = await executePlan(registry, plan, options);
  printResult(result, options.json);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error("\n[ORCHESTRATOR ERROR]");
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  runCli,
};
