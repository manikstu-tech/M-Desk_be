import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionFromToken, issueSession } from "@/lib/session";
import { completePasswordSetup, hashPasswordSetupToken } from "@/lib/password-setup";
import {
  ACCOUNT_LIMIT_PER_HOUR,
  PASSWORD_RESET_TOKEN_TTL_MS,
  createPasswordResetToken,
  hashPasswordResetToken,
  checkIpLimit,
  completePasswordReset,
  isResetTokenValid,
  requestPasswordReset,
  resetUrl,
} from "@/lib/password-reset";
import { buildPasswordResetEmail } from "@/lib/password-reset-email";
import { forgotPasswordSchema, resetPasswordSchema } from "@/lib/validation";

vi.mock("@/lib/supabase-auth", () => ({ updateSupabaseUserPassword: vi.fn() }));
import { updateSupabaseUserPassword } from "@/lib/supabase-auth";

const OLD = "OldPassw0rd";
const NEW = "NewPassw0rd";
const MIN = 60_000;
let roleId: string;
let seq = 0;
const created: string[] = [];

type Sent = { to: string; url: string };
function capture() {
  const sent: Sent[] = [];
  return { sent, send: async (m: Sent) => void sent.push(m) };
}
const tokenOf = (m: Sent) => new URL(m.url).hash.replace("#token=", "");

async function makeUser(over: Record<string, unknown> = {}) {
  const u = await db.user.create({
    data: {
      email: `reset-${Date.now()}-${++seq}@mdesk.test`,
      name: "Reset Test",
      passwordHash: await bcrypt.hash(OLD, 4),
      roleId,
      ...over,
    },
  });
  created.push(u.id);
  return u;
}

/** Issue a token for a fresh user. `now` is the issue time. */
async function issue(user: { email: string }, now = new Date()) {
  const c = capture();
  await requestPasswordReset(user.email, { send: c.send, now });
  expect(c.sent).toHaveLength(1);
  return tokenOf(c.sent[0]);
}

beforeAll(async () => {
  // These tests write users and tokens. Refuse to run against anything but a local database.
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("password-reset tests need a local DATABASE_URL");
  process.env.APP_BASE_URL = "http://localhost:3000";
  roleId = (await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } })).id;
});

beforeEach(() => vi.mocked(updateSupabaseUserPassword).mockReset());
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await db.session.deleteMany({ where: { userId: { in: created } } });
  await db.passwordSetupToken.deleteMany({ where: { userId: { in: created } } });
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("token", () => {
  it("is 32 random bytes and only its hash is kept", () => {
    const a = createPasswordResetToken(new Date());
    const b = createPasswordResetToken(new Date());
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toContain(a.token);
    expect(a.tokenHash).toBe(hashPasswordResetToken(a.token));
  });

  it("expires exactly 600 seconds after issue", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBe(600_000);
    expect(createPasswordResetToken(now).expiresAt.getTime() - now.getTime()).toBe(600_000);
  });

  it("cannot be confused with an invitation token", () => {
    const t = "a".repeat(64);
    expect(hashPasswordResetToken(t)).not.toBe(hashPasswordSetupToken(t));
  });
});

describe("validation", () => {
  it("trims and lower-cases the email", () => {
    expect(forgotPasswordSchema.parse({ email: "  USER@Mdesk.Test " }).email).toBe("user@mdesk.test");
  });

  it("rejects a bad email and ignores unexpected fields", () => {
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(forgotPasswordSchema.parse({ email: "a@b.co", role: "SUPER_ADMIN" })).toEqual({ email: "a@b.co" });
  });

  it.each([["short1a"], ["onlyletters"], ["12345678"], [""], ["a1" + "x".repeat(80)]])("rejects password %s", (newPassword) => {
    expect(resetPasswordSchema.safeParse({ token: "a".repeat(64), newPassword }).success).toBe(false);
  });

  it("accepts a good password and rejects a malformed token", () => {
    expect(resetPasswordSchema.safeParse({ token: "a".repeat(64), newPassword: NEW }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: "A".repeat(64), newPassword: NEW }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: "a".repeat(63), newPassword: NEW }).success).toBe(false);
  });
});

describe("email", () => {
  const url = "https://desk.example.com/login/reset-password#token=abc";
  const mail = buildPasswordResetEmail({ to: "a@b.co", url });

  it("has the agreed subject, link and wording in both parts", () => {
    expect(mail.subject).toBe("Reset Your M-DESK Password");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("We received a request to reset your M-DESK account password.");
      expect(body).toContain("valid for only 10 minutes and can be used once");
      expect(body).toContain("Your existing password will remain unchanged.");
      expect(body).toContain("Manikstu Agro Private Limited");
    }
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(`href="${url}"`);
  });

  it("escapes the link in HTML", () => {
    expect(buildPasswordResetEmail({ to: "a@b.co", url: 'https://x.co/"><script>' }).html).not.toContain("<script>");
  });
});

describe("reset url", () => {
  it("uses APP_BASE_URL and puts the token in the fragment", () => {
    vi.stubEnv("APP_BASE_URL", "https://desk.example.com");
    expect(resetUrl("abc")).toBe("https://desk.example.com/login/reset-password#token=abc");
  });

  it("refuses plain http in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASE_URL", "http://desk.example.com");
    expect(() => resetUrl("abc")).toThrow();
  });

  it("fails when APP_BASE_URL is missing", () => {
    vi.stubEnv("APP_BASE_URL", "");
    expect(() => resetUrl("abc")).toThrow();
  });
});

describe("request", () => {
  it("sends one email and stores only a hash", async () => {
    const user = await makeUser();
    const c = capture();
    await requestPasswordReset(user.email, { send: c.send });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].to).toBe(user.email);
    expect(c.sent[0].url).toMatch(/^http:\/\/localhost:3000\/login\/reset-password#token=[a-f0-9]{64}$/);
    const rows = await db.passwordSetupToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashPasswordResetToken(tokenOf(c.sent[0])));
    expect(rows[0].tokenHash).not.toBe(tokenOf(c.sent[0]));
  });

  it("does nothing for an unknown email", async () => {
    const c = capture();
    await requestPasswordReset("nobody-here@mdesk.test", { send: c.send });
    expect(c.sent).toHaveLength(0);
  });

  it("does nothing for a disabled account", async () => {
    const user = await makeUser({ status: "DISABLED" });
    const c = capture();
    await requestPasswordReset(user.email, { send: c.send });
    expect(c.sent).toHaveLength(0);
  });

  it("helps an invited user who lost or never finished their invitation", async () => {
    const user = await makeUser({ passwordHash: null, supabaseAuthUserId: `sb-${Date.now()}-${++seq}`, passwordSetAt: null });
    const token = await issue(user);
    await completePasswordReset(token, NEW);
    expect(updateSupabaseUserPassword).toHaveBeenCalledExactlyOnceWith(user.supabaseAuthUserId, NEW);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordSetAt).not.toBeNull();
  });

  it("a new request kills the previous token", async () => {
    const user = await makeUser();
    const t0 = new Date();
    const first = await issue(user, t0);
    const second = await issue(user, new Date(t0.getTime() + 2 * MIN));
    expect(await isResetTokenValid(first, new Date(t0.getTime() + 3 * MIN))).toBe(false);
    expect(await isResetTokenValid(second, new Date(t0.getTime() + 3 * MIN))).toBe(true);
  });

  it("failed delivery leaves no active token and does not throw", async () => {
    const user = await makeUser();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let token = "";
    await requestPasswordReset(user.email, {
      send: async (m) => {
        token = tokenOf(m);
        throw new Error(`smtp down for ${m.to} ${m.url}`);
      },
    });
    expect(await isResetTokenValid(token)).toBe(false);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(user.email);
    error.mockRestore();
    expect(await db.auditEvent.count({ where: { action: "PASSWORD_RESET_EMAIL_FAILED", targetId: user.id } })).toBe(1);
  });

  it("a duplicate request inside the cooldown sends nothing and keeps the first token", async () => {
    const user = await makeUser();
    const t0 = new Date();
    const first = await issue(user, t0);
    const c = capture();
    await requestPasswordReset(user.email, { send: c.send, now: new Date(t0.getTime() + 5000) });
    expect(c.sent).toHaveLength(0);
    expect(await isResetTokenValid(first, new Date(t0.getTime() + 6000))).toBe(true);
  });

  it("concurrent requests create one token", async () => {
    const user = await makeUser();
    const c = capture();
    await Promise.all(Array.from({ length: 6 }, () => requestPasswordReset(user.email, { send: c.send })));
    expect(c.sent).toHaveLength(1);
    expect(await db.passwordSetupToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it("stops at the hourly account limit, so a victim's live token is not killed", async () => {
    const user = await makeUser();
    const t0 = Date.now();
    let last = "";
    for (let i = 0; i < ACCOUNT_LIMIT_PER_HOUR; i++) last = await issue(user, new Date(t0 + i * 2 * MIN));
    const c = capture();
    const at = new Date(t0 + ACCOUNT_LIMIT_PER_HOUR * 2 * MIN);
    await requestPasswordReset(user.email, { send: c.send, now: at });
    expect(c.sent).toHaveLength(0);
    expect(await isResetTokenValid(last, at)).toBe(true);
  });
});

describe("ip limit", () => {
  it("blocks after the limit and resets after the window", () => {
    const ip = `10.0.0.${++seq}`;
    const t0 = 1_000_000;
    const results = Array.from({ length: 11 }, () => checkIpLimit(ip, t0));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
    expect(checkIpLimit(ip, t0 + 15 * MIN + 1)).toBe(true);
  });
});

describe("expiry", () => {
  it.each([
    ["one second before expiry", 599_000, true],
    ["exactly at expiry", 600_000, false],
    ["after expiry", 600_001, false],
  ])("%s", async (_n, offset, accepted) => {
    const user = await makeUser();
    const t0 = new Date();
    const token = await issue(user, t0);
    const at = new Date(t0.getTime() + offset);
    expect(await isResetTokenValid(token, at)).toBe(accepted);
    if (accepted) await expect(completePasswordReset(token, NEW, at)).resolves.toBeUndefined();
    else await expect(completePasswordReset(token, NEW, at)).rejects.toMatchObject({ code: "INVALID_RESET_LINK" });
  });
});

describe("reset (local password)", () => {
  it("changes the password, clears the flag, ends sessions and writes audit", async () => {
    const user = await makeUser({ mustChangePassword: true });
    const session = await issueSession(user.id);
    const token = await issue(user);
    await completePasswordReset(token, NEW);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW, after.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(OLD, after.passwordHash!)).toBe(false);
    expect(after.mustChangePassword).toBe(false);
    expect(await getSessionFromToken(session.token)).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "PASSWORD_RESET_COMPLETED", targetId: user.id } });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("rejects reuse", async () => {
    const user = await makeUser();
    const token = await issue(user);
    await completePasswordReset(token, NEW);
    await expect(completePasswordReset(token, "Another1pass")).rejects.toMatchObject({ code: "INVALID_RESET_LINK" });
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW, after.passwordHash!)).toBe(true);
  });

  it("rejects unknown and tampered tokens the same way", async () => {
    const user = await makeUser();
    const token = await issue(user);
    const flipped = (token[0] === "a" ? "b" : "a") + token.slice(1);
    await expect(completePasswordReset(flipped, NEW)).rejects.toMatchObject({ code: "INVALID_RESET_LINK" });
    await expect(completePasswordReset("f".repeat(64), NEW)).rejects.toMatchObject({ code: "INVALID_RESET_LINK" });
  });

  it("only one of several concurrent resets wins", async () => {
    const user = await makeUser();
    const token = await issue(user);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => completePasswordReset(token, `Winner${i}abc`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Regression: losers once failed with a 500 (P2028) while queueing for a connection.
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "INVALID_RESET_LINK" });
  });

  it("rejects a token if the account was disabled afterwards", async () => {
    const user = await makeUser();
    const token = await issue(user);
    await db.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    await expect(completePasswordReset(token, NEW)).rejects.toMatchObject({ code: "INVALID_RESET_LINK" });
  });

  it("only changes the token owner", async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const token = await issue(attacker);
    await completePasswordReset(token, NEW);
    const v = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(await bcrypt.compare(OLD, v.passwordHash!)).toBe(true);
  });

  it("a reset token does not work as an invitation token", async () => {
    const user = await makeUser({ passwordHash: null, supabaseAuthUserId: `sb-${Date.now()}-${++seq}`, passwordSetAt: new Date() });
    const token = await issue(user);
    await expect(completePasswordSetup(token, NEW)).rejects.toMatchObject({ code: "INVALID_SETUP_LINK" });
  });

  it("rolls back fully if the database write fails", async () => {
    const user = await makeUser();
    const session = await issueSession(user.id);
    const token = await issue(user);
    const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("db down"));
    await expect(completePasswordReset(token, NEW)).rejects.toThrow();
    spy.mockRestore();
    expect(await isResetTokenValid(token)).toBe(true);
    expect(await getSessionFromToken(session.token)).not.toBeNull();
  });
});

describe("reset (Supabase password)", () => {
  const supabaseUser = () => makeUser({ passwordHash: null, supabaseAuthUserId: `sb-${Date.now()}-${++seq}`, passwordSetAt: new Date() });

  it("updates Supabase, keeps no local hash and ends sessions", async () => {
    const user = await supabaseUser();
    const session = await issueSession(user.id);
    const token = await issue(user);
    await completePasswordReset(token, NEW);
    expect(updateSupabaseUserPassword).toHaveBeenCalledExactlyOnceWith(user.supabaseAuthUserId, NEW);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBeNull();
    expect(await getSessionFromToken(session.token)).toBeNull();
    expect(await isResetTokenValid(token)).toBe(false);
  });

  it("a Supabase failure gives the token back and changes nothing", async () => {
    vi.mocked(updateSupabaseUserPassword).mockRejectedValueOnce(new Error("supabase down"));
    const user = await supabaseUser();
    const session = await issueSession(user.id);
    const token = await issue(user);
    await expect(completePasswordReset(token, NEW)).rejects.toThrow();
    expect(await isResetTokenValid(token)).toBe(true);
    expect(await getSessionFromToken(session.token)).not.toBeNull();
  });

  it("concurrent resets call Supabase once", async () => {
    vi.mocked(updateSupabaseUserPassword).mockResolvedValue(undefined);
    const user = await supabaseUser();
    const token = await issue(user);
    await Promise.allSettled([1, 2, 3].map((i) => completePasswordReset(token, `Winner${i}abc`)));
    expect(updateSupabaseUserPassword).toHaveBeenCalledTimes(1);
  });
});
