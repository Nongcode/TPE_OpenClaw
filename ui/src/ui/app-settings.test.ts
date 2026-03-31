import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBootstrapAccessPolicy,
  applyResolvedTheme,
  applySettings,
  applySettingsFromUrl,
  attachThemeListener,
  setTabFromRoute,
  syncThemeWithSettings,
} from "./app-settings.ts";
import type { ControlUiBootstrapAccessPolicy } from "../../../src/gateway/control-ui-contract.js";
import type { ThemeMode, ThemeName } from "./theme.ts";

type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: ThemeName;
    themeMode: ThemeMode;
    chatFocusMode: boolean;
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
    splitRatio: number;
    navCollapsed: boolean;
    navWidth: number;
    navGroupsCollapsed: Record<string, boolean>;
  };
  theme: ThemeName & ThemeMode;
  themeMode: ThemeMode;
  themeResolved: import("./theme.ts").ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  lockedAgentId?: string | null;
  lockedSessionKey?: string | null;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  bootstrapAccessPolicy?: ControlUiBootstrapAccessPolicy | null;
};

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
  },
  theme: "claw" as unknown as ThemeName & ThemeMode,
  themeMode: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  lockedAgentId: null,
  lockedSessionKey: null,
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
  pendingGatewayUrl: null,
  pendingGatewayToken: null,
  bootstrapAccessPolicy: null,
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });

  it("redirects worker roles away from the sessions tab", () => {
    const host = createHost("chat");
    host.bootstrapAccessPolicy = {
      employeeId: "emp-01",
      employeeName: "Lan",
      lockedAgentId: "nv_content",
      lockedSessionKey: "agent:nv_content:main",
      visibleAgentIds: ["nv_content"],
      lockSession: true,
      enforcedByServer: true,
    };
    window.history.replaceState({}, "", "/sessions?employeeId=emp-01");

    setTabFromRoute(host, "sessions");

    expect(host.tab).toBe("chat");
    expect(window.location.pathname).toBe("/chat");
  });

  it("re-resolves the active palette when only themeMode changes", () => {
    const host = createHost("chat");
    host.settings.theme = "knot";
    host.settings.themeMode = "dark";
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "dark";
    host.themeResolved = "openknot";

    applySettings(host, {
      ...host.settings,
      themeMode: "light",
    });

    expect(host.theme).toBe("knot");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("openknot-light");
  });

  it("syncs both theme family and mode from persisted settings", () => {
    const host = createHost("chat");
    host.settings.theme = "dash";
    host.settings.themeMode = "light";

    syncThemeWithSettings(host);

    expect(host.theme).toBe("dash");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("dash-light");
  });

  it("applies named system themes on OS preference changes", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_name: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const host = createHost("chat");
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "system";

    attachThemeListener(host);
    listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");

    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");
  });

  it("normalizes light family themes to the shared light CSS token", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    applyResolvedTheme(host, "dash-light");

    expect(host.themeResolved).toBe("dash-light");
    expect(root.dataset.theme).toBe("dash-light");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("applySettingsFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/chat");
  });

  it("resets stale persisted session selection to main when a token is supplied without a session", () => {
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    window.history.replaceState({}, "", "/chat#token=test-token");

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("main");
    expect(host.settings.sessionKey).toBe("main");
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("preserves an explicit session from the URL when token and session are both supplied", () => {
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    window.history.replaceState({}, "", "/chat?session=agent%3Atest_new%3Amain#token=test-token");

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_new:main");
  });

  it("does not reset the current gateway session when a different gateway is pending confirmation", () => {
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://gateway-a.example:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    window.history.replaceState(
      {},
      "",
      "/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789#token=test-token",
    );

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_old:main");
    expect(host.pendingGatewayUrl).toBe("ws://gateway-b.example:18789");
    expect(host.pendingGatewayToken).toBe("test-token");
  });

  it("locks a tab to an agent main session derived from the URL", () => {
    const host = createHost("chat");

    window.history.replaceState({}, "", "/chat?agent=quan_ly&lockSession=1");

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:quan_ly:main");
    expect(host.settings.sessionKey).toBe("agent:quan_ly:main");
    expect(host.lockedSessionKey).toBe("agent:quan_ly:main");
    expect(host.lockedAgentId).toBe("quan_ly");
  });

  it("prefers the agent lock when the URL session points at a different agent", () => {
    const host = createHost("chat");

    window.history.replaceState(
      {},
      "",
      "/chat?agent=pho_phong&session=agent%3Anv_content%3Amain&lockAgent=1",
    );

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:pho_phong:main");
    expect(host.lockedAgentId).toBe("pho_phong");
    expect(host.lockedSessionKey).toBeNull();
  });
});

describe("applyBootstrapAccessPolicy", () => {
  it("lets server-enforced employee policy override a conflicting URL lock", () => {
    const host = createHost("chat");
    host.bootstrapAccessPolicy = {
      employeeId: "emp-01",
      employeeName: "Lan",
      lockedAgentId: "nv_content",
      lockedSessionKey: "agent:nv_content:main",
      lockSession: true,
      enforcedByServer: true,
    };

    window.history.replaceState({}, "", "/chat?agent=quan_ly&lockSession=1");

    applyBootstrapAccessPolicy(host);

    expect(host.sessionKey).toBe("agent:nv_content:main");
    expect(host.lockedSessionKey).toBe("agent:nv_content:main");
    expect(host.lockedAgentId).toBe("nv_content");
  });

  it("keeps supervisors on their home session without hard-locking session switching", () => {
    const host = createHost("chat");
    host.bootstrapAccessPolicy = {
      employeeId: "tp-01",
      employeeName: "Truong Phong",
      lockedAgentId: "truong_phong",
      lockedSessionKey: "agent:truong_phong:main",
      visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"],
      lockSession: true,
      enforcedByServer: true,
    };

    applyBootstrapAccessPolicy(host);

    expect(host.sessionKey).toBe("agent:truong_phong:main");
    expect(host.lockedSessionKey).toBeNull();
    expect(host.lockedAgentId).toBeNull();
  });

  it("releases URL lock flags when the bootstrap policy allows manager-wide visibility", () => {
    const host = createHost("chat");
    host.bootstrapAccessPolicy = {
      employeeId: "boss-01",
      employeeName: "Sep Long",
      lockedAgentId: "quan_ly",
      lockedSessionKey: "agent:quan_ly:main",
      lockAgent: true,
      lockSession: true,
      canViewAllSessions: true,
      enforcedByServer: false,
    };

    window.history.replaceState(
      {},
      "",
      "/chat?employeeId=sep_long%40example.com&session=agent%3Aquan_ly%3Amain&agent=quan_ly&lockSession=1&lockAgent=1",
    );

    applyBootstrapAccessPolicy(host);

    expect(host.sessionKey).toBe("agent:quan_ly:main");
    expect(host.lockedSessionKey).toBeNull();
    expect(host.lockedAgentId).toBeNull();
  });
});
