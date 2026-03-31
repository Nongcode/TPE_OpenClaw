import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";
import type { ControlUiBootstrapAccessPolicy } from "../control-ui-contract.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  controlUiAccessPolicy?: ControlUiBootstrapAccessPolicy;
};
