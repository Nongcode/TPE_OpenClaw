export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";
export const CONTROL_UI_LOGIN_PATH = "/__openclaw/control-ui-login";

export type ControlUiBootstrapAccessPolicy = {
  employeeId?: string;
  employeeName?: string;
  lockedAgentId?: string;
  lockedSessionKey?: string;
  canViewAllSessions?: boolean;
  visibleAgentIds?: string[];
  lockAgent?: boolean;
  lockSession?: boolean;
  autoConnect?: boolean;
  enforcedByServer?: boolean;
};

export type ControlUiDemoLoginAccount = {
  email: string;
  label?: string;
  employeeId?: string;
  employeeName?: string;
  lockedAgentId?: string;
};

export type ControlUiDemoLoginConfig = {
  enabled: boolean;
  accounts: ControlUiDemoLoginAccount[];
};

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
  serverVersion?: string;
  accessPolicy?: ControlUiBootstrapAccessPolicy;
  demoLogin?: ControlUiDemoLoginConfig;
};

export type ControlUiLoginRequest = {
  email?: string;
  password?: string;
};

export type ControlUiLoginResponse = {
  ok: true;
  gatewayUrl?: string;
  token?: string;
  accessPolicy?: ControlUiBootstrapAccessPolicy;
};
