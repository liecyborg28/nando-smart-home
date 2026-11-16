import type { McpServer } from "@modelcontextprotocol/server";
import type { McpDeps } from "../guard";
import { registerDeviceCapabilityTools } from "./device-capabilities.tool";
import { registerDeviceControlTools } from "./device-control.tool";
import { registerDeviceListTools } from "./device-list.tool";
import { registerDeviceStatusTools } from "./device-status.tool";
import { registerProviderTools } from "./provider.tool";

/** Read-only tools first, then the control tools (which require the write scope). */
export function registerTools(server: McpServer, deps: McpDeps): void {
  registerDeviceListTools(server, deps);
  registerDeviceStatusTools(server, deps);
  registerDeviceCapabilityTools(server, deps);
  registerProviderTools(server, deps);
  if (deps.controlEnabled !== false) registerDeviceControlTools(server, deps);
}
