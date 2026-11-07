import { PrismaClient, type HolidayCategory } from "@prisma/client";

// Official holiday list 2026 — Manikstu Agro Pvt Ltd (notice "HOLIDAY LIST - 2026").
//   npx tsx prisma/holidays-2026.ts
// Makes the published 2026 company calendar match this list exactly: adds missing days,
// renames changed ones and removes anything not on the list (e.g. the seed's sample days).
// Safe to run again. The change is written to the audit log.

const prisma = new PrismaClient();
const YEAR = 2026;

// National holidays are PUBLIC; festival and company days are COMPANY.
const OFFICIAL: { date: string; name: string; category: HolidayCategory }[] = [
  { date: "2026-01-14", name: "Makar Sankranti", category: "COMPANY" },
  { date: "2026-01-23", name: "Basanta Panchami", category: "COMPANY" },
  { date: "2026-01-26", name: "Republic Day", category: "PUBLIC" },
  { date: "2026-02-15", name: "Maha Shivaratri", category: "COMPANY" },
  { date: "2026-03-03", name: "Dola Purnima", category: "COMPANY" },
  { date: "2026-03-04", name: "Holi", category: "COMPANY" },
  { date: "2026-04-14", name: "Maha Vishuva Sankranti", category: "COMPANY" },
  { date: "2026-06-15", name: "Raja Sankranti", category: "COMPANY" },
  { date: "2026-07-16", name: "Rath Yatra", category: "COMPANY" },
  { date: "2026-08-15", name: "Independence Day", category: "PUBLIC" },
  { date: "2026-09-04", name: "Janmashtami", category: "COMPANY" },
  { date: "2026-09-14", name: "Ganesh Puja", category: "COMPANY" },
  { date: "2026-09-15", name: "Nuakhai", category: "COMPANY" },
  { date: "2026-10-02", name: "Gandhi Jayanti", category: "PUBLIC" },
  { date: "2026-10-17", name: "Mahasaptami", category: "COMPANY" },
  { date: "2026-10-18", name: "Mahaastami", category: "COMPANY" },
  { date: "2026-10-19", name: "Mahanavami", category: "COMPANY" },
  { date: "2026-10-20", name: "Vijaya Dasami", category: "COMPANY" },
  { date: "2026-10-25", name: "Kumar Purnima", category: "COMPANY" },
  { date: "2026-11-08", name: "Diwali", category: "COMPANY" },
  { date: "2026-11-24", name: "Kartik Purnima", category: "COMPANY" },
  { date: "2026-12-25", name: "Christmas Day", category: "COMPANY" },
];

async function main() {
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const result = await prisma.$transaction(async (tx) => {
    const calendar =
      (await tx.holidayCalendar.findFirst({
        where: { employmentType: null, location: null, year: YEAR, status: "PUBLISHED" },
      })) ??
      (await tx.holidayCalendar.create({
        data: { name: `Company holidays ${YEAR}`, year: YEAR, status: "PUBLISHED", effectiveFrom: day(`${YEAR}-01-01`) },
      }));

    const existing = await tx.holiday.findMany({ where: { calendarId: calendar.id } });
    const wanted = new Map(OFFICIAL.map((h) => [h.date, h]));
    const key = (d: Date) => d.toISOString().slice(0, 10);

    const removed = existing.filter((h) => h.endDate !== null || !wanted.has(key(h.date)));
    if (removed.length) await tx.holiday.deleteMany({ where: { id: { in: removed.map((h) => h.id) } } });

    let added = 0;
    let updated = 0;
    const kept = existing.filter((h) => !removed.includes(h));
    for (const h of OFFICIAL) {
      const cur = kept.find((k) => key(k.date) === h.date);
      if (!cur) {
        await tx.holiday.create({ data: { calendarId: calendar.id, name: h.name, date: day(h.date), category: h.category } });
        added++;
      } else if (cur.name !== h.name || cur.category !== h.category) {
        await tx.holiday.update({ where: { id: cur.id }, data: { name: h.name, category: h.category } });
        updated++;
      }
    }

    const hr = await tx.department.findUnique({ where: { slug: "hr-administration" }, select: { id: true } });
    await tx.auditEvent.create({
      data: {
        action: "HR_HOLIDAY_CALENDAR_LOADED",
        targetType: "HolidayCalendar",
        targetId: calendar.id,
        departmentId: hr?.id ?? null,
        outcome: "SUCCESS",
        detail: {
          source: "Official holiday list 2026 (script prisma/holidays-2026.ts)",
          added,
          updated,
          removed: removed.map((h) => `${key(h.date)} ${h.name}`),
          total: OFFICIAL.length,
        },
      },
    });
    return { calendar: calendar.name, added, updated, removed: removed.map((h) => `${key(h.date)} ${h.name}`) };
  });

  console.log(`${result.calendar}: ${OFFICIAL.length} official holidays`);
  console.log(`  added ${result.added}, renamed ${result.updated}, removed ${result.removed.length}`);
  for (const r of result.removed) console.log(`  - removed ${r}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
