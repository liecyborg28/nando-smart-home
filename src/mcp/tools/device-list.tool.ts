import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SCOPES } from "@/security/authentication";
import { READ_ONLY, guarded, type McpDeps } from "../guard";
import { deviceIdInput, deviceOut } from "../schemas";

const listInput = z.object({
  category: z
    .string()
    .max(50)
    .optional()
    .describe("Filter by a category kind (switch, socket, light, climate, sensor, curtain, camera, remote) or an exact provider category code."),
  room: z.string().max(50).optional().describe("Filter by room name. Only matches devices whose provider reports rooms; Tuya currently does not."),
  online: z.boolean().optional().describe("Only devices that are online (true) or offline (false)."),
});

export function registerDeviceListTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description:
        "List the smart home devices linked to the account (id, name, category, online state). " +
        "Call this first to discover device ids; use the returned ids with the other tools and never guess ids. " +
        "Read-only.",
      inputSchema: listInput,
      outputSchema: z.object({ count: z.number(), devices: z.array(deviceOut) }),
      annotations: { title: "List devices", ...READ_ONLY },
    },
    guarded(deps, { name: "list_devices", scope: SCOPES.read }, async (args: z.infer<typeof listInput>, s) => {
      const devices = await s.devices.listDevices(args);
      const online = devices.filter((d) => d.online).length;
      return { data: { count: devices.length, devices }, summary: `Found ${devices.length} device(s), ${online} online.` };
    }),
  );

  const getInput = z.object({ deviceId: deviceIdInput });
  server.registerTool(
    "get_device",
    {
      title: "Get device",
      description: "Get one device by id: name, category, product and online state. Read-only.",
      inputSchema: getInput,
      outputSchema: z.object({ device: deviceOut }),
      annotations: { title: "Get device", ...READ_ONLY },
    },
    guarded(
      deps,
      { name: "get_device", scope: SCOPES.read, deviceIds: (a: z.infer<typeof getInput>) => [a.deviceId] },
      async (args: z.infer<typeof getInput>, s) => {
        const device = await s.devices.getDevice(args.deviceId);
        return { data: { device }, summary: `Device ${device.id} is ${device.online ? "online" : "offline"}.` };
      },
    ),
  );
}
