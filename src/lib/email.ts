import nodemailer from "nodemailer";
import { ApiError } from "@/lib/validation";
import { buildPasswordSetupEmail, type PasswordSetupEmailInput } from "@/lib/password-setup-email";

function getSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const portValue = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM?.trim();

  const missing = [
    !host && "SMTP_HOST",
    !portValue && "SMTP_PORT",
    !user && "SMTP_USER",
    !password && "SMTP_PASSWORD",
    !from && "SMTP_FROM",
  ].filter((key): key is string => Boolean(key));
  if (missing.length > 0) {
    throw new ApiError(
      503,
      "SMTP_NOT_CONFIGURED",
      "Set the server environment variables: " + missing.join(", "),
    );
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(503, "SMTP_NOT_CONFIGURED", "SMTP_PORT must be a valid port number");
  }

  return {
    host: host!,
    port,
    user: user!,
    password: password!,
    from: from!,
    secure: port === 465 || port === 2465,
  };
}

export async function sendPasswordSetupEmail(input: PasswordSetupEmailInput) {
  const config = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.secure ? {} : { requireTLS: true }),
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  await transporter.sendMail({
    from: config.from,
    ...buildPasswordSetupEmail(input),
  });
}
