const baseTransport = require("../../agent-orchestrator/scripts/transport");

function extractTextFromHistoryMessage(message) {
  if (!message || typeof message !== "object") return "";
  const entry = message;
  if (typeof entry.text === "string" && entry.text.trim()) {
    return entry.text.trim();
  }
  if (typeof entry.content === "string" && entry.content.trim()) {
    return entry.content.trim();
  }
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

function normalizeWorkflowReplyText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function extractWorkflowField(text, label) {
  const match = String(text || "").match(new RegExp(`${label}\\s*[:=-]\\s*([A-Za-z0-9._:/\\\\-]+)`, "i"));
  return match?.[1]?.trim() || "";
}

function extractWorkflowReplyCandidates(text) {
  const raw = String(text || "");
  const matcher = /WORKFLOW[\s_]*META/gi;
  const matches = [...raw.matchAll(matcher)];
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => {
    const startIndex = match.index || 0;
    const endIndex = index + 1 < matches.length ? (matches[index + 1].index || raw.length) : raw.length;
    return {
      text: raw.slice(startIndex, endIndex).trim(),
      startIndex,
    };
  }).filter((candidate) => candidate.text);
}

function correlateByWorkflowIdAndStepId(params) {
  const raw = String(params.text || "").trim();
  if (!raw) {
    return {
      ok: false,
      workflowId: params.workflowId,
      stepId: params.stepId,
      matchedBy: "empty_reply",
      reason: "empty reply",
      matchedText: "",
    };
  }

  const candidates = extractWorkflowReplyCandidates(raw);
  if (candidates.length === 0) {
    return {
      ok: false,
      workflowId: params.workflowId,
      stepId: params.stepId,
      matchedBy: "missing_workflow_meta",
      reason: "missing WORKFLOW_META",
      matchedText: "",
    };
  }

  const diagnostics = [];
  for (const candidate of candidates) {
    const candidateWorkflowId = extractWorkflowField(candidate.text, "workflow_id");
    const candidateStepId = extractWorkflowField(candidate.text, "step_id");
    const workflowMatches = candidateWorkflowId === params.workflowId;
    const stepMatches = candidateStepId === params.stepId;

    if (workflowMatches && stepMatches) {
      return {
        ok: true,
        workflowId: candidateWorkflowId,
        stepId: candidateStepId,
        matchedBy: "reply_text",
        reason: candidate.startIndex > 0 ? "preamble_before_workflow_meta" : null,
        matchedText: candidate.text,
      };
    }

    diagnostics.push({
      workflowId: candidateWorkflowId,
      stepId: candidateStepId,
      reason:
        !candidateWorkflowId
          ? "missing workflow_id"
          : !candidateStepId
            ? "missing step_id"
            : !workflowMatches
              ? `workflow_id mismatch (${candidateWorkflowId})`
              : `step_id mismatch (${candidateStepId})`,
      matchedText: candidate.text,
    });
  }

  const preferredDiagnostic =
    diagnostics.find((item) => item.workflowId === params.workflowId)
    || diagnostics[0];

  return {
    ok: false,
    workflowId: preferredDiagnostic?.workflowId || params.workflowId,
    stepId: preferredDiagnostic?.stepId || params.stepId,
    matchedBy: "workflow_meta_candidate",
    reason: preferredDiagnostic?.reason || "workflow_id mismatch",
    matchedText: preferredDiagnostic?.matchedText || "",
  };
}

function looksLikeCompletedWorkflowReply(text, workflowId, stepId) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const correlation = correlateByWorkflowIdAndStepId({
    workflowId,
    stepId,
    text: raw,
  });
  if (!correlation.ok) {
    return false;
  }

  const normalized = normalizeWorkflowReplyText(correlation.matchedText || raw);
  const hasWorkflowMeta = /WORKFLOW[\s_]*META/.test(normalized);
  const hasStatusMarker = /TRANG[\s_]*THAI/.test(normalized);
  if (!hasWorkflowMeta || !hasStatusMarker) {
    return false;
  }
  return correlation.matchedBy === "reply_text";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLatestWorkflowReplyInHistory(options) {
  try {
    const historyResult = await baseTransport.callGatewayMethod({
      openClawHome: options.openClawHome,
      method: "chat.history",
      params: {
        sessionKey: options.sessionKey,
        limit: options.limit || 30,
      },
      timeoutMs: options.timeoutMs || 30000,
    });
    const messages =
      historyResult?.result?.payload?.messages ||
      historyResult?.result?.messages ||
      historyResult?.messages ||
      [];
    if (!Array.isArray(messages)) {
      return "";
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== "object" || message.role !== "assistant") {
        continue;
      }
      const text = extractTextFromHistoryMessage(message);
      if (looksLikeCompletedWorkflowReply(text, options.workflowId, options.stepId)) {
        return text;
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function waitForCompletedWorkflowReply(task, initialText) {
  const immediateHistoryText = await findLatestWorkflowReplyInHistory({
    openClawHome: task.openClawHome,
    sessionKey: task.sessionKey,
    workflowId: task.workflowId,
    stepId: task.stepId,
    timeoutMs: 15000,
    limit: 40,
  });
  if (immediateHistoryText) {
    return immediateHistoryText;
  }
  if (looksLikeCompletedWorkflowReply(initialText, task.workflowId, task.stepId)) {
    return initialText;
  }
  const maxWaitMs = Math.min(Math.max(Number(task.timeoutMs) || 180000, 30000), 1800000);
  const pollIntervalMs =
    Number.isFinite(task.pollIntervalMs) && task.pollIntervalMs > 0
      ? task.pollIntervalMs
      : 5000;
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 0; Date.now() <= deadline; attempt += 1) {
    if (attempt > 0) {
      await delay(pollIntervalMs);
    }
    const text = await findLatestWorkflowReplyInHistory({
      openClawHome: task.openClawHome,
      sessionKey: task.sessionKey,
      workflowId: task.workflowId,
      stepId: task.stepId,
      timeoutMs: 20000,
      limit: 40,
    });
    if (text) {
      return text;
    }
  }
  return initialText;
}

function sendTaskToAgentLane(options) {
  const task = baseTransport.sendTaskToAgentLane(options);
  return {
    ...task,
    openClawHome: options.openClawHome,
    timeoutMs:
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 10000 ? options.timeoutMs : 180000,
  };
}

async function waitForAgentResponse(task) {
  let pendingSettled = false;
  let pendingText = "";
  let pendingError = null;

  task.pending
    .then((result) => {
      pendingText = baseTransport.extractTextFromGatewayResult(result);
      pendingSettled = true;
    })
    .catch((error) => {
      pendingError = error;
      pendingSettled = true;
    });

  const maxWaitMs = Math.min(Math.max(Number(task.timeoutMs) || 180000, 30000), 1800000);
  const pollIntervalMs =
    Number.isFinite(task.pollIntervalMs) && task.pollIntervalMs > 0
      ? task.pollIntervalMs
      : 5000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
      const historyText = await findLatestWorkflowReplyInHistory({
      openClawHome: task.openClawHome,
      sessionKey: task.sessionKey,
      workflowId: task.workflowId,
      stepId: task.stepId,
      timeoutMs: 20000,
      limit: 40,
    });

    if (historyText) {
      const correlation = correlateByWorkflowIdAndStepId({
        workflowId: task.workflowId,
        stepId: task.stepId,
        text: historyText,
      });
      return {
        runId: task.runId,
        agentId: task.agentId,
        workerAgentId: task.workerAgentId || task.agentId,
        managerInstanceId: task.managerInstanceId || null,
        workflowId: correlation.workflowId,
        stepId: correlation.stepId,
        taskId: task.taskId,
        ok: correlation.ok,
        matchedBy: correlation.matchedBy,
        text: historyText,
      };
    }

    if (pendingSettled) {
      if (pendingError) {
        await delay(pollIntervalMs);
        continue;
      }

      const text = await waitForCompletedWorkflowReply(task, pendingText);
      const correlation = correlateByWorkflowIdAndStepId({
        workflowId: task.workflowId,
        stepId: task.stepId,
        text,
      });
      return {
        runId: task.runId,
        agentId: task.agentId,
        workerAgentId: task.workerAgentId || task.agentId,
        managerInstanceId: task.managerInstanceId || null,
        workflowId: correlation.workflowId,
        stepId: correlation.stepId,
        taskId: task.taskId,
        ok: correlation.ok,
        matchedBy: correlation.matchedBy,
        text,
      };
    }

    await delay(pollIntervalMs);
  }

  if (pendingError) {
    throw pendingError;
  }

  throw new Error(
    `Timed out waiting for ${task.agentId} reply for ${task.workflowId}/${task.stepId}.`,
  );
}

module.exports = {
  ...baseTransport,
  correlateByWorkflowIdAndStepId,
  extractWorkflowReplyCandidates,
  extractWorkflowField,
  findLatestWorkflowReplyInHistory,
  normalizeWorkflowReplyText,
  looksLikeCompletedWorkflowReply,
  sendTaskToAgentLane,
  waitForAgentResponse,
};
