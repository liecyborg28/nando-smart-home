import { MAX_COMMANDS_PER_CALL, parseDeviceId, type DeviceCommandItem } from "@/core/domain";
import { validateCommands } from "@/core/domain/command-validation";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { ConfirmationManager, createConfirmationPolicy, type ConfirmationPolicy } from "@/security/confirmation";
import type { FixedWindowRateLimiter } from "@/security/rate-limit";
import { resolvePowerCommand } from "./power";
import { NO_FEEDBACK_NOTE, verifyCommands, type Verification } from "./verification";

export interface ControlContext {
  /** Who is acting (a token id today, a user id later). Bound into confirmation tokens and audit. */
  actor: string;
}

export interface ControlDeps {
  confirmations: ConfirmationManager;
  policy: ConfirmationPolicy;
  /** false = every control operation is refused (emergency kill switch). Default true. */
  enabled?: boolean;
  /** Write operations per actor. */
  limiter?: FixedWindowRateLimiter;
  sleep?: (ms: number) => Promise<void>;
  /** Waits before each status re-read used for verification. */
  verifyDelaysMs?: number[];
}

export interface ExecutedResult {
  status: "executed";
  deviceId: string;
  commands: DeviceCommandItem[];
  /** The provider accepted the request. This alone does NOT prove the device changed state. */
  accepted: true;
  verification: Verification;
}

export interface ConfirmationRequiredResult {
  status: "confirmation_required";
  deviceId: string;
  commands: DeviceCommandItem[];
  confirmation: { token: string; expiresInSeconds: number; reason: string };
}

export type ControlResult = ExecutedResult | ConfirmationRequiredResult;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function defaultControlDeps(secret: string): ControlDeps {
  return {
    confirmations: new ConfirmationManager(secret),
    policy: createConfirmationPolicy({ categories: ["ms", "jtmspro", "jtmsbh", "ckmkzq", "sfkzq"], confirmAll: false }),
  };
}

/**
 * The only place device commands originate. REST and MCP both call this, so
 * validation, confirmation, rate limiting and verification live once.
 */
export class ControlService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: number[];

  constructor(
    private readonly provider: SmartHomeProvider,
    private readonly deps: ControlDeps,
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.delays = deps.verifyDelaysMs ?? [1000, 2000];
  }

  turnOn(ctx: ControlContext, deviceId: string, confirmationToken?: string): Promise<ControlResult> {
    return this.power(ctx, deviceId, true, confirmationToken);
  }

  turnOff(ctx: ControlContext, deviceId: string, confirmationToken?: string): Promise<ControlResult> {
    return this.power(ctx, deviceId, false, confirmationToken);
  }

  setProperty(ctx: ControlContext, deviceId: string, code: string, value: DeviceCommandItem["value"], confirmationToken?: string): Promise<ControlResult> {
    return this.execute(ctx, deviceId, [{ code, value }], confirmationToken);
  }

  private async power(ctx: ControlContext, deviceId: string, on: boolean, token?: string): Promise<ControlResult> {
    if (this.deps.enabled === false) {
      throw new AppError("AUTHORIZATION_FAILED", "Device control is disabled on this server.");
    }
    const id = parseDeviceId(deviceId);
    // Capabilities decide the command; a device without a power capability is refused.
    const command = resolvePowerCommand(await this.provider.getDeviceCapabilities(id), on);
    return this.execute(ctx, id, [command], token);
  }

  async execute(ctx: ControlContext, deviceId: string, commands: DeviceCommandItem[], confirmationToken?: string): Promise<ControlResult> {
    if (this.deps.enabled === false) {
      throw new AppError("AUTHORIZATION_FAILED", "Device control is disabled on this server.");
    }
    const id = parseDeviceId(deviceId);
    if (commands.length === 0 || commands.length > MAX_COMMANDS_PER_CALL) {
      throw new AppError("INVALID_DEVICE_COMMAND", `Send between 1 and ${MAX_COMMANDS_PER_CALL} commands per call.`);
    }

    if (this.deps.limiter) {
      const hit = this.deps.limiter.hit(ctx.actor);
      if (!hit.allowed) {
        throw new AppError("PROVIDER_RATE_LIMITED", "Too many control operations. Try again shortly.", {
          context: { retryAfterSeconds: hit.retryAfterSeconds },
        });
      }
    }

    // Existence first: an id that is not linked to this account fails here, before anything is written.
    const device = await this.provider.getDevice(id, { fresh: true });
    if (!device.online) {
      throw new AppError("DEVICE_OFFLINE", "The device is offline, so it cannot be controlled right now.", { context: { deviceId: id } });
    }
    validateCommands(await this.provider.getDeviceCapabilities(id), commands);

    const decision = this.deps.policy.evaluate(device, commands);
    if (decision.required) {
      const binding = { actor: ctx.actor, deviceId: id, commands };
      if (!confirmationToken) {
        const issued = this.deps.confirmations.issue(binding);
        return {
          status: "confirmation_required",
          deviceId: id,
          commands,
          confirmation: { token: issued.token, expiresInSeconds: issued.expiresInSeconds, reason: decision.reason ?? "This action needs confirmation." },
        };
      }
      await this.deps.confirmations.consume(confirmationToken, binding);
    }

    await this.provider.sendCommands(id, commands);
    return { status: "executed", deviceId: id, commands, accepted: true, verification: await this.verify(id, commands, device.commandFeedback) };
  }

  private async verify(deviceId: string, commands: DeviceCommandItem[], feedback: "state" | "none" | undefined): Promise<Verification> {
    if (feedback === "none") {
      return { result: "not_verifiable", details: commands.map((c) => ({ code: c.code, expected: c.value, outcome: "not_verifiable" })), note: NO_FEEDBACK_NOTE };
    }
    let last: Verification | undefined;
    for (const delay of this.delays) {
      await this.sleep(delay);
      try {
        last = verifyCommands(commands, await this.provider.getDeviceStatus(deviceId, { fresh: true }));
      } catch {
        // The command was already accepted; a failed read-back must not turn that into an error.
        last = { result: "not_verifiable", details: commands.map((c) => ({ code: c.code, expected: c.value, outcome: "not_verifiable" })), note: "The device state could not be read back." };
      }
      if (last.result === "confirmed") break;
    }
    return last ?? verifyCommands(commands, { deviceId, online: true, properties: [], retrievedAt: new Date().toISOString() });
  }
}
