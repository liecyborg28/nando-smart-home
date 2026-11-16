import { getEnv } from "@/config/env";
import { createLogger } from "@/lib/logger";

export const logger = createLogger({ level: getEnv().LOG_LEVEL, bindings: { service: "nando-smart-home" } });
