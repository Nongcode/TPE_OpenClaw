import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { ControlUiBootstrapAccessPolicy } from "./control-ui-contract.js";

type EmployeeDirectoryEntry = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["gateway"]>["controlUi"]>["employeeDirectory"]
> extends Array<infer Entry>
  ? Entry
  : never;

type SessionVisibility = Pick<
  ControlUiBootstrapAccessPolicy,
  "canViewAllSessions" | "visibleAgentIds"
>;

function normalizeEmployeeKey(raw: string | null | undefined): string | undefined {
  const value =
    raw
      ?.normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase() ?? "";
  return value || undefined;
}

function normalizeManagerInstanceId(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(value) ? value : undefined;
}

export function normalizeBootstrapAgentId(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : undefined;
}

export function normalizeBootstrapSessionKey(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toLowerCase() ?? "";
  return value || undefined;
}

function resolveDefaultVisibilityForLockedAgent(lockedAgentId: string): SessionVisibility {
  switch (lockedAgentId) {
    case "main":
    case "quan_ly":
      return { canViewAllSessions: true };
    case "truong_phong":
      return { visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"] };
    case "pho_phong":
      return { visibleAgentIds: ["pho_phong", "nv_content", "nv_media"] };
    default:
      return { visibleAgentIds: [lockedAgentId] };
  }
}

function dedupeAgentIds(agentIds: Array<string | undefined | null>): string[] {
  const deduped = new Set<string>();
  for (const agentId of agentIds) {
    const normalized = normalizeBootstrapAgentId(agentId ?? undefined);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

export function resolveControlUiSessionVisibility(params: {
  lockedAgentId: string;
  canViewAllSessions?: boolean;
  visibleAgentIds?: string[] | null;
}): SessionVisibility {
  if (params.canViewAllSessions === true) {
    return { canViewAllSessions: true };
  }
  const explicitAgentIds = dedupeAgentIds(params.visibleAgentIds ?? []);
  if (explicitAgentIds.length > 0) {
    return {
      visibleAgentIds: dedupeAgentIds([params.lockedAgentId, ...explicitAgentIds]),
    };
  }
  return resolveDefaultVisibilityForLockedAgent(params.lockedAgentId);
}

export function resolveDirectoryAccessPolicy(params: {
  config?: OpenClawConfig;
  employeeId?: string;
  employeeName?: string;
}): ControlUiBootstrapAccessPolicy | undefined {
  const entries = params.config?.gateway?.controlUi?.employeeDirectory;
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const requestedEmployeeId = normalizeEmployeeKey(params.employeeId);
  const requestedEmployeeName = normalizeEmployeeKey(params.employeeName);
  if (!requestedEmployeeId && !requestedEmployeeName) {
    return undefined;
  }

  for (const entry of entries) {
    const candidateIds = [
      normalizeEmployeeKey(entry.employeeId),
      normalizeEmployeeKey(entry.employeeName),
      ...(Array.isArray(entry.aliases)
        ? entry.aliases.map((alias) => normalizeEmployeeKey(alias))
        : []),
    ].filter((value): value is string => Boolean(value));
    const matches =
      (requestedEmployeeId && candidateIds.includes(requestedEmployeeId)) ||
      (requestedEmployeeName && candidateIds.includes(requestedEmployeeName));
    if (!matches) {
      continue;
    }
    return buildDirectoryAccessPolicy(entry, params);
  }

  return undefined;
}

function buildDirectoryAccessPolicy(
  entry: EmployeeDirectoryEntry,
  fallbackIdentity: { employeeId?: string; employeeName?: string },
): ControlUiBootstrapAccessPolicy {
  const lockedAgentId = normalizeBootstrapAgentId(entry.lockedAgentId) ?? "main";
  const lockedSessionKey =
    normalizeBootstrapSessionKey(entry.lockedSessionKey ?? null) ?? `agent:${lockedAgentId}:main`;
  const visibility = resolveControlUiSessionVisibility({
    lockedAgentId,
    canViewAllSessions: entry.canViewAllSessions === true,
    visibleAgentIds: entry.visibleAgentIds,
  });
  const employeeId = entry.employeeId?.trim() || fallbackIdentity.employeeId;
  const employeeName = entry.employeeName?.trim() || fallbackIdentity.employeeName;
  const managerInstanceId = normalizeManagerInstanceId(entry.managerInstanceId);
  return {
    employeeId: employeeId || undefined,
    employeeName: employeeName || undefined,
    managerInstanceId,
    lockedAgentId,
    lockedSessionKey,
    lockAgent: entry.lockAgent === true || entry.lockSession === true,
    lockSession: entry.lockSession === true,
    autoConnect: entry.autoConnect === true,
    enforcedByServer: true,
    canViewAllSessions: visibility.canViewAllSessions === true,
    visibleAgentIds: visibility.visibleAgentIds,
  };
}

export function buildClientDeclaredAccessPolicy(params: {
  employeeId?: string;
  employeeName?: string;
  managerInstanceId?: string;
  lockedAgentId?: string;
  lockedSessionKey?: string;
  canViewAllSessions?: boolean;
  visibleAgentIds?: string[] | null;
  lockAgent?: boolean;
  lockSession?: boolean;
  autoConnect?: boolean;
}): ControlUiBootstrapAccessPolicy | undefined {
  const lockedAgentId = normalizeBootstrapAgentId(params.lockedAgentId);
  const lockedSessionKey =
    normalizeBootstrapSessionKey(params.lockedSessionKey) ??
    (lockedAgentId ? `agent:${lockedAgentId}:main` : undefined);
  if (
    !lockedAgentId &&
    !lockedSessionKey &&
    !params.employeeId &&
    !params.employeeName &&
    !params.managerInstanceId
  ) {
    return undefined;
  }
  const resolvedLockedAgentId =
    lockedAgentId ??
    normalizeBootstrapAgentId(parseAgentSessionKey(lockedSessionKey ?? "")?.agentId ?? undefined);
  if (!resolvedLockedAgentId) {
    return undefined;
  }
  const visibility = resolveControlUiSessionVisibility({
    lockedAgentId: resolvedLockedAgentId,
    canViewAllSessions: params.canViewAllSessions,
    visibleAgentIds: params.visibleAgentIds,
  });
  return {
    employeeId: params.employeeId?.trim() || undefined,
    employeeName: params.employeeName?.trim() || undefined,
    managerInstanceId: normalizeManagerInstanceId(params.managerInstanceId),
    lockedAgentId: resolvedLockedAgentId,
    lockedSessionKey: lockedSessionKey ?? `agent:${resolvedLockedAgentId}:main`,
    lockAgent: params.lockAgent === true || params.lockSession === true,
    lockSession: params.lockSession === true,
    autoConnect: params.autoConnect === true,
    enforcedByServer: false,
    canViewAllSessions: visibility.canViewAllSessions === true,
    visibleAgentIds: visibility.visibleAgentIds,
  };
}

export function canControlUiAccessSessionKey(
  policy: ControlUiBootstrapAccessPolicy | null | undefined,
  key: string | null | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.canViewAllSessions === true) {
    return true;
  }
  const normalizedKey = normalizeBootstrapSessionKey(key);
  if (!normalizedKey) {
    return false;
  }
  if (policy.lockedSessionKey && normalizedKey === policy.lockedSessionKey) {
    return true;
  }
  const agentId = normalizeAgentId(parseAgentSessionKey(normalizedKey)?.agentId ?? "");
  if (!agentId) {
    return false;
  }
  const visibleAgentIds = dedupeAgentIds([
    policy.lockedAgentId,
    ...(policy.visibleAgentIds ?? []),
  ]);
  return visibleAgentIds.includes(agentId);
}
