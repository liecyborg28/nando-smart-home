import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Opt-in live tests that talk to real provider APIs. Run with `npm run test:live`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/live/**/*.test.ts"], testTimeout: 30000 },
});
