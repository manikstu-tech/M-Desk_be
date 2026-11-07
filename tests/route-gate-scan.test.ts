import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const API_ROOT = path.join(__dirname, "..", "src", "app", "api");
// change-password is allowlisted on purpose: it is the one route that must work
// while mustChangePassword is still set (requireSession rejects those sessions)
// const ALLOWLIST = new Set(["auth/login/route.ts", "auth/change-password/route.ts"]);

const ALLOWLIST = new Set([
  "auth/login/route.ts",
  "auth/change-password/route.ts",
  "auth/forgot-password/route.ts",
  "auth/reset-password/route.ts",
  "auth/reset-password/validate/route.ts",
  "health/route.ts",
  "health/ready/route.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("route gate scan", () => {
  it("every API route calls requireSession (except allowlisted public routes)", () => {
    const routes = walk(API_ROOT);
    expect(routes.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of routes) {
      const rel = path.relative(API_ROOT, file).replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!/require(SuperAdmin|PageSession|Session)\(/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
