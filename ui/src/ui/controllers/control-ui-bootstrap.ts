import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapAccessPolicy,
  type ControlUiBootstrapConfig,
  type ControlUiDemoLoginConfig,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import { normalizeBasePath } from "../navigation.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  bootstrapAccessPolicy?: ControlUiBootstrapAccessPolicy | null;
  demoLoginConfig?: ControlUiDemoLoginConfig | null;
};

export async function loadControlUiBootstrapConfig(state: ControlUiBootstrapState) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }

  const basePath = normalizeBasePath(state.basePath ?? "");
  const endpoint = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  const current = new URL(window.location.href);
  const url = new URL(endpoint, current.origin);
  const passthroughKeys = [
    "agent",
    "session",
    "lockAgent",
    "lockSession",
    "employeeId",
    "employeeName",
    "autoConnect",
  ];
  for (const key of passthroughKeys) {
    const value = current.searchParams.get(key);
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  if (current.hash.startsWith("#")) {
    const hashParams = new URLSearchParams(current.hash.slice(1));
    for (const key of passthroughKeys) {
      const value = hashParams.get(key);
      if (value && !url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
  }
  const requestUrl = `${url.pathname}${url.search}`;

  try {
    const res = await fetch(requestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      return;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    const normalized = normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId ?? null,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar ?? null,
    });
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
    state.serverVersion = parsed.serverVersion ?? null;
    state.bootstrapAccessPolicy = parsed.accessPolicy ?? null;
    state.demoLoginConfig = parsed.demoLogin ?? null;
  } catch {
    // Ignore bootstrap failures; UI will update identity after connecting.
  }
}
