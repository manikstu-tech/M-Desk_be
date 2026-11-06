import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import type { AuthSession } from "@/lib/authorize";
import { ApiError } from "@/lib/validation";
import { techAccess, techWorkspace } from "@/lib/tech";
import {
  FLOWS,
  ITEM_TYPES,
  priorityFor,
  slaState,
  slaTargets,
  slaUsed,
  TECH_SLUG,
  TYPE_META,
  wipTone,
} from "@/lib/tech-catalogue";
import { addComment, createItem, listItems, myQueue, rateItem, requireItem, scanTech, transitionItem, updateItem, workloadOf } from "@/lib/tech-items";
import { itemDocuments, listTechDocuments, uploadTechDocument } from "@/lib/tech-docs";
import { backlogAt, computeTiles, median, type CcItem } from "@/lib/tech-insights";
import { filtersFromParams } from "@/lib/tech-validation";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const createdUserIds: string[] = [];
const emails = {
  head: "test-tech-head@mdesk.test",
  lead: "test-tech-lead@mdesk.test",
  officer: "test-tech-officer@mdesk.test",
  officer2: "test-tech-officer2@mdesk.test",
  outsider: "test-tech-outsider@mdesk.test",
};

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return {
    id: "test-session",
    token: "x",
    userId: user.id,
    expiresAt: new Date(Date.now() + 1e12),
    userAgent: null,
    createdAt: new Date(),
    user,
  } as unknown as AuthSession;
}

async function mkUser(email: string, role: RoleName, deptId: string | null) {
  const r = await db.role.findUniqueOrThrow({ where: { name: role } });
  const u = await db.user.create({ data: { email, name: email.split("@")[0], passwordHash: "x", roleId: r.id } });
  createdUserIds.push(u.id);
  if (deptId) await db.departmentMembership.create({ data: { userId: u.id, departmentId: deptId } });
  return u;
}

async function expectApiError(p: Promise<unknown>, status: number) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(status);
}

beforeAll(async () => {
  const dept = await db.department.findUniqueOrThrow({ where: { slug: TECH_SLUG } });
  await mkUser(emails.head, RoleName.ADMIN, dept.id);
  await mkUser(emails.lead, RoleName.MANAGER, dept.id);
  await mkUser(emails.officer, RoleName.OFFICER, dept.id);
  await mkUser(emails.officer2, RoleName.OFFICER, dept.id);
  await mkUser(emails.outsider, RoleName.OFFICER, null);
});

afterAll(async () => {
  const items = await db.techItem.findMany({
    where: { OR: [{ reporterId: { in: createdUserIds } }, { assigneeId: { in: createdUserIds } }] },
    select: { id: true, key: true },
  });
  const ids = items.map((i) => i.id);
  const links = items.flatMap((i) => [`/it/${i.key}`, `/departments/technology-mis/items/${i.key}`]);
  const ourDocs = { document: { createdById: { in: createdUserIds } } };
  await db.techDocument.deleteMany({ where: { OR: [{ itemId: { in: ids } }, ourDocs] } });
  await db.documentVersion.deleteMany({ where: ourDocs });
  await db.document.deleteMany({ where: { createdById: { in: createdUserIds } } });
  await db.delegationGrant.deleteMany({ where: { OR: [{ userId: { in: createdUserIds } }, { grantedById: { in: createdUserIds } }] } });
  await db.techLink.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
  await db.techComment.deleteMany({ where: { itemId: { in: ids } } });
  await db.techWatcher.deleteMany({ where: { itemId: { in: ids } } });
  await db.techItem.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
  await db.techItem.deleteMany({ where: { id: { in: ids } } });
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: createdUserIds } }, { link: { in: links } }] } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

describe("tech catalogue (pure)", () => {
  it("priority matrix follows §4.4", () => {
    expect(priorityFor("ORG", "HIGH")).toBe("P1");
    expect(priorityFor("TEAM", "HIGH")).toBe("P2");
    expect(priorityFor("USER", "LOW")).toBe("P4");
    expect(priorityFor()).toBe("P3");
  });

  it("every transition lands on a status of its own flow and every type has a flow", () => {
    for (const flow of Object.values(FLOWS)) {
      expect(flow.statuses).toContain(flow.initial);
      for (const [from, ts] of Object.entries(flow.transitions)) {
        expect(flow.statuses).toContain(from);
        for (const t of ts) expect(flow.statuses).toContain(t.to);
      }
      for (const t of flow.terminal) expect(flow.transitions[t] ?? []).toEqual([]);
    }
    for (const type of ITEM_TYPES) expect(FLOWS[TYPE_META[type].flow]).toBeDefined();
  });

  it("SLA window excludes paused time", () => {
    const created = new Date("2026-10-27T09:00:00Z");
    const { resolveDueAt } = slaTargets("P1", created);
    expect(resolveDueAt.getTime() - created.getTime()).toBe(4 * HOUR);
    const now = new Date(created.getTime() + 3 * HOUR);
    const item = { createdAt: created, resolveDueAt, resolvedAt: null, slaPausedAt: null, slaPausedMs: 0 };
    expect(slaUsed(item, now)).toBeCloseTo(0.75);
    expect(slaState(item, now)).toBe("at_risk");
    // one hour paused and due pushed out by the hour → back to half the window
    const paused = { ...item, resolveDueAt: new Date(resolveDueAt.getTime() + HOUR), slaPausedMs: HOUR };
    expect(slaUsed(paused, now)).toBeCloseTo(0.5);
    expect(slaState({ ...item, slaPausedAt: now }, now)).toBe("paused");
    expect(slaState({ ...item, resolvedAt: new Date(created.getTime() + 5 * HOUR) }, now)).toBe("missed");
  });

  it("WIP limit turns amber at the limit and red over it", () => {
    expect(wipTone(3, 4)).toBe("ok");
    expect(wipTone(4, 4)).toBe("amber");
    expect(wipTone(5, 4)).toBe("red");
    expect(wipTone(50, null)).toBe("ok");
  });

  it("URL filters drop unknown values instead of failing", () => {
    const f = filtersFromParams({ types: "INCIDENT,NOPE", priority: "P9", lane: "SD", sla: "breached", days: "abc" });
    expect(f).toEqual({ types: ["INCIDENT"], lane: "SD", sla: "breached" });
  });
});

describe("tech access", () => {
  it("members get the workspace; outsiders only the portal; roles map to capabilities", async () => {
    const [head, lead, officer, outsider] = await Promise.all([
      sessionFor(emails.head).then(techAccess),
      sessionFor(emails.lead).then(techAccess),
      sessionFor(emails.officer).then(techAccess),
      sessionFor(emails.outsider),
    ]);
    expect(head).toMatchObject({ member: true, agent: true, lead: true, head: true, seesL4: true });
    expect(lead).toMatchObject({ agent: true, lead: true, head: false, seesL3: true, seesL4: false });
    expect(officer).toMatchObject({ agent: true, lead: false, head: false, seesL3: false, seesL4: false });
    expect(await techWorkspace(outsider)).toBeNull();
  });
});

describe("work-item engine (WF-TM-01)", () => {
  let key = "";

  it("a requester raises an incident: key, matrix priority, lane by category, SLA, receipt", async () => {
    const outsider = await sessionFor(emails.outsider);
    const item = await createItem(outsider, {
      type: "INCIDENT",
      title: "Laptop will not charge",
      category: "Network & Wi-Fi",
      impact: "TEAM",
      urgency: "HIGH",
      // agent-only fields are ignored for a requester
      priority: "P4",
      confidentiality: "L1",
    });
    key = item.key;
    expect(item.key).toMatch(/^TM-\d+$/);
    expect(item.priority).toBe("P2");
    expect(item.component).toBe("INF");
    expect(item.confidentiality).toBe("L2");
    expect(item.status).toBe("NEW");
    expect(item.resolveDueAt).not.toBeNull();
    const receipt = await db.notification.findFirst({ where: { userId: outsider.user.id, link: `/it/${key}` } });
    expect(receipt?.title).toContain(key);
  });

  it("requesters cannot raise staff-only types; access requests go to the approval chain", async () => {
    const outsider = await sessionFor(emails.outsider);
    await expectApiError(createItem(outsider, { type: "CHANGE", title: "Change the firewall", category: "Network & Wi-Fi" }), 403);
    await expectApiError(createItem(outsider, { type: "ACCESS_REQUEST", title: "Access to Tally", category: "Software" }), 422);
    await expectApiError(createItem(outsider, { type: "INCIDENT", title: "Unknown category", category: "Nope" }), 422);
  });

  it("lists follow the visibility ladder", async () => {
    const [outsider, officer] = await Promise.all([sessionFor(emails.outsider), sessionFor(emails.officer)]);
    const mine = await listItems(await techAccess(outsider), {});
    expect(mine.every((i) => i.reporterId === outsider.user.id || i.assigneeId === outsider.user.id)).toBe(true);
    expect(mine.some((i) => i.key === key)).toBe(true);
    const staff = await listItems(await techAccess(officer), {});
    expect(staff.some((i) => i.key === key)).toBe(true);
  });

  it("illegal and unentitled transitions are refused and audited", async () => {
    const [outsider, officer] = await Promise.all([sessionFor(emails.outsider), sessionFor(emails.officer)]);
    await expectApiError(transitionItem(officer, key, { to: "RESOLVED" }), 409);
    await expectApiError(transitionItem(outsider, key, { to: "IN_PROGRESS" }), 403);
    const denied = await db.auditEvent.count({ where: { action: "DENIED_TECH_TRANSITION", detail: { path: ["key"], equals: key } } });
    expect(denied).toBe(2);
  });

  it("waiting on the requester pauses the clock; their reply resumes it (A5)", async () => {
    const [outsider, officer] = await Promise.all([sessionFor(emails.outsider), sessionFor(emails.officer)]);
    await transitionItem(officer, key, { to: "IN_PROGRESS" });
    await expectApiError(transitionItem(officer, key, { to: "WAITING_ON_REQUESTER" }), 422);
    await transitionItem(officer, key, { to: "WAITING_ON_REQUESTER", reason: "Which charger model?" });
    const paused = await db.techItem.findUniqueOrThrow({ where: { key } });
    expect(paused.slaPausedAt).not.toBeNull();
    expect(paused.respondedAt).not.toBeNull();

    // backdate the pause by an hour so the shift is measurable
    await db.techItem.update({ where: { key }, data: { slaPausedAt: new Date(Date.now() - HOUR) } });
    await addComment(outsider, key, { body: "It is the 65W USB-C one" });
    const resumed = await db.techItem.findUniqueOrThrow({ where: { key } });
    expect(resumed.status).toBe("IN_PROGRESS");
    expect(resumed.slaPausedAt).toBeNull();
    expect(resumed.slaPausedMs).toBeGreaterThanOrEqual(HOUR);
    expect(resumed.resolveDueAt!.getTime() - paused.resolveDueAt!.getTime()).toBeGreaterThanOrEqual(HOUR);
    // requesters never write internal notes
    await expectApiError(addComment(outsider, key, { body: "secret", internal: true }), 403);
  });

  it("resolve needs a code and note; requester rates once; auto-close after 3 working days (A4)", async () => {
    const [outsider, officer] = await Promise.all([sessionFor(emails.outsider), sessionFor(emails.officer)]);
    await expectApiError(transitionItem(officer, key, { to: "RESOLVED", resolutionNote: "Swapped charger" }), 422);
    await transitionItem(officer, key, { to: "RESOLVED", resolutionCode: "HARDWARE_REPLACED", resolutionNote: "Swapped charger" });
    await expectApiError(rateItem(officer, key, { csat: 5 }), 403);
    await rateItem(outsider, key, { csat: 5 });
    await expectApiError(rateItem(outsider, key, { csat: 4 }), 409);

    await db.techItem.update({ where: { key }, data: { resolvedAt: new Date(Date.now() - 10 * DAY) } });
    await scanTech();
    const closed = await db.techItem.findUniqueOrThrow({ where: { key } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();
  });

  it("the SLA scan escalates a breached item once (idempotent stamps)", async () => {
    const officer = await sessionFor(emails.officer);
    const item = await createItem(officer, { type: "SERVICE_REQUEST", title: "New mailbox for field team", category: "Email & M365", impact: "ORG", urgency: "HIGH" });
    expect(item.priority).toBe("P1");
    const created = new Date(Date.now() - 5 * HOUR);
    await db.techItem.update({ where: { id: item.id }, data: { createdAt: created, resolveDueAt: new Date(created.getTime() + 4 * HOUR) } });
    await scanTech();
    await scanTech();
    const after = await db.techItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.escalatedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: "TECH_SLA_ESCALATED", targetId: item.id } })).toBe(1);
  });

  it("nothing is auto-assigned: new work waits for the assigners, told once (A1)", async () => {
    const [officer, head, lead] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.head), sessionFor(emails.lead)]);
    const item = await createItem(officer, { type: "INCIDENT", title: "Finance share unreachable", category: "Software", impact: "ORG", urgency: "HIGH" });
    expect(item.priority).toBe("P1");
    expect(item.assigneeId).toBeNull();
    // the Head assigns, so the P1 alert and the "to assign" notice arrive as one
    const toHead = await db.notification.findMany({ where: { userId: head.user.id, link: `/departments/technology-mis/items/${item.key}` } });
    expect(toHead.map((n) => n.title)).toEqual([`To assign — P1 ${item.key}: ${item.title}`]);
    expect(await db.notification.count({ where: { userId: lead.user.id, title: `P1 ${item.key}: ${item.title}` } })).toBe(1);
    // the assigner gets the pool; staff no longer pick from it
    expect((await myQueue(await techAccess(head))).unassigned.some((i) => i.key === item.key)).toBe(true);
    expect((await myQueue(await techAccess(officer))).unassigned).toEqual([]);
  });

  it("only the Super Admin / Tech Head assigns: who, which part and instructions", async () => {
    const [officer, lead, head, officer2] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.lead), sessionFor(emails.head), sessionFor(emails.officer2)]);
    const item = await createItem(officer, { type: "SERVICE_REQUEST", title: "Install Power BI desktop", category: "Software" });
    await expectApiError(updateItem(officer, item.key, { assigneeId: officer2.user.id }), 403);
    await expectApiError(updateItem(officer, item.key, { assigneeId: officer.user.id }), 403);
    await expectApiError(updateItem(lead, item.key, { assigneeId: officer2.user.id }), 403);
    // staff may still log their own work for themselves, but never for someone else
    await expectApiError(createItem(lead, { type: "BUG", title: "Export button misaligned", category: "M-DESK", assigneeId: officer.user.id }), 403);

    await updateItem(head, item.key, { assigneeId: officer.user.id, component: "MIS", assignNote: "Use the 64-bit installer" });
    let row = await db.techItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).toMatchObject({ assigneeId: officer.user.id, assignedById: head.user.id, component: "MIS", assignNote: "Use the 64-bit installer", reassignCount: 0 });
    expect(row.assignedAt).not.toBeNull();
    const told = await db.notification.findFirst({ where: { userId: officer.user.id, title: `Assigned ${item.key}: ${item.title}` } });
    expect(told?.body).toBe("Use the 64-bit installer");
    const { mine } = await myQueue(await techAccess(officer));
    expect(mine.find((i) => i.key === item.key)?.assignedBy?.id).toBe(head.user.id);

    // instructions are the assigner's; a new assignee never inherits the last one's
    await expectApiError(updateItem(lead, item.key, { assignNote: "Different plan" }), 403);
    await updateItem(head, item.key, { assignNote: "Install it for the whole MIS team" });
    await updateItem(head, item.key, { assigneeId: officer2.user.id });
    row = await db.techItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.assignNote).toBeNull();
    expect(row.reassignCount).toBe(1);

    await expectApiError(updateItem(lead, item.key, { priority: "P1" }), 422);
    await updateItem(lead, item.key, { priority: "P2", priorityReason: "Board meeting tomorrow" });
    expect((await db.techItem.findUniqueOrThrow({ where: { id: item.id } })).priority).toBe("P2");
  });

  it("workload counts open work per person, least loaded first (pure)", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    const sla = { createdAt: new Date(now.getTime() - 4 * HOUR), resolvedAt: null, slaPausedAt: null, slaPausedMs: 0 };
    const load = workloadOf(
      [
        { id: "a", name: "Asha" },
        { id: "b", name: "Bilal" },
        { id: "c", name: "Chen" },
      ],
      [
        { ...sla, assigneeId: "a", priority: "P1", resolveDueAt: new Date(now.getTime() - HOUR) }, // breached
        { ...sla, assigneeId: "a", priority: "P3", resolveDueAt: new Date(now.getTime() + HOUR) }, // 80% used
        { ...sla, assigneeId: "b", priority: "P4", resolveDueAt: null },
        { ...sla, assigneeId: "gone", priority: "P2", resolveDueAt: null }, // no longer staff: ignored
      ],
      now,
    );
    expect(load.map((w) => w.id)).toEqual(["c", "b", "a"]);
    expect(load[2]).toMatchObject({ open: 2, urgent: 1, breached: 1, atRisk: 1 });
  });
});

describe("tech documents", () => {
  it("uploads need an UPLOAD grant; attachments never sit below their item's level", async () => {
    const [officer, head] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.head)]);
    const dept = await db.department.findUniqueOrThrow({ where: { slug: TECH_SLUG } });
    const mis = await createItem(officer, { type: "MIS_REQUEST", title: "Monthly collections extract", category: "Reports & data" });
    expect(mis.confidentiality).toBe("L3");
    const csv = () => new File(["region,amount\nNorth,10\n"], "extract.csv", { type: "text/csv" });
    const meta = { title: "Collections extract v1", category: "REPORT" as const, confidentiality: "L2" as const, itemKey: mis.key };

    // department membership grants nothing — the same rule as every other document
    await expectApiError(uploadTechDocument(head, meta, csv()), 403);
    await db.delegationGrant.create({ data: { userId: head.user.id, departmentId: dept.id, action: "UPLOAD", grantedById: head.user.id, reason: "tech documents test" } });

    const att = await uploadTechDocument(head, meta, csv());
    expect(att.itemId).toBe(mis.id);
    expect((await db.document.findUniqueOrThrow({ where: { id: att.documentId } })).confidentiality).toBe("L3");
    expect(await db.auditEvent.count({ where: { action: "TECH_FILE_ATTACHED", targetId: mis.id } })).toBe(1);
    const lib = await uploadTechDocument(head, { title: "Wi-Fi controller runbook", category: "SOP", confidentiality: "L2" }, new File(["1. Reboot"], "runbook.txt", { type: "text/plain" }));
    expect(lib.itemId).toBeNull();

    const access = await techAccess(head);
    const onItems = await listTechDocuments(head, access, { scope: "items" });
    expect(onItems.find((d) => d.id === att.documentId)?.item?.key).toBe(mis.key);
    expect(onItems.some((d) => d.id === lib.documentId)).toBe(false);
    expect((await listTechDocuments(head, access, { category: "SOP" })).some((d) => d.id === lib.documentId)).toBe(true);

    // the officer raised the item but holds no L3 VIEW grant: the file is counted, not shown
    const seen = await itemDocuments(officer, mis.id);
    expect(seen.files).toEqual([]);
    expect(seen.hidden).toBe(1);
  });
});

describe("guard rails per type", () => {
  it("security incidents are L4: hidden from officers (404 + audit), visible to the Head", async () => {
    const [outsider, officer, head] = await Promise.all([sessionFor(emails.outsider), sessionFor(emails.officer), sessionFor(emails.head)]);
    const item = await createItem(outsider, { type: "SECURITY_INCIDENT", title: "Suspicious invoice email", category: "Security", subcategory: "Phishing" });
    expect(item.confidentiality).toBe("L4");
    await expectApiError(requireItem(officer, item.key), 404);
    expect(await db.auditEvent.count({ where: { action: "DENIED_TECH_VIEW", targetId: item.id } })).toBe(1);
    const { item: seen } = await requireItem(head, item.key);
    expect(seen.key).toBe(item.key);
    // the reporter still sees their own report
    await expect(requireItem(outsider, item.key)).resolves.toBeDefined();
  });

  it("code review: the reviewer must not be the assignee", async () => {
    const [officer, officer2] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.officer2)]);
    const bug = await createItem(officer, { type: "BUG", title: "Dashboard tile shows NaN", category: "M-DESK", assigneeId: officer.user.id });
    expect(bug.status).toBe("BACKLOG");
    await transitionItem(officer, bug.key, { to: "IN_PROGRESS" });
    await transitionItem(officer, bug.key, { to: "IN_REVIEW" });
    await expectApiError(transitionItem(officer, bug.key, { to: "QA" }), 403);
    const ok = await transitionItem(officer2, bug.key, { to: "QA" });
    expect(ok.status).toBe("QA");
  });

  it("changes: plan before submit; a major change needs the Head, never the requester", async () => {
    const [officer, lead, head] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.lead), sessionFor(emails.head)]);
    const chg = await createItem(officer, { type: "CHANGE", title: "Upgrade M-DESK database", category: "M-DESK", details: { risk: "MAJOR" } });
    await expectApiError(transitionItem(officer, chg.key, { to: "SUBMITTED" }), 422);
    await updateItem(officer, chg.key, { details: { plan: "pg_upgrade in window", rollback: "Restore last night's snapshot" } });
    await transitionItem(officer, chg.key, { to: "SUBMITTED" });
    await transitionItem(lead, chg.key, { to: "RISK_ASSESSED" });
    await expectApiError(transitionItem(lead, chg.key, { to: "APPROVED" }), 403);
    await transitionItem(head, chg.key, { to: "APPROVED" });

    const own = await createItem(head, { type: "CHANGE", title: "Head's own firewall change", category: "Network & Wi-Fi", details: { risk: "MAJOR", plan: "x", rollback: "y" } });
    await transitionItem(head, own.key, { to: "SUBMITTED" });
    await transitionItem(head, own.key, { to: "RISK_ASSESSED" });
    await expectApiError(transitionItem(head, own.key, { to: "APPROVED" }), 403);
  });

  it("a rolled-back change opens a linked incident (A15)", async () => {
    const [officer, head] = await Promise.all([sessionFor(emails.officer), sessionFor(emails.head)]);
    const chg = await createItem(officer, { type: "CHANGE", title: "Rotate Wi-Fi certificates", category: "Network & Wi-Fi", details: { risk: "STANDARD", plan: "a", rollback: "b" } });
    for (const to of ["SUBMITTED", "RISK_ASSESSED", "APPROVED", "SCHEDULED", "IMPLEMENTING", "IMPLEMENTED"]) {
      await transitionItem(to === "APPROVED" ? head : officer, chg.key, { to });
    }
    await expectApiError(transitionItem(officer, chg.key, { to: "REVIEWED" }), 422);
    await transitionItem(officer, chg.key, { to: "REVIEWED", outcome: "ROLLED_BACK", reason: "Clients could not reconnect" });
    const link = await db.techLink.findFirst({ where: { toId: chg.id, kind: "caused_by" }, include: { from: true } });
    expect(link?.from.type).toBe("INCIDENT");
    expect(link?.from.priority).toBe("P2");
  });

  it("a P1 incident cannot close without a post-incident review", async () => {
    const lead = await sessionFor(emails.lead);
    const p1 = await createItem(lead, { type: "INCIDENT", title: "Office internet down", category: "Network & Wi-Fi", impact: "ORG", urgency: "HIGH" });
    await transitionItem(lead, p1.key, { to: "IN_PROGRESS" });
    await transitionItem(lead, p1.key, { to: "ESCALATED" });
    await transitionItem(lead, p1.key, { to: "RESOLVED", resolutionCode: "VENDOR_FIX", resolutionNote: "ISP replaced the router" });
    await expectApiError(transitionItem(lead, p1.key, { to: "CLOSED" }), 422);
    const closed = await transitionItem(lead, p1.key, { to: "CLOSED", pir: "Single ISP; add a backup line" });
    expect(closed.status).toBe("CLOSED");
  });
});

describe("command centre tiles (pure)", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  const base: CcItem = {
    key: "TM-1",
    title: "x",
    type: "INCIDENT",
    status: "IN_PROGRESS",
    priority: "P3",
    component: "SD",
    category: "Hardware",
    assigneeId: null,
    assigneeName: null,
    requesterDept: null,
    createdAt: new Date(now.getTime() - 2 * DAY),
    resolvedAt: null,
    closedAt: null,
    resolveDueAt: null,
    slaPausedAt: null,
    slaPausedMs: 0,
    csat: null,
    reassignCount: 0,
    storyPoints: null,
    windowStart: null,
  };
  const items: CcItem[] = [
    { ...base, key: "TM-1", priority: "P1", resolveDueAt: new Date(now.getTime() + 2 * HOUR) },
    { ...base, key: "TM-2", priority: "P2", resolveDueAt: new Date(now.getTime() - HOUR) },
    { ...base, key: "TM-3", resolvedAt: new Date(now.getTime() - DAY), resolveDueAt: new Date(now.getTime()), csat: 4 },
    { ...base, key: "TM-4", resolvedAt: new Date(now.getTime() - DAY), resolveDueAt: new Date(now.getTime() - 2 * DAY), csat: 2, reassignCount: 1 },
    { ...base, key: "TM-5", createdAt: new Date(now.getTime() - 10 * DAY), closedAt: new Date(now.getTime() - 9 * DAY) },
  ];
  const tiles = Object.fromEntries(computeTiles(items, now, { approvalsWaiting: 2, approvalsOverdue: 1, licences: [] }).map((t) => [t.id, t]));

  it("counts open P1/P2, SLA compliance, breaching soon, FCR and CSAT", () => {
    expect(tiles.p1p2.value).toBe("1 / 1");
    expect(tiles.p1p2.rag).toBe("red");
    expect(tiles.sla.value).toBe("50%");
    expect(tiles.sla.rag).toBe("red");
    expect(tiles.breaching.value).toBe("1");
    expect(tiles.breaching.sub).toBe("1 already breached");
    expect(tiles.fcr.value).toBe("50%");
    expect(tiles.csat.value).toBe("3 / 5");
    expect(tiles.approvals.rag).toBe("red");
    expect(tiles.leavers.pending).toBeDefined();
  });

  it("backlog a week ago counts what was open then", () => {
    expect(backlogAt(items, new Date(now.getTime() - 7 * DAY))).toBe(0);
    expect(backlogAt(items, new Date(now.getTime() - 9.5 * DAY))).toBe(1);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});
