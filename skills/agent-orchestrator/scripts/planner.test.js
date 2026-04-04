const test = require("node:test");
const assert = require("node:assert/strict");

const { createPlan } = require("./planner");

function makeRegistry() {
  const agents = [
    { id: "truong_phong", reportsTo: "quan_ly", canDelegateTo: ["pho_phong"] },
    { id: "pho_phong", reportsTo: "truong_phong", canDelegateTo: ["nv_content", "nv_media"] },
    { id: "nv_content", reportsTo: "pho_phong", canDelegateTo: [] },
    { id: "nv_media", reportsTo: "pho_phong", canDelegateTo: [] },
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
