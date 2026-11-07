import { escapeHtml } from "@/lib/password-setup-email";

export type PasswordResetEmailInput = {
  to: string;
  url: string;
};

const GREEN = "#0e4d33";
const LINES = {
  intro: "We received a request to reset your M-DESK account password.",
  action: "Click the button below to create a new password.",
  expiry: "This secure link is valid for only 10 minutes and can be used once.",
  ignore: "If you did not request this password reset, you can safely ignore this email. Your existing password will remain unchanged.",
};

export function buildPasswordResetEmail({ to, url }: PasswordResetEmailInput) {
  const link = escapeHtml(url);
  const p = (text: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f2d27">${text}</p>`;

  return {
    to,
    subject: "Reset Your M-DESK Password",
    text: [
      "Hello,",
      LINES.intro,
      `Open this link to create a new password:\n${url}`,
      LINES.expiry,
      LINES.ignore,
      "Regards,\nM-DESK Team\nManikstu Agro Private Limited",
    ].join("\n\n"),
    html:
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="margin:0;padding:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea"><tr><td align="center" style="padding:24px 12px">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">` +
      `<tr><td style="background:${GREEN};padding:18px 28px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px">M-DESK</td></tr>` +
      `<tr><td style="padding:28px">` +
      p("Hello,") +
      p(LINES.intro) +
      p(LINES.action) +
      `<p style="margin:24px 0"><a href="${link}" style="display:inline-block;padding:13px 24px;background:${GREEN};color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700">Reset Password</a></p>` +
      p(LINES.expiry) +
      p(LINES.ignore) +
      `<p style="margin:24px 0 0;font-size:15px;line-height:1.55;color:#1f2d27">Regards,<br>M-DESK Team<br>Manikstu Agro Private Limited</p>` +
      `</td></tr></table></td></tr></table></body></html>`,
  };
}
