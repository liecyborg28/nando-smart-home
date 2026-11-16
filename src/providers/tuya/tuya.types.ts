import { z } from "zod";

/** Result of Get Token / Refresh Token. `expire_time` is in seconds (docs: "validity period in seconds"). */
export const tuyaTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expire_time: z.number().int().positive(),
  uid: z.string().optional(),
});

export type TuyaToken = z.infer<typeof tuyaTokenSchema>;

/** Tuya responses are either wrapped (`{success, result, t}`) or a bare result object; both are accepted. */
export const tuyaEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    code: z.number().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

/**
 * Raw device shapes. Zod strips unknown keys, so sensitive provider fields
 * (local_key, ip, lat/lon, uid, owner_id, uuid...) never enter our objects.
 */
export const rawStatusItemSchema = z.object({ code: z.string(), value: z.unknown() });
export type RawStatusItem = z.infer<typeof rawStatusItemSchema>;

export const rawDeviceSchema = z.object({
  // Ids end up in URL paths; one that is not a plain identifier is dropped from listings (it could not be used anyway).
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().default(""),
  category: z.string().default(""),
  product_name: z.string().optional(),
  online: z.boolean().default(false),
  sub: z.boolean().default(false),
  status: z.array(rawStatusItemSchema).default([]),
});
export type RawDevice = z.infer<typeof rawDeviceSchema>;

export const rawDeviceListSchema = z.object({
  devices: z.array(z.unknown()).default([]),
  has_more: z.boolean().default(false),
  last_row_key: z.string().optional(),
});

const rawSpecItemSchema = z.object({
  code: z.string(),
  type: z.string().default(""),
  // Observed live: a JSON string, or a plain string such as "PowerOff".
  values: z.unknown().optional(),
  name: z.string().optional(),
});
export type RawSpecItem = z.infer<typeof rawSpecItemSchema>;

export const rawSpecSchema = z.object({
  category: z.string().optional(),
  functions: z.array(rawSpecItemSchema).default([]),
  status: z.array(rawSpecItemSchema).default([]),
});
export type RawSpec = z.infer<typeof rawSpecSchema>;

export interface TuyaRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path beginning with "/". Fixed by our own code; never taken from user input. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}
