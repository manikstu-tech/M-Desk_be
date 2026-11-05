import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const SRC = path.join(__dirname, "..", "src");
const FORBIDDEN = /auditEvent\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

afterAll(() => db.$disconnect());

describe("audit append-only", () => {
  it("no code path updates or deletes AuditEvent", () => {
    const offenders = walk(SRC).filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("writeAudit creates rows", async () => {
    const action = `TEST_AUDIT_${Date.now()}`;
    await db.$transaction((tx) =>
      writeAudit(tx, { action, targetType: "Test", actorEmail: "test@mdesk.test" }),
    );
    const row = await db.auditEvent.findFirst({ where: { action } });
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe("SUCCESS");
  });
});
