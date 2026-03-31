import type { ControlUiBootstrapAccessPolicy } from "../../../src/gateway/control-ui-contract.js";
import type { Tab } from "./navigation.ts";

function normalizeAgentId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function uniqueAgentIds(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeAgentId(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function resolveVisibleControlUiAgentIds(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
): string[] {
  if (!policy) {
    return [];
  }
  const visible = uniqueAgentIds(policy.visibleAgentIds ?? []);
  if (visible.length > 0) {
    return visible;
  }
  const lockedAgentId = normalizeAgentId(policy.lockedAgentId);
  return lockedAgentId ? [lockedAgentId] : [];
}

export function canViewAllControlUiSessions(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
): boolean {
  return policy?.canViewAllSessions === true;
}

export function canBrowseMultipleControlUiSessions(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  if (canViewAllControlUiSessions(policy)) {
    return true;
  }
  return resolveVisibleControlUiAgentIds(policy).length > 1;
}

export function shouldApplyStrictControlUiLock(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
): boolean {
  if (!policy) {
    return false;
  }
  return !canBrowseMultipleControlUiSessions(policy);
}

export function canAccessControlUiAgentId(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
  agentId: string | null | undefined,
): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) {
    return false;
  }
  if (!policy) {
    return true;
  }
  if (canViewAllControlUiSessions(policy)) {
    return true;
  }
  return resolveVisibleControlUiAgentIds(policy).includes(normalizedAgentId);
}

export function canAccessControlUiSessionKey(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
  sessionKey: string | null | undefined,
): boolean {
  const normalizedSessionKey = sessionKey?.trim().toLowerCase() ?? "";
  if (!normalizedSessionKey) {
    return false;
  }
  if (!policy) {
    return true;
  }
  if (canViewAllControlUiSessions(policy)) {
    return true;
  }
  const parts = normalizedSessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return canAccessControlUiAgentId(policy, parts[1]);
  }
  return false;
}

export function shouldShowControlUiTab(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
  tab: Tab,
): boolean {
  if (tab !== "sessions") {
    return true;
  }
  return canBrowseMultipleControlUiSessions(policy);
}
