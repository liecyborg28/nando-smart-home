import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { COMMAND_CODE_PATTERN } from "@/core/domain/command-validation";
import { MAX_COMMANDS_PER_CALL } from "@/core/domain";
import { SCOPES } from "@/security/authentication";
import type { ControlResult } from "@/services/control.service";
import { guarded, type McpDeps } from "../guard";
import { deviceIdInput } from "../schemas";

const commandCode = z.string().regex(COMMAND_CODE_PATTERN).describe("A capability code exactly as listed by get_device_capabilities.");
const commandValue = z.union([z.string().max(255), z.number().finite(), z.boolean()]).describe("The value to set; must fit the capability's kind and constraints.");
const confirmationToken = z
  .string()
  .max(1024)
  .optional()
  .describe("Only for the second call of a confirmed action: the token returned by the first call, after the user has explicitly agreed.");

const valueOut = z.union([z.string(), z.number(), z.boolean()]);

export const controlOut = z.object({
  status: z.enum(["executed", "confirmation_required"]),
  deviceId: z.string(),
  commands: z.array(z.object({ code: z.string(), value: valueOut })),
  accepted: z.boolean().optional().describe("The provider accepted the request. This alone does NOT prove the device changed state; read verification."),
  verification: z
    .object({
      result: z.enum(["confirmed", "partially_verified", "mismatch", "not_verifiable"]),
      details: z.array(z.object({ code: z.string(), expected: valueOut, actual: z.unknown().optional(), outcome: z.enum(["confirmed", "mismatch", "not_verifiable"]) })),
      note: z.string().optional(),
    })
    .optional(),
  confirmation: z.object({ token: z.string(), expiresInSeconds: z.number(), reason: z.string(), instruction: z.string() }).optional(),
});

// A control call reads the device, its capabilities, sends the command and reads state back (up to twice).
const CONTROL_COST = 6;

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function present(result: ControlResult): { data: z.infer<typeof controlOut>; summary: string; auditNote: string } {
  const codes = result.commands.map((c) => c.code).join(",");
  if (result.status === "confirmation_required") {
    const instruction =
      "Ask the user to explicitly confirm this action. Only if they agree, call this tool again with exactly the same arguments plus this confirmationToken.";
    return {
      data: { status: result.status, deviceId: result.deviceId, commands: result.commands, confirmation: { ...result.confirmation, instruction } },
      summary: `NOT EXECUTED: this action needs the user's explicit confirmation (${result.confirmation.reason}) ${instruction}`,
      auditNote: `confirmation_required codes=${codes}`,
    };
  }
  const v = result.verification;
  const summary =
    v.result === "confirmed"
      ? "Executed: the provider accepted the command AND the device state was read back and matches the request."
      : v.result === "mismatch"
        ? "The provider accepted the command, but the device state does NOT match the request. Do not report success."
        : "The provider accepted the command, but its effect could NOT be verified. Do not claim it succeeded: say it was sent and the result is unconfirmed.";
  return {
    data: { status: result.status, deviceId: result.deviceId, commands: result.commands, accepted: result.accepted, verification: v },
    summary,
    auditNote: `executed:${v.result} codes=${codes}`,
  };
}

export function registerDeviceControlTools(server: McpServer, deps: McpDeps): void {
  const powerInput = z.object({ deviceId: deviceIdInput, confirmationToken });
  for (const [name, on] of [["turn_on_device", true], ["turn_off_device", false]] as const) {
    server.registerTool(
      name,
      {
        title: on ? "Turn device on" : "Turn device off",
        description:
          `Turn a device ${on ? "ON" : "OFF"}. The command is built from the device's own power capability; devices without one are refused. ` +
          "Requires a token with the write scope. Some actions need a two-step confirmation: the first call returns status=confirmation_required and a token and does NOT execute. " +
          "Always read the verification result: only 'confirmed' proves the device changed; otherwise say the effect is unconfirmed. Infrared devices give no feedback and are never verifiable.",
        inputSchema: powerInput,
        outputSchema: controlOut,
        annotations: { title: on ? "Turn device on" : "Turn device off", ...WRITE_ANNOTATIONS },
      },
      guarded(
        deps,
        { name, scope: SCOPES.write, write: true, cost: () => CONTROL_COST, deviceIds: (a: z.infer<typeof powerInput>) => [a.deviceId] },
        async (args: z.infer<typeof powerInput>, s, call) => {
          const result = on
            ? await s.control.turnOn(call, args.deviceId, args.confirmationToken)
            : await s.control.turnOff(call, args.deviceId, args.confirmationToken);
          return present(result);
        },
      ),
    );
  }

  const propertyInput = z.object({ deviceId: deviceIdInput, code: commandCode, value: commandValue, confirmationToken });
  server.registerTool(
    "set_device_property",
    {
      title: "Set device property",
      description:
        "Set one writable property of a device (for example a temperature or mode). Call get_device_capabilities first: the code must be a writable capability of this device " +
        "and the value must fit its kind and constraints, otherwise the call is rejected before anything is sent. Requires a token with the write scope. " +
        "May return status=confirmation_required (not executed) for high-impact actions. Only verification.result 'confirmed' proves the change.",
      inputSchema: propertyInput,
      outputSchema: controlOut,
      annotations: { title: "Set device property", ...WRITE_ANNOTATIONS },
    },
    guarded(
      deps,
      { name: "set_device_property", scope: SCOPES.write, write: true, cost: () => CONTROL_COST, deviceIds: (a: z.infer<typeof propertyInput>) => [a.deviceId] },
      async (args: z.infer<typeof propertyInput>, s, call) => present(await s.control.setProperty(call, args.deviceId, args.code, args.value, args.confirmationToken)),
    ),
  );

  const executeInput = z.object({
    deviceId: deviceIdInput,
    commands: z
      .array(z.object({ code: commandCode, value: commandValue }))
      .min(1)
      .max(MAX_COMMANDS_PER_CALL)
      .describe(`1 to ${MAX_COMMANDS_PER_CALL} commands, each with a distinct code, sent together in one request.`),
    confirmationToken,
  });
  server.registerTool(
    "execute_device_command",
    {
      title: "Execute device command",
      description:
        "Send several property changes to one device in a single request. Every command is validated against the device's capabilities first; if any is invalid nothing is sent. " +
        "Requires a token with the write scope. May return status=confirmation_required (not executed) for high-impact actions. Only verification.result 'confirmed' proves the changes took effect. " +
        "This tool cannot send raw provider requests, only capability-based commands.",
      inputSchema: executeInput,
      outputSchema: controlOut,
      annotations: { title: "Execute device command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(
      deps,
      { name: "execute_device_command", scope: SCOPES.write, write: true, cost: () => CONTROL_COST, deviceIds: (a: z.infer<typeof executeInput>) => [a.deviceId] },
      async (args: z.infer<typeof executeInput>, s, call) => present(await s.control.execute(call, args.deviceId, args.commands, args.confirmationToken)),
    ),
  );
}
