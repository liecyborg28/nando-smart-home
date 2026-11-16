import type { Pool } from "pg";
import { appDatabaseUrl, type Env } from "@/config/env";
import { createPool } from "./pool";

/** One shared pool per process (kept on globalThis so Next.js dev reloads do not leak connections). */
const KEY = Symbol.for("nando-smart-home.pg-pool");
type Holder = { [KEY]?: Pool };

export function getPool(env: Env): Pool | undefined {
  const url = appDatabaseUrl(env);
  if (!url) return undefined;
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= createPool(url);
  return holder[KEY];
}
