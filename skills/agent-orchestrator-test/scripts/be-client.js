/**
 * be-client.js — HTTP client cho FE Backend internal API.
 * Orchestrator dùng module này để tạo conversations, persist messages.
 */
const http = require("http");

const BE_BASE_URL = process.env.UPTEK_BE_URL || "http://localhost:3001";
const SYNC_TOKEN = process.env.AUTOMATION_SYNC_TOKEN || "uptek_internal_sync_2026_secure_token";

function callInternal(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BE_BASE_URL);
    const data = JSON.stringify(body || {});

    const req = http.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-automation-sync-token": SYNC_TOKEN,
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (chunk) => { buf += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`BE internal API ${method} ${urlPath} → ${res.statusCode}: ${buf.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`Invalid JSON from BE: ${buf.slice(0, 200)}`)); }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function createWorkflow(params) {
  return callInternal("POST", "/internal/workflows", params);
}

async function createSubAgentConversation(params) {
  return callInternal("POST", "/internal/conversations", {
    workflowId: params.workflowId,
    agentId: params.agentId,
    employeeId: params.employeeId,
    parentConversationId: params.parentConversationId || null,
    title: params.title || `[AUTO] ${params.agentId}`,
    lane: "automation",
  });
}

async function persistMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { success: true };
  return callInternal("POST", "/internal/messages", { messages });
}

async function updateWorkflowStatus(workflowId, status) {
  return callInternal("PATCH", `/internal/workflows/${workflowId}/status`, { status });
}

async function pushAutomationEvent(params) {
  return callInternal("POST", "/api/automation/agent-event", {
    workflowId: params.workflowId,
    employeeId: params.employeeId,
    agentId: params.agentId,
    title: params.title,
    role: params.role || "assistant",
    type: params.type || "regular",
    content: params.content,
    timestamp: params.timestamp,
    eventId: params.eventId,
  });
}

module.exports = {
  createWorkflow,
  createSubAgentConversation,
  persistMessages,
  updateWorkflowStatus,
  pushAutomationEvent,
};
