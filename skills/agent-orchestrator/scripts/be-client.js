const http = require("http");

const BACKEND_BASE_URL = process.env.UPTEK_BE_URL || "http://localhost:3001";
const AUTOMATION_SYNC_TOKEN = process.env.AUTOMATION_SYNC_TOKEN || "uptek_internal_sync_2026_secure_token";

function callInternal(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BACKEND_BASE_URL);
    const payload = JSON.stringify(body || {});

    const request = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-automation-sync-token": AUTOMATION_SYNC_TOKEN,
        },
      },
      (response) => {
        let buffer = "";
        response.on("data", (chunk) => {
          buffer += String(chunk);
        });
        response.on("end", () => {
          if ((response.statusCode || 500) >= 400) {
            reject(
              new Error(
                `Backend ${method} ${pathname} failed: ${response.statusCode} ${buffer.slice(0, 300)}`,
              ),
            );
            return;
          }

          try {
            resolve(buffer ? JSON.parse(buffer) : {});
          } catch (error) {
            reject(new Error(`Invalid backend JSON for ${method} ${pathname}: ${buffer.slice(0, 200)}`));
          }
        });
      },
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function ensureWorkflow(workflowId, params = {}) {
  return callInternal("POST", "/internal/workflows", {
    id: workflowId,
    workflowId,
    rootConversationId: params.rootConversationId || null,
    initiatorAgentId: params.initiatorAgentId || params.agentId || null,
    initiatorEmployeeId: params.initiatorEmployeeId || params.employeeId || params.agentId || null,
    title: params.title || null,
    status: params.status || "active",
  });
}

function emitWorkflowProgress(workflowId, params = {}) {
  return callInternal("POST", `/internal/workflows/${encodeURIComponent(workflowId)}/progress`, {
    conversationId: params.conversationId || null,
    agentId: params.agentId || null,
    stage: params.stage,
    label: params.label,
    status: params.status || null,
    timestamp: params.timestamp || Date.now(),
  });
}

function pushAutomationEvent(params) {
  return callInternal("POST", "/api/automation/agent-event", {
    workflowId: params.workflowId,
    employeeId: params.employeeId || params.agentId || null,
    agentId: params.agentId,
    conversationId: params.conversationId || null,
    conversationRole: params.conversationRole || "root",
    parentConversationId: params.parentConversationId || null,
    title: params.title || null,
    role: params.role || "assistant",
    type: params.type || "regular",
    content: params.content,
    timestamp: params.timestamp || Date.now(),
    status: params.status || null,
    sessionKey: params.sessionKey || null,
    eventId: params.eventId || null,
    injectToGateway: params.injectToGateway === true,
  });
}

module.exports = {
  ensureWorkflow,
  emitWorkflowProgress,
  pushAutomationEvent,
};
