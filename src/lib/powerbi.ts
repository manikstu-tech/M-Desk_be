import { ApiError } from "./validation";

// Power BI "embed for your organization's customers" (app owns data): a service
// principal signs in to Entra ID, then asks Power BI for a short-lived, view-only
// embed token. Viewers never need their own Power BI licence or Microsoft sign-in.

type PowerBIConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  reportId: string;
};

export type EmbedConfig = {
  reportId: string;
  embedUrl: string;
  accessToken: string;
  expiresAt: string;
};

const API = "https://api.powerbi.com/v1.0/myorg";

function readConfig(): PowerBIConfig | null {
  const tenantId = process.env.POWERBI_TENANT_ID;
  const clientId = process.env.POWERBI_CLIENT_ID;
  const clientSecret = process.env.POWERBI_CLIENT_SECRET;
  const workspaceId = process.env.POWERBI_WORKSPACE_ID;
  const reportId = process.env.POWERBI_REPORT_ID;
  if (!tenantId || !clientId || !clientSecret || !workspaceId || !reportId) return null;
  return { tenantId, clientId, clientSecret, workspaceId, reportId };
}

export function isPowerBIConfigured(): boolean {
  return readConfig() !== null;
}

async function aadToken(cfg: PowerBIConfig): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://analysis.windows.net/powerbi/api/.default",
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(502, "POWERBI_AUTH", "Could not sign in to Power BI");
  return ((await res.json()) as { access_token: string }).access_token;
}

async function pbi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(502, "POWERBI_API", `Power BI request failed (${res.status})`);
  return (await res.json()) as T;
}

export async function getEmbedConfig(): Promise<EmbedConfig> {
  const cfg = readConfig();
  if (!cfg) throw new ApiError(503, "POWERBI_NOT_CONFIGURED", "Power BI is not configured");

  const token = await aadToken(cfg);
  const group = `/groups/${cfg.workspaceId}/reports/${cfg.reportId}`;

  const report = await pbi<{ id: string; embedUrl: string }>(token, group);
  const embed = await pbi<{ token: string; expiration: string }>(token, `${group}/GenerateToken`, {
    method: "POST",
    body: JSON.stringify({ accessLevel: "View" }),
  });

  return {
    reportId: report.id,
    embedUrl: report.embedUrl,
    accessToken: embed.token,
    expiresAt: embed.expiration,
  };
}
