import { ApiError } from "@/lib/validation";

export type InvitationFailureStage = "supabase" | "database" | "smtp";

type ErrorWithNetworkDetails = {
  code?: unknown;
  responseCode?: unknown;
  cause?: unknown;
};

function errorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return { code: "", responseCode: undefined };
  const current = error as ErrorWithNetworkDetails;
  const cause = typeof current.cause === "object" && current.cause !== null
    ? current.cause as ErrorWithNetworkDetails
    : undefined;
  const code = typeof current.code === "string"
    ? current.code
    : typeof cause?.code === "string"
      ? cause.code
      : "";
  const responseCode = typeof current.responseCode === "number" ? current.responseCode : undefined;
  return { code: code.toUpperCase(), responseCode };
}

export function invitationFailureReason(error: unknown, stage: InvitationFailureStage) {
  if (error instanceof ApiError) return error.message;

  const { code, responseCode } = errorDetails(error);
  const dnsFailure = ["EDNS", "ENOTFOUND", "EAI_AGAIN"].includes(code);
  const connectionFailure = [
    "ECONNECTION",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ESOCKET",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ].includes(code);

  if (stage === "database") {
    return "The account exists, but its Supabase Auth ID could not be saved. Check the database connection, then resend the setup link.";
  }

  if (stage === "smtp") {
    if (code === "EAUTH" || responseCode === 535) {
      return "Gmail rejected the SMTP sign-in. Check that SMTP_USER is your Gmail address and SMTP_PASSWORD is a current App Password without spaces.";
    }
    if (dnsFailure) {
      return "The computer could not resolve the SMTP server address. Check its DNS or network settings.";
    }
    if (connectionFailure) {
      return "The computer could not connect to Gmail SMTP on port 587. Check the network or firewall.";
    }
    return "Gmail SMTP could not send the message. Check the SMTP settings and try again.";
  }

  if (dnsFailure) {
    return "The computer could not resolve the Supabase Auth address. Check its DNS or network settings.";
  }
  if (connectionFailure) {
    return "The computer could not connect to Supabase Auth. Check the network and Supabase URL.";
  }
  return "Supabase Auth could not create the setup link. Check SUPABASE_URL and the server secret key.";
}
