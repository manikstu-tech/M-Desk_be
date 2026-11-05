import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    await db.$queryRawUnsafe("SELECT 1");
    return NextResponse.json({ data: { status: "ready", database: "ok" } });
  } catch {
    return NextResponse.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "Database is unavailable" } },
      { status: 503 },
    );
  }
}
