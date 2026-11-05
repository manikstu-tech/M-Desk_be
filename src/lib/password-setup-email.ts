export type PasswordSetupEmailInput = {
  email: string;
  name: string;
  actionLink: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function buildPasswordSetupEmail(input: PasswordSetupEmailInput) {
  const safeName = escapeHtml(input.name);
  const safeActionLink = escapeHtml(input.actionLink);

  return {
    to: input.email,
    subject: "Set your M-DESK password",
    text:
      "Hello " + input.name + ",\n\n" +
      "A Super Admin created a M-DESK account for you. Set your password using this single-use link:\n" +
      input.actionLink + "\n\n" +
      "The link expires according to the Supabase Auth Email OTP Expiration setting. If it expires, ask a Super Admin to send a new link.\n\n" +
      "If you did not expect this email, you can ignore it.",
    html:
      "<!doctype html><html><body>" +
      "<p>Hello " + safeName + ",</p>" +
      "<p>A Super Admin created a M-DESK account for you. Use the button below to set your password.</p>" +
      "<p><a href=\"" + safeActionLink + "\" style=\"display:inline-block;padding:12px 18px;background:#17324d;color:#fff;text-decoration:none;border-radius:8px;font-weight:600\">Set password</a></p>" +
      "<p>This single-use link expires according to the Supabase Auth Email OTP Expiration setting. If it expires, ask a Super Admin to send a new link.</p>" +
      "<p>If you did not expect this email, you can ignore it.</p>" +
      "</body></html>",
  };
}
