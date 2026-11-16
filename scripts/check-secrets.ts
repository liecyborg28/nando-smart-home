import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Secret scanner: refuses to let credentials into git.
 *   npm run check:secrets            scan the whole working tree
 *   npm run check:secrets -- --staged   scan what is about to be committed (used by the pre-commit hook)
 *
 * It is deliberately simple and local. It does not replace a dedicated scanner such as gitleaks
 * in CI, but it catches the mistakes this project can actually make: API tokens, database URLs
 * with passwords, private keys, and a committed .env file.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /** Skip files whose path matches (fixtures legitimately contain fake credentials). */
  skip?: RegExp;
}

const RULES: Rule[] = [
  { name: "Nando API token", pattern: /nsh_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}/, skip: /^tests\// },
  { name: "database URL with a password", pattern: /postgres(?:ql)?:\/\/[^\s:@/]+:(?!\*{3}|<|\$|%7B|password|PASSWORD)[^\s@/]{6,}@[^\s/]+/, skip: /^(tests\/|docs\/)/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "secret assigned in a tracked file", pattern: /(?:ACCESS_SECRET|CONFIRMATION_SECRET)\s*=\s*[A-Za-z0-9_-]{16,}/, skip: /^(tests\/|docs\/)/ },
];

const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/;
const ALLOWED_ENV = /(^|\/)\.env\.example$/;
const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "dist", "out", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 1_000_000;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listWorkingTree(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (IGNORED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listWorkingTree(full, root, out);
    else if (st.size <= MAX_FILE_BYTES) out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

const staged = process.argv.includes("--staged");
const files = staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACM").split("\n").filter(Boolean)
  : listWorkingTree(process.cwd()).filter((f) => !ENV_FILE.test(f) || ALLOWED_ENV.test(f)); // an untracked local .env is expected on disk

const findings: string[] = [];

for (const file of files) {
  if (ENV_FILE.test(file) && !ALLOWED_ENV.test(file)) {
    findings.push(`${file}: environment files must never be committed (only .env.example)`);
    continue;
  }
  let text: string;
  try {
    text = staged ? git("show", `:${file}`) : readFileSync(file, "utf8");
  } catch {
    continue; // deleted, binary or unreadable
  }
  if (text.includes("\u0000")) continue; // binary
  for (const rule of RULES) {
    if (rule.skip?.test(file)) continue;
    const m = rule.pattern.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      // Never print the match itself: that would just move the leak into a terminal or CI log.
      findings.push(`${file}:${line}: looks like a ${rule.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Possible secrets found:\n  " + findings.join("\n  "));
  console.error("\nRemove them (and rotate anything that was real) before committing.");
  process.exit(1);
}
console.log(`No secrets found in ${files.length} file(s).`);
