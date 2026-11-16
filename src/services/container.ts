import { getEnv, tuyaConfigFrom } from "@/config/env";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { CachingProvider } from "@/providers/caching-provider";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { TuyaProvider } from "@/providers/tuya/tuya.provider";
import { randomBytes } from "node:crypto";
import { getPool } from "@/db/runtime";
import { CONFIRMATION_TTL_SECONDS, ConfirmationManager, PostgresNonceStore, createConfirmationPolicy } from "@/security/confirmation";
import { FixedWindowRateLimiter } from "@/security/rate-limit";
import { CapabilityService } from "./capability.service";
import { ControlService, defaultControlDeps, type ControlDeps } from "./control.service";
import { DeviceService } from "./device.service";
import { StatusService } from "./status.service";

export interface Services {
  provider: SmartHomeProvider;
  devices: DeviceService;
  status: StatusService;
  capabilities: CapabilityService;
  control: ControlService;
}

export function createServices(provider: SmartHomeProvider, control?: ControlDeps): Services {
  return {
    provider,
    devices: new DeviceService(provider),
    status: new StatusService(provider),
    capabilities: new CapabilityService(provider),
    control: new ControlService(provider, control ?? defaultControlDeps(randomBytes(32).toString("hex"))),
  };
}

// Cached on globalThis so the Tuya token cache survives Next.js dev module reloads.
const KEY = Symbol.for("nando-smart-home.services");
type Holder = { [KEY]?: Services };

/** Composition root: the single place that wires config -> provider -> services. */
export function getServices(): Services {
  const holder = globalThis as unknown as Holder;
  if (holder[KEY]) return holder[KEY];
  const config = tuyaConfigFrom(getEnv());
  if (!config) {
    throw new AppError("PROVIDER_UNAVAILABLE", "The Tuya provider is not configured on the server.", { retryable: false });
  }
  const env = getEnv();
  const pool = getPool(env);
  const controlDeps: ControlDeps = {
    enabled: env.CONTROL_ENABLED === "true",
    // Without CONFIRMATION_SECRET a random per-process key is used: confirmations then only work within one process.
    // Single-use tracking lives in Postgres when available, so it also holds across server instances.
    confirmations: new ConfirmationManager(
      env.CONFIRMATION_SECRET ?? randomBytes(32).toString("hex"),
      Date.now,
      CONFIRMATION_TTL_SECONDS,
      pool ? new PostgresNonceStore(pool) : undefined,
    ),
    policy: createConfirmationPolicy({ categories: env.HIGH_IMPACT_CATEGORIES.split(","), confirmAll: env.CONFIRM_ALL_WRITES === "true" }),
    limiter: new FixedWindowRateLimiter(env.WRITE_RATE_LIMIT_PER_MINUTE),
  };
  const services = createServices(new CachingProvider(new TuyaProvider(new TuyaClient(config))), controlDeps);
  holder[KEY] = services;
  return services;
}

/** For tests only. */
export function resetServices(): void {
  delete (globalThis as unknown as Holder)[KEY];
}
