import { describe, expect, it } from "vitest";
import { parseEnv, tuyaConfigFrom } from "@/config/env";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { TuyaProvider } from "@/providers/tuya/tuya.provider";
import { ConfirmationManager, createConfirmationPolicy } from "@/security/confirmation";
import { createServices } from "@/services/container";

/**
 * LIVE CONTROL test: this sends REAL commands that physically act on a device.
 * It is skipped unless LIVE_CONTROL=1 is set. Run it deliberately:
 *   LIVE_CONTROL=1 npm run test:live -- tests/live/tuya.control.live.test.ts
 *
 * It sends PowerOn then PowerOff to the first infrared_ac device (the AC ends
 * switched off), and logs only the verification outcome, never ids or names.
 */
try {
  process.loadEnvFile(".env");
} catch {}

const enabled = process.env.LIVE_CONTROL === "1";

describe.skipIf(!enabled)("Tuya live control (real device)", () => {
  it("sends PowerOn then PowerOff to the infrared AC and reports honest verification", async () => {
    const config = tuyaConfigFrom(parseEnv(process.env));
    expect(config).toBeDefined();
    const provider = new TuyaProvider(new TuyaClient(config!));
    const { control } = createServices(provider, {
      confirmations: new ConfirmationManager("live-test-secret-0123456789"),
      policy: createConfirmationPolicy({ categories: [], confirmAll: false }),
      sleep: async () => {},
    });

    const ac = (await provider.listDevices()).find((d) => d.category.providerCode === "infrared_ac");
    expect(ac, "no infrared_ac device linked").toBeDefined();
    const actor = { actor: "live-test" };

    const on = await control.turnOn(actor, ac!.id);
    console.log("live: PowerOn ->", JSON.stringify({ status: on.status, accepted: on.status === "executed" ? on.accepted : undefined, verification: on.status === "executed" ? on.verification.result : undefined }));
    expect(on.status).toBe("executed");

    await new Promise((r) => setTimeout(r, 3000));

    const off = await control.turnOff(actor, ac!.id);
    console.log("live: PowerOff ->", JSON.stringify({ status: off.status, accepted: off.status === "executed" ? off.accepted : undefined, verification: off.status === "executed" ? off.verification.result : undefined }));
    expect(off.status).toBe("executed");
    // Infrared is one-way: the honest result is "not_verifiable", never "confirmed".
    if (off.status === "executed") expect(off.verification.result).toBe("not_verifiable");
  });
});
