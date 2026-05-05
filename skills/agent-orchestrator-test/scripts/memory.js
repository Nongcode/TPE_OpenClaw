/**
 * memory.js — Long-term Memory & Self-Learning cho các agent.
 *
 * Mỗi agent có file rules.json riêng trong workspace.
 * Khi bị reject, agent tự suy luận ra quy tắc mới và ghi vào đây.
 * Trước khi làm việc, agent bắt buộc đọc rules.json và tuân theo.
 */

const fs = require("fs");
const path = require("path");
const { loadOpenClawConfig, resolveOpenClawHome } = require("../../agent-orchestrator/scripts/common");

const MAX_RULES_DEFAULT = 50;
const MAX_SUCCESS_EXAMPLES_DEFAULT = 80;

/**
 * Tìm workspace directory cho một agent dựa trên config.
 */
function resolveAgentWorkspace(agentId, openClawHome) {
  const config = loadOpenClawConfig(openClawHome);
  const agentEntry = config?.agents?.list?.find((a) => a?.id === agentId);
  if (agentEntry?.workspace) {
    return path.resolve(agentEntry.workspace);
  }
  // Fallback theo convention
  const suffix = agentId.replace(/^[^_]+_/, "");
  const candidates = [
    path.join(openClawHome, `workspace_${suffix}`),
    path.join(openClawHome, `workspace_${agentId.replace(/_/g, "")}`),
    path.join(openClawHome, `workspace_${agentId}`),
  ];
  return candidates.find((c) => fs.existsSync(c)) || path.join(openClawHome, "workspace");
}

/**
 * Đường dẫn tới rules.json của một agent.
 */
function rulesFilePath(agentId, openClawHome) {
  const workspace = resolveAgentWorkspace(agentId, openClawHome);
  return path.join(workspace, "rules.json");
}

function successMemoryFilePath(agentId, openClawHome) {
  const workspace = resolveAgentWorkspace(agentId, openClawHome);
  return path.join(workspace, "success-memory.json");
}

/**
 * Đọc rules.json. Trả default nếu chưa tồn tại.
 */
function loadRules(agentId, openClawHome) {
  const filePath = rulesFilePath(agentId, openClawHome);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      const data = JSON.parse(raw);
      return {
        agent_id: agentId,
        rules: Array.isArray(data.rules) ? data.rules : [],
        max_rules: data.max_rules || MAX_RULES_DEFAULT,
        updated_at: data.updated_at || null,
      };
    }
  } catch {
    // Nếu parse lỗi, trả default
  }
  return {
    agent_id: agentId,
    rules: [],
    max_rules: MAX_RULES_DEFAULT,
    updated_at: null,
  };
}

function loadSuccessExamples(agentId, openClawHome) {
  const filePath = successMemoryFilePath(agentId, openClawHome);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      const data = JSON.parse(raw);
      return {
        agent_id: agentId,
        examples: Array.isArray(data.examples) ? data.examples : [],
        max_examples: data.max_examples || MAX_SUCCESS_EXAMPLES_DEFAULT,
        updated_at: data.updated_at || null,
      };
    }
  } catch {
    // ignore malformed file and fall back to default
  }
  return {
    agent_id: agentId,
    examples: [],
    max_examples: MAX_SUCCESS_EXAMPLES_DEFAULT,
    updated_at: null,
  };
}

/**
 * Ghi rules.json.
 */
function saveRules(agentId, openClawHome, rulesData) {
  const filePath = rulesFilePath(agentId, openClawHome);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    agent_id: agentId,
    rules: rulesData.rules || [],
    max_rules: rulesData.max_rules || MAX_RULES_DEFAULT,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function saveSuccessExamples(agentId, openClawHome, successData) {
  const filePath = successMemoryFilePath(agentId, openClawHome);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    agent_id: agentId,
    examples: successData.examples || [],
    max_examples: successData.max_examples || MAX_SUCCESS_EXAMPLES_DEFAULT,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * Thêm một quy tắc mới vào rules.json.
 * Tự dedup (không thêm rule trùng) và FIFO (xóa rule cũ nhất khi đầy).
 */
function appendRule(agentId, openClawHome, newRule) {
  const trimmed = String(newRule || "").trim();
  if (!trimmed) {
    return null;
  }

  const data = loadRules(agentId, openClawHome);
  const normalized = trimmed.toLowerCase();

  // Dedup: không thêm nếu đã tồn tại rule tương tự
  const isDuplicate = data.rules.some(
    (r) => r.text && r.text.toLowerCase() === normalized,
  );
  if (isDuplicate) {
    return data;
  }

  const entry = {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    learned_at: new Date().toISOString(),
    source: "feedback_reject",
  };

  data.rules.push(entry);

  // FIFO: giữ max_rules, xóa cũ nhất
  while (data.rules.length > data.max_rules) {
    data.rules.shift();
  }

  return saveRules(agentId, openClawHome, data);
}

function appendSuccessExample(agentId, openClawHome, example) {
  const brief = String(example?.brief || "").trim();
  const approvedResult = String(example?.approved_result || "").trim();
  if (!brief || !approvedResult) {
    return null;
  }

  const data = loadSuccessExamples(agentId, openClawHome);
  const workflowId = String(example?.workflow_id || "").trim();
  const kind = String(example?.kind || "").trim() || "generic";
  const duplicate = data.examples.some(
    (entry) =>
      (workflowId && entry.workflow_id === workflowId && String(entry.kind || "") === kind) ||
      (String(entry.brief || "").trim() === brief &&
        String(entry.approved_result || "").trim() === approvedResult),
  );
  if (duplicate) {
    return data;
  }

  data.examples.push({
    id: `success_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workflow_id: workflowId || null,
    kind,
    brief,
    approved_result: approvedResult,
    prompt: String(example?.prompt || "").trim(),
    content: String(example?.content || "").trim(),
    product_name: String(example?.product_name || "").trim(),
    media_type: String(example?.media_type || "").trim(),
    feedback: String(example?.feedback || "").trim(),
    global_guidelines: Array.isArray(example?.global_guidelines)
      ? example.global_guidelines.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    approved_at: example?.approved_at || new Date().toISOString(),
  });

  while (data.examples.length > data.max_examples) {
    data.examples.shift();
  }

  return saveSuccessExamples(agentId, openClawHome, data);
}

function buildSearchableSuccessText(example) {
  return [
    example?.brief,
    example?.approved_result,
    example?.prompt,
    example?.content,
    example?.product_name,
    ...(Array.isArray(example?.global_guidelines) ? example.global_guidelines : []),
  ]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" \n ");
}

function tokenizeForMatch(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  )];
}

function searchSuccessExamples(agentId, openClawHome, query, limit = 3) {
  const tokens = tokenizeForMatch(query);
  const data = loadSuccessExamples(agentId, openClawHome);
  if (data.examples.length === 0) {
    return [];
  }

  const scored = data.examples
    .map((example) => {
      const haystack = buildSearchableSuccessText(example);
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 1;
        }
      }
      if (String(example?.product_name || "").trim()) {
        score += 0.2;
      }
      return { example, score };
    })
    .filter((entry) => entry.score > 0 || tokens.length === 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(right.example?.approved_at || "").localeCompare(String(left.example?.approved_at || "")),
    )
    .slice(0, limit)
    .map((entry) => entry.example);

  return scored;
}

function buildSuccessExamplesPromptSection(agentId, openClawHome, query, limit = 3) {
  const matches = searchSuccessExamples(agentId, openClawHome, query, limit);
  if (matches.length === 0) {
    return "";
  }

  const lines = [
    "",
    "SO TAY KINH NGHIEM DUOC SEP DUYET TRUOC DAY:",
    "Truoc khi tao ban moi, doc nhanh cac mau da duoc duyet ben duoi va uu tien hoc dung phong cach/yeu cau lap lai:",
    "",
  ];

  matches.forEach((example, index) => {
    lines.push(`[Mau ${index + 1}] Brief: ${String(example.brief || "").trim()}`);
    if (example.product_name) {
      lines.push(`San pham: ${example.product_name}`);
    }
    if (Array.isArray(example.global_guidelines) && example.global_guidelines.length > 0) {
      lines.push(`Guideline da duyet: ${example.global_guidelines.join(" | ")}`);
    }
    lines.push(`Ket qua da duyet: ${String(example.approved_result || "").trim().slice(0, 800)}`);
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Build đoạn text để nhúng vào System Prompt của agent.
 * Trả "" nếu không có rule nào.
 */
function buildRulesPromptSection(agentId, openClawHome) {
  const data = loadRules(agentId, openClawHome);
  if (data.rules.length === 0) {
    return "";
  }

  const lines = [
    "",
    "QUY TAC KINH NGHIEM (BAT BUOC TUAN THU):",
    "Ban da tung bi tru diem vi lam sai cac quy tac duoi day. Tuyet doi khong duoc vi pham lai:",
    "",
  ];

  data.rules.forEach((rule, index) => {
    lines.push(`[${index + 1}] ${rule.text}`);
  });

  lines.push("");
  return lines.join("\n");
}

function buildWorkflowGuidelinesPromptSection(guidelines) {
  const normalized = [...new Set(
    (guidelines || []).map((item) => String(item || "").trim()).filter(Boolean),
  )];
  if (normalized.length === 0) {
    return "";
  }

  const lines = [
    "",
    "GLOBAL GUIDELINE CUA WORKFLOW HIEN TAI (BAT BUOC AP DUNG XUYEN SUOT):",
    ...normalized.map((item, index) => `[${index + 1}] ${item}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Gọi LLM để suy luận ra quy tắc mới từ feedback.
 * Trả về string rule hoặc null nếu không suy luận được.
 *
 * Hàm này cần transport module để gọi gateway.
 * Nếu không có transport, trả về feedback trực tiếp làm rule.
 */
function buildLearningPrompt(agentId, oldOutput, feedback) {
  return [
    "Ban la mot chuyen gia phan tich chat luong. Hay doc ky 2 phan sau:",
    "",
    "BAN CU (bi tu choi):",
    String(oldOutput || "").slice(0, 1500),
    "",
    "NHAN XET TU SEP:",
    String(feedback || "").slice(0, 500),
    "",
    "HAY RUT RA DUNG 1 QUY TAC NGAN GON (1-2 cau) MA NHAN VIEN CAN NHO DE KHONG LAP LAI LOI NAY.",
    "Chi tra ve cau quy tac, KHONG giai thich them.",
    `Quy tac danh cho: ${agentId}`,
  ].join("\n");
}

/**
 * Hàm học từ feedback — phiên bản đồng bộ (không cần LLM call).
 * Trích xuất rule trực tiếp từ feedback text khi không có LLM available.
 */
function learnFromFeedbackSync(agentId, openClawHome, feedback) {
  const trimmed = String(feedback || "").trim();
  if (!trimmed) {
    return null;
  }

  // Trích xuất nội dung quan trọng từ feedback làm rule
  const ruleText = `Khi sep noi "${trimmed.slice(0, 200)}", can sua theo dung y do.`;
  return appendRule(agentId, openClawHome, ruleText);
}

/**
 * Đếm thống kê reject history từ workflow history files.
 */
function getRejectStats(historyDir) {
  const stats = { total: 0, by_stage: {}, by_agent: {} };
  try {
    if (!fs.existsSync(historyDir)) {
      return stats;
    }
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(historyDir, file), "utf8").replace(/^\uFEFF/, ""),
        );
        if (data.reject_history && Array.isArray(data.reject_history)) {
          for (const entry of data.reject_history) {
            stats.total += 1;
            const stage = entry.stage || "unknown";
            const agent = entry.agent || "unknown";
            stats.by_stage[stage] = (stats.by_stage[stage] || 0) + 1;
            stats.by_agent[agent] = (stats.by_agent[agent] || 0) + 1;
          }
        }
      } catch {
        // Skip malformed history files
      }
    }
  } catch {
    // History dir doesn't exist
  }
  return stats;
}

module.exports = {
  appendRule,
  appendSuccessExample,
  buildLearningPrompt,
  buildRulesPromptSection,
  buildSuccessExamplesPromptSection,
  buildWorkflowGuidelinesPromptSection,
  getRejectStats,
  learnFromFeedbackSync,
  loadRules,
  loadSuccessExamples,
  resolveAgentWorkspace,
  rulesFilePath,
  saveSuccessExamples,
  saveRules,
  searchSuccessExamples,
  successMemoryFilePath,
};
