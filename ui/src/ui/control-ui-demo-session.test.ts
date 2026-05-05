/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_UI_DEMO_LOGIN_POLICY_KEY,
  CONTROL_UI_DEMO_LOGIN_SESSION_KEY,
  isControlUiDemoLoginUnlocked,
  loadStoredControlUiDemoAccessPolicy,
  storeControlUiDemoLoginState,
} from "./control-ui-demo-session.ts";

describe("control-ui demo session storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("stores unlock marker and access policy for demo login", () => {
    storeControlUiDemoLoginState({
      employeeId: "tp-01",
      employeeName: "Truong Phong",
      managerInstanceId: "mgr_pho_phong_A",
      lockedAgentId: "truong_phong",
      lockedSessionKey: "agent:truong_phong:main",
      visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"],
      lockSession: true,
      enforcedByServer: true,
    });

    expect(window.sessionStorage.getItem(CONTROL_UI_DEMO_LOGIN_SESSION_KEY)).toBe("1");
    expect(loadStoredControlUiDemoAccessPolicy()).toEqual({
      employeeId: "tp-01",
      employeeName: "Truong Phong",
      managerInstanceId: "mgr_pho_phong_A",
      lockedAgentId: "truong_phong",
      lockedSessionKey: "agent:truong_phong:main",
      visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"],
      lockSession: true,
      enforcedByServer: true,
    });
    expect(isControlUiDemoLoginUnlocked()).toBe(true);
  });

  it("drops invalid stored policy payloads", () => {
    window.sessionStorage.setItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY, "{bad json");

    expect(loadStoredControlUiDemoAccessPolicy()).toBeNull();
    expect(window.sessionStorage.getItem(CONTROL_UI_DEMO_LOGIN_POLICY_KEY)).toBeNull();
  });
});
