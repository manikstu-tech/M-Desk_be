import { NextRequest, NextResponse } from "next/server";

function allowedOrigins() {
  return (process.env.FRONTEND_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = origin ? allowedOrigins().includes(origin) : false;

  if (request.method === "OPTIONS") {
    if (!allowed) return new NextResponse(null, { status: 403 });
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") ?? "Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    });
  }

  const response = NextResponse.next();
  if (allowed && origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.append("Vary", "Origin");
  }
  return response;
}

export const config = { matcher: ["/api/:path*"] };
