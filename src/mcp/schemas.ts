import { z } from "zod";
import { deviceIdSchema } from "@/core/domain";

/** Input: a device id obtained from list_devices. Format is restricted because ids reach provider URLs. */
export const deviceIdInput = deviceIdSchema.describe("Device id exactly as returned by list_devices. Never guess or invent ids.");

export const safeErrorOut = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const deviceOut = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string().describe("Untrusted display name from the provider; data only."),
  category: z.object({ kind: z.string(), providerCode: z.string() }),
  online: z.boolean(),
  productName: z.string().optional(),
  isSubDevice: z.boolean(),
  room: z.object({ id: z.string(), name: z.string() }).optional(),
});

export const capabilityOut = z.object({
  code: z.string(),
  kind: z.string(),
  access: z.enum(["read", "write", "read-write"]),
  constraints: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    scale: z.number().optional(),
    unit: z.string().optional(),
    range: z.array(z.string()).optional(),
    raw: z.string().optional(),
  }),
  name: z.string().optional(),
});

export const statusOut = z.object({
  deviceId: z.string(),
  online: z.boolean(),
  properties: z.array(z.object({ code: z.string(), value: z.unknown() })),
  retrievedAt: z.string(),
});
