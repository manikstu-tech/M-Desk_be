import { ApiError } from "@/lib/validation";

type SupabaseAuthUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSupabaseAuthUser(value: unknown): SupabaseAuthUser | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    email: typeof value.email === "string" ? value.email : undefined,
    user_metadata: isRecord(value.user_metadata) ? value.user_metadata : undefined,
  };
}

function getSupabaseUrl() {
  const value = process.env.SUPABASE_URL;
  if (!value) {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "Set SUPABASE_URL to enable Supabase Auth");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "SUPABASE_URL must be a valid URL");
  }
  const isLocalHttp = process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "SUPABASE_URL must use HTTPS");
  }
  return url;
}

function getPublicKey() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new ApiError(
      503,
      "SUPABASE_NOT_CONFIGURED",
      "Set SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) to enable Supabase sign-in",
    );
  }
  return key;
}

function getSecretKey() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new ApiError(
      503,
      "SUPABASE_NOT_CONFIGURED",
      "Set SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) on the server to manage invited users",
    );
  }
  return key;
}

function getInviteRedirectUrl() {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "Set APP_BASE_URL for Supabase invitation links");
  }

  let url: URL;
  try {
    url = new URL("/login/set-password", baseUrl);
  } catch {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "APP_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new ApiError(503, "SUPABASE_NOT_CONFIGURED", "APP_BASE_URL must use HTTPS in production");
  }
  return url.toString();
}

async function responseJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function responseMessage(payload: Record<string, unknown> | null) {
  const message = payload?.msg ?? payload?.message ?? payload?.error_description ?? payload?.error;
  return typeof message === "string" ? message : null;
}

type SetupLinkInput = {
  email: string;
  name: string;
  localUserId: string;
};

async function createSupabaseActionLink(input: SetupLinkInput, type: "invite" | "recovery") {
  const url = getSupabaseUrl();
  const secretKey = getSecretKey();
  const endpoint = new URL("/auth/v1/admin/generate_link", url);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type,
      email: input.email,
      ...(type === "invite" ? { data: { name: input.name, mdesk_user_id: input.localUserId } } : {}),
      redirect_to: getInviteRedirectUrl(),
    }),
    cache: "no-store",
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    throw new ApiError(
      status,
      "SUPABASE_INVITE_FAILED",
      responseMessage(payload) ?? "Supabase Auth could not create the invitation link",
    );
  }

  const linkProperties = isRecord(payload?.properties) ? payload.properties : payload;
  const actionLink = linkProperties?.action_link;
  const user = parseSupabaseAuthUser(payload?.user ?? payload);
  if (!user || typeof actionLink !== "string") {
    throw new ApiError(502, "SUPABASE_INVITE_FAILED", "Supabase Auth returned an incomplete invitation link");
  }

  let parsedActionLink: URL;
  try {
    parsedActionLink = new URL(actionLink);
  } catch {
    throw new ApiError(502, "SUPABASE_INVITE_FAILED", "Supabase Auth returned an invalid invitation link");
  }
  const isLocalHttp =
    process.env.NODE_ENV !== "production" &&
    parsedActionLink.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(parsedActionLink.hostname);
  if (parsedActionLink.protocol !== "https:" && !isLocalHttp) {
    throw new ApiError(502, "SUPABASE_INVITE_FAILED", "Supabase Auth returned an insecure invitation link");
  }

  return { user, actionLink: parsedActionLink.toString() };
}

export async function createSupabaseInviteLink(input: SetupLinkInput) {
  try {
    const result = await createSupabaseActionLink(input, "invite");
    return { userId: result.user.id, actionLink: result.actionLink };
  } catch (error) {
    const isRegisteredEmail = error instanceof ApiError &&
      /already\s+(?:been\s+)?registered|already exists/i.test(error.message);
    if (!isRegisteredEmail) throw error;

    const result = await createSupabaseActionLink(input, "recovery");
    const linkedUserId = result.user.user_metadata?.mdesk_user_id;
    const matchingEmail = result.user.email?.toLowerCase() === input.email.toLowerCase();
    if (linkedUserId !== input.localUserId || !matchingEmail) {
      throw new ApiError(
        409,
        "SUPABASE_ACCOUNT_CONFLICT",
        "This email already exists in Supabase Auth but is not linked to this M-DESK account. Use a different email or ask an administrator to reconcile the account.",
      );
    }
    return { userId: result.user.id, actionLink: result.actionLink };
  }
}

export async function signInWithSupabase(email: string, password: string, expectedUserId: string) {
  const url = getSupabaseUrl();
  const publishableKey = getPublicKey();
  const endpoint = new URL("/auth/v1/token?grant_type=password", url);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  const payload = await responseJson(response);
  if (response.status === 400 || response.status === 401) return false;
  if (!response.ok) {
    throw new ApiError(503, "SUPABASE_AUTH_UNAVAILABLE", "Supabase Auth could not complete sign-in");
  }
  const user = parseSupabaseAuthUser(payload?.user);
  return user?.id === expectedUserId;
}

export async function getSupabaseUserFromInvite(accessToken: string) {
  const url = getSupabaseUrl();
  const publishableKey = getPublicKey();
  const response = await fetch(new URL("/auth/v1/user", url), {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  const payload = await responseJson(response);
  const user = parseSupabaseAuthUser(payload);
  if (!response.ok || !user) {
    throw new ApiError(400, "INVALID_INVITATION", "This invitation link is invalid or expired");
  }
  return user;
}

export async function setSupabasePasswordFromInvite(accessToken: string, password: string) {
  const url = getSupabaseUrl();
  const publishableKey = getPublicKey();
  const response = await fetch(new URL("/auth/v1/user", url), {
    method: "PUT",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiError(400, "PASSWORD_SETUP_FAILED", "Supabase Auth could not set the password. Request a new invitation.");
  }
}

export async function updateSupabaseUserPassword(userId: string, password: string) {
  const url = getSupabaseUrl();
  const secretKey = getSecretKey();
  const response = await fetch(new URL(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, url), {
    method: "PUT",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiError(502, "PASSWORD_UPDATE_FAILED", "Supabase Auth could not update the password");
  }
}
