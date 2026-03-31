import {
  CONTROL_UI_LOGIN_PATH,
  type ControlUiLoginResponse,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeBasePath } from "../navigation.ts";

export async function loginWithControlUiDemo(params: {
  basePath: string;
  email: string;
  password: string;
}): Promise<ControlUiLoginResponse> {
  const basePath = normalizeBasePath(params.basePath ?? "");
  const endpoint = basePath ? `${basePath}${CONTROL_UI_LOGIN_PATH}` : CONTROL_UI_LOGIN_PATH;
  const current = new URL(window.location.href);
  const url = new URL(endpoint, current.origin);
  const res = await fetch(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify({
      email: params.email,
      password: params.password,
    }),
  });
  const parsed = (await res.json().catch(() => null)) as
    | ControlUiLoginResponse
    | { error?: { message?: string } }
    | null;
  if (!res.ok) {
    throw new Error((parsed as any)?.error?.message || "Demo login failed");
  }
  if (!parsed || !("ok" in parsed) || parsed.ok !== true) {
    throw new Error("Demo login failed");
  }
  return parsed;
}
