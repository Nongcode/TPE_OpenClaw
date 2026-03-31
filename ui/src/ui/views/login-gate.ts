import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { renderThemeToggle } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);
  const employeeName = state.bootstrapAccessPolicy?.employeeName?.trim() || null;
  const lockedAgentId = state.bootstrapAccessPolicy?.lockedAgentId?.trim() || state.lockedAgentId;
  const lockedSessionKey =
    state.bootstrapAccessPolicy?.lockedSessionKey?.trim() || state.lockedSessionKey;
  const demoLoginEnabled = state.demoLoginConfig?.enabled === true;
  const demoAccounts = state.demoLoginConfig?.accounts ?? [];

  return html`
    <div class="login-gate">
      <div class="login-gate__theme">${renderThemeToggle(state)}</div>
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">OpenClaw</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
        </div>
        ${
          employeeName || lockedAgentId || lockedSessionKey
            ? html`
                <div class="callout" style="margin-bottom: 14px;">
                  ${employeeName ? html`<div><strong>Employee:</strong> ${employeeName}</div>` : ""}
                  ${lockedAgentId ? html`<div><strong>Assigned agent:</strong> ${lockedAgentId}</div>` : ""}
                  ${
                    lockedSessionKey
                      ? html`<div><strong>Locked session:</strong> <code>${lockedSessionKey}</code></div>`
                      : ""
                  }
                </div>
              `
            : ""
        }
        ${
          demoLoginEnabled
            ? html`
                <div class="login-gate__form">
                  <label class="field">
                    <span>Email</span>
                    <input
                      type="email"
                      autocomplete="username"
                      spellcheck="false"
                      .value=${state.demoLoginEmail}
                      @input=${(e: Event) => {
                        state.demoLoginEmail = (e.target as HTMLInputElement).value;
                      }}
                      placeholder="quanly@example.com"
                    />
                  </label>
                  <label class="field">
                    <span>${t("overview.access.password")}</span>
                    <div class="login-gate__secret-row">
                      <input
                        type=${state.loginShowGatewayPassword ? "text" : "password"}
                        autocomplete="current-password"
                        spellcheck="false"
                        .value=${state.demoLoginPassword}
                        @input=${(e: Event) => {
                          state.demoLoginPassword = (e.target as HTMLInputElement).value;
                        }}
                        placeholder="${t("login.passwordPlaceholder")}"
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "Enter") {
                            void state.handleDemoLogin();
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="btn btn--icon ${state.loginShowGatewayPassword ? "active" : ""}"
                        title=${state.loginShowGatewayPassword ? "Hide password" : "Show password"}
                        aria-label="Toggle password visibility"
                        aria-pressed=${state.loginShowGatewayPassword}
                        @click=${() => {
                          state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
                        }}
                      >
                        ${state.loginShowGatewayPassword ? icons.eye : icons.eyeOff}
                      </button>
                    </div>
                  </label>
                  <button
                    class="btn primary login-gate__connect"
                    ?disabled=${state.demoLoginBusy}
                    @click=${() => void state.handleDemoLogin()}
                  >
                    ${state.demoLoginBusy ? "Signing in..." : "Sign in"}
                  </button>
                  ${
                    demoAccounts.length > 0
                      ? html`
                          <div class="callout" style="margin-top: 14px;">
                            <div><strong>Sample accounts</strong></div>
                            ${demoAccounts.map(
                              (account) => html`
                                <button
                                  type="button"
                                  class="session-link"
                                  style="display:block; margin-top:8px; text-align:left; border:none; background:none; padding:0;"
                                  @click=${() => {
                                    state.demoLoginEmail = account.email;
                                  }}
                                >
                                  ${account.label || account.lockedAgentId || account.employeeName || account.email}
                                  <span style="opacity:0.75;"> - ${account.email}</span>
                                </button>
                              `,
                            )}
                          </div>
                        `
                      : ""
                  }
                </div>
              `
            : html`
                <div class="login-gate__form">
                  <label class="field">
                    <span>${t("overview.access.wsUrl")}</span>
                    <input
                      .value=${state.settings.gatewayUrl}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        state.applySettings({ ...state.settings, gatewayUrl: v });
                      }}
                      placeholder="ws://127.0.0.1:18789"
                    />
                  </label>
                  <label class="field">
                    <span>${t("overview.access.token")}</span>
                    <div class="login-gate__secret-row">
                      <input
                        type=${state.loginShowGatewayToken ? "text" : "password"}
                        autocomplete="off"
                        spellcheck="false"
                        .value=${state.settings.token}
                        @input=${(e: Event) => {
                          const v = (e.target as HTMLInputElement).value;
                          state.applySettings({ ...state.settings, token: v });
                        }}
                        placeholder="OPENCLAW_GATEWAY_TOKEN (${t("login.passwordPlaceholder")})"
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "Enter") {
                            state.connect();
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="btn btn--icon ${state.loginShowGatewayToken ? "active" : ""}"
                        title=${state.loginShowGatewayToken ? "Hide token" : "Show token"}
                        aria-label="Toggle token visibility"
                        aria-pressed=${state.loginShowGatewayToken}
                        @click=${() => {
                          state.loginShowGatewayToken = !state.loginShowGatewayToken;
                        }}
                      >
                        ${state.loginShowGatewayToken ? icons.eye : icons.eyeOff}
                      </button>
                    </div>
                  </label>
                  <label class="field">
                    <span>${t("overview.access.password")}</span>
                    <div class="login-gate__secret-row">
                      <input
                        type=${state.loginShowGatewayPassword ? "text" : "password"}
                        autocomplete="off"
                        spellcheck="false"
                        .value=${state.password}
                        @input=${(e: Event) => {
                          const v = (e.target as HTMLInputElement).value;
                          state.password = v;
                        }}
                        placeholder="${t("login.passwordPlaceholder")}"
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "Enter") {
                            state.connect();
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="btn btn--icon ${state.loginShowGatewayPassword ? "active" : ""}"
                        title=${state.loginShowGatewayPassword ? "Hide password" : "Show password"}
                        aria-label="Toggle password visibility"
                        aria-pressed=${state.loginShowGatewayPassword}
                        @click=${() => {
                          state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
                        }}
                      >
                        ${state.loginShowGatewayPassword ? icons.eye : icons.eyeOff}
                      </button>
                    </div>
                  </label>
                  <button
                    class="btn primary login-gate__connect"
                    @click=${() => state.connect()}
                  >
                    ${t("common.connect")}
                  </button>
                </div>
              `
        }
        ${
          state.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
                <div>${state.lastError}</div>
              </div>`
            : ""
        }
        <div class="login-gate__help">
          <div class="login-gate__help-title">${t("overview.connection.title")}</div>
          <ol class="login-gate__steps">
            <li>${t("overview.connection.step1")}<code>openclaw gateway run</code></li>
            <li>${t("overview.connection.step2")}<code>openclaw dashboard --no-open</code></li>
            <li>${t("overview.connection.step3")}</li>
          </ol>
          <div class="login-gate__docs">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
            >${t("overview.connection.docsLink")}</a>
          </div>
        </div>
      </div>
    </div>
  `;
}
