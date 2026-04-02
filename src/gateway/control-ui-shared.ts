import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";
import { CONTROL_UI_CHAT_ARTIFACT_PATH } from "./control-ui-contract.js";

const CONTROL_UI_AVATAR_PREFIX = "/avatar";

export function normalizeControlUiBasePath(basePath?: string): string {
  if (!basePath) {
    return "";
  }
  let normalized = basePath.trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function buildControlUiAvatarUrl(basePath: string, agentId: string): string {
  return basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/${agentId}`
    : `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}

export function buildControlUiChatArtifactUrl(
  basePath: string,
  artifactPath: string,
  options?: { absolute?: boolean },
): string {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const trimmedArtifactPath = artifactPath.trim().replace(/\\/g, "/");
  const encodedPath = encodeURIComponent(trimmedArtifactPath);
  const queryKey = options?.absolute ? "absolute_path" : "path";
  return normalizedBasePath
    ? `${normalizedBasePath}${CONTROL_UI_CHAT_ARTIFACT_PATH}?${queryKey}=${encodedPath}`
    : `${CONTROL_UI_CHAT_ARTIFACT_PATH}?${queryKey}=${encodedPath}`;
}

export function resolveAssistantAvatarUrl(params: {
  avatar?: string | null;
  agentId?: string | null;
  basePath?: string;
}): string | undefined {
  const avatar = params.avatar?.trim();
  if (!avatar) {
    return undefined;
  }
  if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) {
    return avatar;
  }

  const basePath = normalizeControlUiBasePath(params.basePath);
  const baseAvatarPrefix = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (basePath && avatar.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return `${basePath}${avatar}`;
  }
  if (avatar.startsWith(baseAvatarPrefix)) {
    return avatar;
  }

  if (!params.agentId) {
    return avatar;
  }
  if (looksLikeAvatarPath(avatar)) {
    return buildControlUiAvatarUrl(basePath, params.agentId);
  }
  return avatar;
}

export { CONTROL_UI_AVATAR_PREFIX };
