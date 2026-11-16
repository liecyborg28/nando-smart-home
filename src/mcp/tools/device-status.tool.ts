import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SCOPES } from "@/security/authentication";
import { MAX_STATUS_BATCH } from "@/services/status.service";
import { READ_ONLY, guarded, type McpDeps } from "../guard";
import { deviceIdInput, safeErrorOut, statusOut } from "../schemas";

export function registerDeviceStatusTools(server: McpServer, deps: McpDeps): void {
  const statusInput = z.object({ deviceId: deviceIdInput });
  server.registerTool(
    "get_device_status",
    {
      title: "Get device status",
      description:
        "Get the current state of one device: online flag and its status properties (code/value pairs). " +
        "Offline devices are reported as online=false, not as an error. Read-only.",
      inputSchema: statusInput,
      outputSchema: z.object({ status: statusOut }),
      annotations: { title: "Get device status", ...READ_ONLY },
    },
    guarded(
      deps,
      { name: "get_device_status", scope: SCOPES.read, cost: () => 2, deviceIds: (a: z.infer<typeof statusInput>) => [a.deviceId] },
      async (args: z.infer<typeof statusInput>, s) => {
        const status = await s.status.getStatus(args.deviceId);
        return {
          data: { status },
          summary: `Device ${status.deviceId} is ${status.online ? "online" : "offline"} with ${status.properties.length} status propert${status.properties.length === 1 ? "y" : "ies"}.`,
        };
      },
    ),
  );

  const multiInput = z.object({
    deviceIds: z.array(deviceIdInput).min(1).max(MAX_STATUS_BATCH).describe(`Between 1 and ${MAX_STATUS_BATCH} device ids from list_devices.`),
  });
  server.registerTool(
    "get_multiple_device_status",
    {
      title: "Get status of several devices",
      description:
        "Get the status of several devices at once. Each device gets its own result, so one failing or offline device " +
        "does not hide the others. Duplicates are ignored. Read-only.",
      inputSchema: multiInput,
      outputSchema: z.object({
        results: z.array(
          z.object({ deviceId: z.string(), ok: z.boolean(), status: statusOut.optional(), error: safeErrorOut.optional() }),
        ),
      }),
      annotations: { title: "Get status of several devices", ...READ_ONLY },
    },
    guarded(
      deps,
      {
        name: "get_multiple_device_status",
        scope: SCOPES.read,
        // Each device costs two provider calls (detail + status).
        cost: (a: z.infer<typeof multiInput>) => a.deviceIds.length * 2,
        deviceIds: (a: z.infer<typeof multiInput>) => a.deviceIds,
      },
      async (args: z.infer<typeof multiInput>, s) => {
        const raw = await s.status.getMultipleStatus(args.deviceIds);
        const results = raw.map((r) => (r.ok ? { deviceId: r.deviceId, ok: true, status: r.status } : { deviceId: r.deviceId, ok: false, error: r.error }));
        const failed = results.filter((r) => !r.ok).length;
        return { data: { results }, summary: `Read ${results.length - failed} of ${results.length} device status(es).` };
      },
    ),
  );

  const overviewInput = z.object({});
  server.registerTool(
    "get_smart_home_overview",
    {
      title: "Smart home overview",
      description:
        "Summarize the home: total/online/offline device counts, counts per category kind, and a compact device list. " +
        "Uses one provider call and does not read each device's status. Read-only.",
      inputSchema: overviewInput,
      outputSchema: z.object({
        total: z.number(),
        online: z.number(),
        offline: z.number(),
        byCategory: z.record(z.string(), z.object({ total: z.number(), online: z.number() })),
        devices: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), online: z.boolean() })),
      }),
      annotations: { title: "Smart home overview", ...READ_ONLY },
    },
    guarded(deps, { name: "get_smart_home_overview", scope: SCOPES.read }, async (_args: z.infer<typeof overviewInput>, s) => {
      const overview = await s.status.getOverview();
      return { data: { ...overview }, summary: `${overview.total} device(s): ${overview.online} online, ${overview.offline} offline.` };
    }),
  );
}
