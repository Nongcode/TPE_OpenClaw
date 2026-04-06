import type { ControlUiBootstrapAccessPolicy } from "../../../src/gateway/control-ui-contract.js";

export const CONTROL_UI_DEMO_LOGIN_SESSION_KEY = "openclaw.control.demo-login.authed";
export const CONTROL_UI_DEMO_LOGIN_POLICY_KEY = "openclaw.control.demo-login.access-policy";

function readSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStoredAccessPolicy(value: unknown): ControlUiBootstrapAccessPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const policy: ControlUiBootstrapAccessPolicy = {
    employeeId: normalizeOptionalString(raw.employeeId),
    employeeName: normalizeOptionalString(raw.employeeName),
    lockedAgentId: normalizeOptionalString(raw.lockedAgentId),
    lockedSessionKey: normalizeOptionalString(raw.lockedSessionKey),
    canViewAllSessions: normalizeOptionalBoolean(raw.canViewAllSessions),
    visibleAgentIds: normalizeOptionalStringArray(raw.visibleAgentIds),
    lockAgent: normalizeOptionalBoolean(raw.lockAgent),
    lockSession: normalizeOptionalBoolean(raw.lockSession),
    autoConnect: normalizeOptionalBoolean(raw.autoConnect),
    enforcedByServer: normalizeOptionalBoolean(raw.enforcedByServer),
  };
  if (
    !policy.employeeId &&
    !policy.employeeName &&
    !policy.lockedAgentId &&
    !policy.lockedSessionKey &&
    policy.canViewAllSessions !== true &&
    !policy.visibleAgentIds
  ) {
    return null;
  }
  return policy;
}

export function isControlUiDemoLoginUnlocked(): boolean {
  return readSessionStorage()?.getItem(CONTROL_UI_DEMO_LOGIN_SESSION_KEY) === "1";
}

export function storeControlUiDemoLoginState(policy: ControlUiBootstrapAccessPolicy | null | undefined) {
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }
  storage.setItem(CONTROL_UI_DEMO_LOGIN_SESSION_KEY, "1");
  const normalized = normalizeStoredAccessPolicy(policy);
  if (!normalized) {
    storage.removeItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY);
    return;
  }
  storage.setItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY, JSON.stringify(normalized));
}

export function loadStoredControlUiDemoAccessPolicy(): ControlUiBootstrapAccessPolicy | null {
  const storage = readSessionStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeStoredAccessPolicy(parsed);
    if (!normalized) {
      storage.removeItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY);
      return null;
    }
    return normalized;
  } catch {
    storage.removeItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY);
    return null;
  }
}
