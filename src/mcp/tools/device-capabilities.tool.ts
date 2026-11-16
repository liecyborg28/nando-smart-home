import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SCOPES } from "@/security/authentication";
import { READ_ONLY, guarded, type McpDeps } from "../guard";
import { capabilityOut, deviceIdInput } from "../schemas";

export function registerDeviceCapabilityTools(server: McpServer, deps: McpDeps): void {
  const input = z.object({ deviceId: deviceIdInput });
  server.registerTool(
    "get_device_capabilities",
    {
      title: "Get device capabilities",
      description:
        "List what a device supports, taken from the device's own specification: each capability has a code, a kind " +
        "(boolean/enum/integer/...), access (read, write or read-write) and constraints (min/max/step/range). " +
        "Call this before attempting any control; never assume a device supports a property. " +
        "Some devices (for example infrared hubs) have no specification and return UNSUPPORTED_OPERATION. Read-only.",
      inputSchema: input,
      outputSchema: z.object({ deviceId: z.string(), count: z.number(), capabilities: z.array(capabilityOut) }),
      annotations: { title: "Get device capabilities", ...READ_ONLY },
    },
    guarded(
      deps,
      { name: "get_device_capabilities", scope: SCOPES.read, cost: () => 2, deviceIds: (a: z.infer<typeof input>) => [a.deviceId] },
      async (args: z.infer<typeof input>, s) => {
        const capabilities = await s.capabilities.getCapabilities(args.deviceId);
        return {
          data: { deviceId: args.deviceId, count: capabilities.length, capabilities },
          summary: `Device ${args.deviceId} exposes ${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"}.`,
        };
      },
    ),
  );
}
