import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  isPackageProvenControlUiRootSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isWithinDir } from "../infra/path-safety.js";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import { authorizeTrustedProxy, type ResolvedGatewayAuth } from "./auth.js";
import {
  buildClientDeclaredAccessPolicy,
  normalizeBootstrapAgentId,
  normalizeBootstrapSessionKey,
  resolveDirectoryAccessPolicy,
} from "./control-ui-access.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_LOGIN_PATH,
  type ControlUiDemoLoginConfig,
  type ControlUiBootstrapAccessPolicy,
  type ControlUiBootstrapConfig,
  type ControlUiLoginRequest,
  type ControlUiLoginResponse,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { readJsonBodyOrError, sendMethodNotAllowed } from "./http-common.js";
import { classifyControlUiRequest } from "./control-ui-routing.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  agentId?: string;
  root?: ControlUiRootState;
  resolvedAuth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
};

export type ControlUiRootState =
  | { kind: "bundled"; path: string }
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Extensions recognised as static assets.  Missing files with these extensions
 * return 404 instead of the SPA index.html fallback.  `.html` is intentionally
 * excluded — actual HTML files on disk are served earlier, and missing `.html`
 * paths should fall through to the SPA router (client-side routers may use
 * `.html`-suffixed routes).
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
]);

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function respondControlUiAssetsUnavailable(
  res: ServerResponse,
  options?: { configuredRootPath?: string },
) {
  if (options?.configuredRootPath) {
    respondPlainText(
      res,
      503,
      `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return;
  }
  respondPlainText(res, 503, CONTROL_UI_ASSETS_MISSING_MESSAGE);
}

function respondHeadForFile(req: IncomingMessage, res: ServerResponse, filePath: string): boolean {
  if (req.method !== "HEAD") {
    return false;
  }
  res.statusCode = 200;
  setStaticFileHeaders(res, filePath);
  res.end();
  return true;
}

function parseBooleanFlag(raw: string | null): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeDemoEmail(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toLowerCase() ?? "";
  return value || undefined;
}

function resolveControlUiDemoLoginConfig(
  config?: OpenClawConfig,
): ControlUiDemoLoginConfig | undefined {
  const demoLogin = config?.gateway?.controlUi?.demoLogin;
  if (!demoLogin?.enabled) {
    return undefined;
  }
  const accounts =
    demoLogin.accounts
      ?.map((entry) => {
        const email = normalizeDemoEmail(entry.email);
        if (!email) {
          return null;
        }
        return {
          email,
          label: entry.label?.trim() || undefined,
          employeeId: entry.employeeId?.trim() || undefined,
          employeeName: entry.employeeName?.trim() || undefined,
          lockedAgentId: normalizeBootstrapAgentId(entry.lockedAgentId) ?? undefined,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) ?? [];
  return {
    enabled: true,
    accounts,
  };
}

function resolveControlUiDemoLoginResult(params: {
  config?: OpenClawConfig;
  email?: string;
  password?: string;
}): ControlUiLoginResponse | undefined {
  const demoLogin = params.config?.gateway?.controlUi?.demoLogin;
  if (!demoLogin?.enabled || !Array.isArray(demoLogin.accounts) || demoLogin.accounts.length === 0) {
    return undefined;
  }
  const requestedEmail = normalizeDemoEmail(params.email);
  const requestedPassword = params.password?.trim();
  if (!requestedEmail || !requestedPassword) {
    return undefined;
  }
  const matched = demoLogin.accounts.find((entry) => {
    const candidateEmail = normalizeDemoEmail(entry.email);
    const candidatePassword = entry.password?.trim();
    return candidateEmail === requestedEmail && candidatePassword === requestedPassword;
  });
  if (!matched) {
    return undefined;
  }

  const accessPolicy =
    resolveDirectoryAccessPolicy({
      config: params.config,
      employeeId: matched.employeeId,
      employeeName: matched.employeeName,
    }) ??
    buildClientDeclaredAccessPolicy({
      employeeId: matched.employeeId,
      employeeName: matched.employeeName,
      lockedAgentId: matched.lockedAgentId,
      lockedSessionKey: matched.lockedSessionKey,
      lockAgent: true,
      lockSession: true,
    });

  return {
    ok: true,
    token: normalizeSecretInputString(params.config?.gateway?.auth?.token) || undefined,
    accessPolicy,
  };
}

function resolveTrustedProxyEmployeeIdentity(params: {
  req: IncomingMessage;
  resolvedAuth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
}): { employeeId?: string; employeeName?: string } | undefined {
  if (params.resolvedAuth?.mode !== "trusted-proxy" || !params.resolvedAuth.trustedProxy) {
    return undefined;
  }
  const result = authorizeTrustedProxy({
    req: params.req,
    trustedProxies: params.trustedProxies,
    trustedProxyConfig: params.resolvedAuth.trustedProxy,
  });
  if (!("user" in result)) {
    return undefined;
  }
  const employeeId = result.user.trim() || undefined;
  if (!employeeId) {
    return undefined;
  }
  return {
    employeeId,
    employeeName: result.displayName?.trim() || employeeId,
  };
}

function resolveBootstrapAccessPolicy(params: {
  req: IncomingMessage;
  url: URL;
  config?: OpenClawConfig;
  resolvedAuth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
}): ControlUiBootstrapAccessPolicy | undefined {
  const trustedProxyIdentity = resolveTrustedProxyEmployeeIdentity({
    req: params.req,
    resolvedAuth: params.resolvedAuth,
    trustedProxies: params.trustedProxies,
  });
  const employeeId =
    trustedProxyIdentity?.employeeId ??
    params.url.searchParams.get("employeeId")?.trim() ??
    undefined;
  const employeeName =
    trustedProxyIdentity?.employeeName ??
    params.url.searchParams.get("employeeName")?.trim() ??
    undefined;
  const directoryPolicy = resolveDirectoryAccessPolicy({
    config: params.config,
    employeeId,
    employeeName,
  });
  if (directoryPolicy) {
    return directoryPolicy;
  }

  const url = params.url;
  const lockedAgentId = normalizeBootstrapAgentId(url.searchParams.get("agent"));
  const lockedSessionKey =
    normalizeBootstrapSessionKey(url.searchParams.get("session")) ??
    (lockedAgentId ? `agent:${lockedAgentId}:main` : undefined);
  const lockSession = parseBooleanFlag(url.searchParams.get("lockSession"));
  const lockAgent = parseBooleanFlag(url.searchParams.get("lockAgent")) || lockSession;
  const autoConnect = parseBooleanFlag(url.searchParams.get("autoConnect"));

  if (
    !employeeId &&
    !employeeName &&
    !lockedAgentId &&
    !lockedSessionKey &&
    !lockAgent &&
    !lockSession &&
    !autoConnect
  ) {
    return undefined;
  }

  return buildClientDeclaredAccessPolicy({
    employeeId,
    employeeName,
    lockedAgentId,
    lockedSessionKey,
    canViewAllSessions: lockedAgentId === "main" || lockedAgentId === "quan_ly",
    autoConnect,
    lockAgent,
    lockSession,
  });
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (!isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondControlUiNotFound(res);
    return true;
  }

  const safeAvatar = resolveSafeAvatarFile(resolved.filePath);
  if (!safeAvatar) {
    respondControlUiNotFound(res);
    return true;
  }
  try {
    if (respondHeadForFile(req, res, safeAvatar.path)) {
      return true;
    }

    serveResolvedFile(res, safeAvatar.path, fs.readFileSync(safeAvatar.fd));
    return true;
  } finally {
    fs.closeSync(safeAvatar.fd);
  }
}

function setStaticFileHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
}

function serveResolvedFile(res: ServerResponse, filePath: string, body: Buffer) {
  setStaticFileHeaders(res, filePath);
  res.end(body);
}

function serveResolvedIndexHtml(res: ServerResponse, body: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function resolveSafeAvatarFile(filePath: string): { path: string; fd: number } | null {
  const opened = openVerifiedFileSync({
    filePath,
    rejectPathSymlink: true,
    maxBytes: AVATAR_MAX_BYTES,
  });
  if (!opened.ok) {
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
  rejectHardlinks: boolean,
): { path: string; fd: number } | null {
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    rejectHardlinks,
  });
  if (!opened.ok) {
    if (opened.reason === "io") {
      throw opened.error;
    }
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
  });
  if (route.kind === "not-control-ui") {
    return false;
  }
  if (route.kind === "not-found") {
    applyControlUiSecurityHeaders(res);
    respondControlUiNotFound(res);
    return true;
  }
  if (route.kind === "redirect") {
    applyControlUiSecurityHeaders(res);
    res.statusCode = 302;
    res.setHeader("Location", route.location);
    res.end();
    return true;
  }

  applyControlUiSecurityHeaders(res);

  const bootstrapConfigPath = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  const loginPath = basePath ? `${basePath}${CONTROL_UI_LOGIN_PATH}` : CONTROL_UI_LOGIN_PATH;
  if (pathname === bootstrapConfigPath) {
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarValue = resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: identity.agentId,
      basePath,
    });
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue ?? identity.avatar,
      assistantAgentId: identity.agentId,
      serverVersion: resolveRuntimeServiceVersion(process.env),
      accessPolicy: resolveBootstrapAccessPolicy({
        req,
        url,
        config,
        resolvedAuth: opts?.resolvedAuth,
        trustedProxies: opts?.trustedProxies,
      }),
      demoLogin: resolveControlUiDemoLoginConfig(config),
    } satisfies ControlUiBootstrapConfig);
    return true;
  }

  if (pathname === loginPath) {
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return true;
    }
    void (async () => {
      const body = await readJsonBodyOrError(req, res, 16 * 1024);
      if (!body) {
        return;
      }
      const payload = body as ControlUiLoginRequest;
      const loginResult = resolveControlUiDemoLoginResult({
        config: opts?.config,
        email: payload.email,
        password: payload.password,
      });
      if (!loginResult) {
        sendJson(res, 401, {
          error: { message: "Invalid email or password", type: "unauthorized" },
        });
        return;
      }
      sendJson(res, 200, loginResult);
    })().catch(() => {
      if (!res.writableEnded) {
        sendJson(res, 500, {
          error: { message: "Internal server error", type: "server_error" },
        });
      }
    });
    return true;
  }

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    respondControlUiAssetsUnavailable(res, { configuredRootPath: rootState.path });
    return true;
  }
  if (rootState?.kind === "missing") {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const root =
    rootState?.kind === "resolved" || rootState?.kind === "bundled"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if (isExpectedSafePathError(error)) {
        return null;
      }
      throw error;
    }
  })();
  if (!rootReal) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }

  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot =
    rootState?.kind === "bundled" ||
    (rootState === undefined &&
      isPackageProvenControlUiRootSync(root, {
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      }));
  const rejectHardlinks = !isBundledRoot;
  const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (safeFile) {
    try {
      if (respondHeadForFile(req, res, safeFile.path)) {
        return true;
      }
      if (path.basename(safeFile.path) === "index.html") {
        serveResolvedIndexHtml(res, fs.readFileSync(safeFile.fd, "utf8"));
        return true;
      }
      serveResolvedFile(res, safeFile.path, fs.readFileSync(safeFile.fd));
      return true;
    } finally {
      fs.closeSync(safeFile.fd);
    }
  }

  // If the requested path looks like a static asset (known extension), return
  // 404 rather than falling through to the SPA index.html fallback.  We check
  // against the same set of extensions that contentTypeForExt() recognises so
  // that dotted SPA routes (e.g. /user/jane.doe, /v2.0) still get the
  // client-side router fallback.
  if (STATIC_ASSET_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  const safeIndex = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
  if (safeIndex) {
    try {
      if (respondHeadForFile(req, res, safeIndex.path)) {
        return true;
      }
      serveResolvedIndexHtml(res, fs.readFileSync(safeIndex.fd, "utf8"));
      return true;
    } finally {
      fs.closeSync(safeIndex.fd);
    }
  }

  respondControlUiNotFound(res);
  return true;
}
