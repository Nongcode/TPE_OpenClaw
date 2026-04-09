const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.OPENCLAW_AGENT_ORCHESTRATOR_STATE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "tests",
  "agent-orchestrator-state",
);

const { createPlan } = require("./planner");
const { clearPhoPhongWorkflowState, savePhoPhongWorkflowState } = require("./workflow_state");

test.beforeEach(() => {
  clearPhoPhongWorkflowState();
});

test.after(() => {
  clearPhoPhongWorkflowState();
  try {
    fs.rmSync(process.env.OPENCLAW_AGENT_ORCHESTRATOR_STATE_DIR, { recursive: true, force: true });
  } catch {}
});

function makeRegistry() {
  const agents = [
    { id: "truong_phong", reportsTo: "quan_ly", canDelegateTo: ["pho_phong", "pho_phong_cskh"] },
    { id: "pho_phong", reportsTo: "truong_phong", canDelegateTo: ["nv_content", "nv_media"] },
    { id: "pho_phong_cskh", reportsTo: "truong_phong", canDelegateTo: ["nv_consultant"] },
    { id: "nv_content", reportsTo: "pho_phong", canDelegateTo: [] },
    { id: "nv_media", reportsTo: "pho_phong", canDelegateTo: [] },
    { id: "nv_consultant", reportsTo: "pho_phong_cskh", canDelegateTo: [] },
    { id: "quan_ly", canDelegateTo: ["truong_phong"] },
  ];
  return {
    agents,
    byId: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
  };
}

test("hierarchy plan from truong_phong requires plan approval gate first", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Lap ke hoach chi tiet cho chien dich facebook san pham cau nang",
    taskType: "campaign.execute",
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "propose");
  assert.equal(plan.steps[0].deliverToUser, true);
});

test("hierarchy plan from quan_ly requires detailed plan approval before execution", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "quan_ly",
    message: "Trien khai chien dich facebook cho san pham cau nang 2 tru",
    taskType: "campaign.execute",
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "propose");
  assert.equal(plan.steps[0].to, "quan_ly");
  assert.equal(plan.steps[0].deliverToUser, true);
});

test("hierarchy plan from quan_ly with approved plan returns final package to quan_ly", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "quan_ly",
    message: "Ke hoach da duoc duyet, trien khai chien dich facebook cho cau nang oto",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "plan_execute:truong_phong",
    "plan_execute:pho_phong",
    "product_research:pho_phong",
    "produce:nv_content",
    "content_review:pho_phong",
    "produce:nv_media",
    "media_review:pho_phong",
    "compile_post:pho_phong",
    "final_review:truong_phong",
    "report:quan_ly",
  ]);
  assert.equal(plan.steps.at(-1)?.deliverToUser, true);
});

test("hierarchy plan from truong_phong with approved plan follows strict flow", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Ke hoach da duoc duyet, trien khai theo ke hoach da duyet de dang facebook",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => step.type);
  assert.deepEqual(stepTypes, [
    "plan_execute",
    "product_research",
    "produce",
    "content_review",
    "produce",
    "media_review",
    "compile_post",
    "final_review",
  ]);
  assert.equal(plan.steps[1].to, "pho_phong");
  assert.equal(plan.steps[7].to, "truong_phong");
  assert.equal(plan.steps[7].deliverToUser, true);
});

test("hierarchy plan from pho_phong stops after content review for user approval", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "pho_phong",
    message: "Viet bai va lam media facebook cho san pham cau nang oto",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "product_research:pho_phong",
    "produce:nv_content",
    "content_review:pho_phong",
  ]);
  assert.equal(plan.steps.at(-1)?.deliverToUser, true);
  assert.equal(plan.steps.at(-1)?.approvalGate, "content");
});

test("hierarchy plan from pho_phong stops after content review when media is not needed", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "pho_phong",
    message: "Chi viet bai facebook, khong can hinh anh hay video",
    taskType: "content.write",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "product_research:pho_phong",
    "produce:nv_content",
    "content_review:pho_phong",
  ]);
  assert.equal(plan.steps.at(-1)?.deliverToUser, true);
});

test("hierarchy plan from pho_phong resumes media flow after content approval", () => {
  const registry = makeRegistry();
  savePhoPhongWorkflowState({
    stage: "awaiting_content_approval",
    workflowState: {
      finalContent: "Ban content da duyet",
    },
  });

  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "pho_phong",
    message: "Duyet content roi, lam media va dong goi de toi xem",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "produce:nv_media",
    "media_review:pho_phong",
    "compile_post:pho_phong",
  ]);
  assert.equal(plan.resumeWorkflowState, true);
  assert.equal(plan.steps.at(-1)?.approvalGate, "media");
});

test("hierarchy plan from pho_phong publishes after media approval", () => {
  const registry = makeRegistry();
  savePhoPhongWorkflowState({
    stage: "awaiting_media_approval",
    workflowState: {
      finalContent: "Ban content va media da chot",
    },
  });

  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "pho_phong",
    message: "Duyet media roi, dang facebook di",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, ["auto_content_publish:pho_phong"]);
  assert.equal(plan.resumeWorkflowState, true);
});

test("hierarchy plan from truong_phong executes strict flow when no detailed-plan gate requested", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Trien khai chien dich facebook cho san pham cau nang oto, viet bai va lam media",
    taskType: "campaign.execute",
  });

  const stepTypes = plan.steps.map((step) => step.type);
  assert.deepEqual(stepTypes, [
    "plan_execute",
    "product_research",
    "produce",
    "content_review",
    "produce",
    "media_review",
    "compile_post",
    "final_review",
  ]);
});

test("hierarchy plan from nv_content only assigns the content specialist", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "nv_content",
    message: "Viet bai gioi thieu san pham cau nang",
    taskType: "content.write",
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "direct");
  assert.equal(plan.steps[0].to, "nv_content");
  assert.equal(plan.steps[0].deliverToUser, true);
});

test("hierarchy plan from truong_phong drafts customer email and stops for truong_phong approval", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Gui email cho khach hang mua nhieu hang nhat de cham soc va ban tiep",
    taskType: "consultant.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "customer_data_research:pho_phong_cskh",
    "consultant_produce:nv_consultant",
    "consultant_review:pho_phong_cskh",
    "final_review:truong_phong",
  ]);
  assert.equal(plan.steps.at(-1)?.deliverToUser, true);
});

test("hierarchy plan from truong_phong sends approved customer email via pho_phong_cskh", () => {
  const registry = makeRegistry();
  const plan = createPlan(registry, {
    mode: "hierarchy",
    from: "truong_phong",
    message: "Duyet gui email nay di cho khach hang mua nhieu hang nhat",
    taskType: "consultant.execute",
  });

  const stepTypes = plan.steps.map((step) => `${step.type}:${step.to}`);
  assert.deepEqual(stepTypes, [
    "email_send:pho_phong_cskh",
    "report:truong_phong",
  ]);
  assert.equal(plan.steps.at(-1)?.deliverToUser, true);
});
