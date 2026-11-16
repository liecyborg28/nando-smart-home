import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const lines = (file: string) => read(file).split(/\r?\n/).map((l) => l.trim());
const instructions = (dockerfile: string) => dockerfile.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));

describe("secrets can never reach a container image or a Vercel upload", () => {
  const ignored = lines(".dockerignore");

  it(".dockerignore keeps every env file and local tooling out of the build context", () => {
    for (const entry of [".env", ".env.*", ".git", "node_modules", ".next", "skills-workspace", "**/.venv"]) {
      expect(ignored, `.dockerignore must list ${entry}`).toContain(entry);
    }
    // .env.example is documentation, not a secret, and may be re-included explicitly.
    expect(ignored.indexOf("!.env.example")).toBeGreaterThan(ignored.indexOf(".env.*"));
  });

  it(".vercelignore keeps env files out of CLI uploads", () => {
    const v = lines(".vercelignore");
    expect(v).toContain(".env");
    expect(v).toContain(".env.*");
  });

  it("the Dockerfile never copies the whole context or an env file", () => {
    const copies = instructions(read("Dockerfile")).filter((l) => /^(COPY|ADD)\b/i.test(l));
    for (const c of copies) {
      expect(c, c).not.toMatch(/\.env/);
      expect(c, c).not.toMatch(/^(COPY|ADD)\s+(--\S+\s+)*\.\s+\S+/i); // "COPY . ." would pull in everything
    }
  });

  it("Next.js copies .env into the standalone output, so the Dockerfile deletes it again", () => {
    expect(read("Dockerfile")).toMatch(/rm -f \.next\/standalone\/\.env\b/);
  });

  it("no secret is set as a build argument or baked in as an ENV value", () => {
    const risky = /(TUYA_ACCESS_SECRET|TUYA_ACCESS_ID|DATABASE_URL|CONFIRMATION_SECRET|TOKEN|PASSWORD|SECRET)/i;
    for (const l of instructions(read("Dockerfile")).filter((l) => /^(ARG|ENV)\b/i.test(l) || /^\s+\w+=/.test(l))) {
      expect(l, l).not.toMatch(risky);
    }
  });
});

describe("the runtime image is least-privilege", () => {
  const stages = read("Dockerfile").split(/^FROM /m).slice(1);
  const runner = stages.find((s) => /\bAS runner\b/i.test(s)) ?? "";

  it("the runtime stage exists, runs as the unprivileged user, and starts the standalone server", () => {
    expect(runner).not.toBe("");
    expect(runner).toMatch(/^USER node$/m);
    expect(runner).toMatch(/CMD \["node", "server\.js"\]/);
    expect(runner).not.toMatch(/USER root/i);
  });

  it("the runtime stage carries the bundle only: no source, scripts, tests or dev tools", () => {
    const copied = runner.split("\n").filter((l) => /^COPY\b/.test(l));
    expect(copied.length).toBeGreaterThan(0);
    for (const c of copied) expect(c, c).toMatch(/--from=build/);
  });

  it("has a health check", () => {
    expect(runner).toMatch(/^HEALTHCHECK\b/m);
  });
});

describe("docker-compose.yml", () => {
  const compose = parse(read("docker-compose.yml")) as { services: Record<string, Record<string, unknown>> };
  const app = compose.services.app!;
  const caddy = compose.services.caddy!;

  it("the app is not published to the internet; only the proxy is", () => {
    expect(app.ports).toBeUndefined();
    expect(app.expose).toEqual(["3000"]);
    expect(caddy.ports).toEqual(["80:80", "443:443"]);
  });

  it("the app is told it sits behind exactly one proxy and runs in production mode", () => {
    const env = app.environment as Record<string, string>;
    expect(env.TRUSTED_PROXY_HOPS).toBe("1");
    expect(env.NODE_ENV).toBe("production");
  });

  it("the app drops privileges: read-only filesystem, no capabilities, no new privileges", () => {
    expect(app.read_only).toBe(true);
    expect(app.cap_drop).toEqual(["ALL"]);
    expect(app.security_opt).toContain("no-new-privileges:true");
  });

  it("secrets come from env_file at run time, never inline", () => {
    expect(app.env_file).toBe(".env");
    expect(JSON.stringify(compose)).not.toMatch(/nsh_|postgres(ql)?:\/\/|sk-ant/);
  });

  it("the operator tools only start on demand", () => {
    expect(compose.services.tools!.profiles).toEqual(["tools"]);
  });

  it("the proxy waits for a healthy app", () => {
    expect((caddy.depends_on as Record<string, { condition: string }>).app!.condition).toBe("service_healthy");
  });
});

describe("vercel.json", () => {
  const vercel = JSON.parse(read("vercel.json")) as { regions?: string[]; framework?: string };
  it("runs next to the database and Tuya (Singapore) and uses the Next.js framework preset", () => {
    expect(vercel.framework).toBe("nextjs");
    expect(vercel.regions).toEqual(["sin1"]);
  });
});
