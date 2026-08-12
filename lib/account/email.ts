// Resend, hand-rolled via a single fetch POST -- this is genuinely a one-endpoint call,
// same treatment tradingViewWebhook.ts already gives a webhook integration, not a
// dependency-worthy integration like expo-server-sdk (which earns its package for real
// batching/receipt-polling logic Resend doesn't need here).

export type SendEmailResult = { success: true } | { success: false; message: string };

async function sendEmail(input: { to: string; subject: string; html: string }): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!apiKey || !from) {
    return { success: false, message: "RESEND_API_KEY/EMAIL_FROM_ADDRESS not configured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: input.to, subject: input.subject, html: input.html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, message: `Resend returned ${res.status}: ${body}` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function sendVerificationEmail(to: string, verifyUrl: string): Promise<SendEmailResult> {
  return sendEmail({
    to,
    subject: "Verify your Forex AI account",
    html: `<p>Confirm your email address to finish creating your Forex AI account.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>`,
  });
}

export function sendPasswordResetEmail(to: string, resetUrl: string): Promise<SendEmailResult> {
  return sendEmail({
    to,
    subject: "Reset your Forex AI password",
    html: `<p>Click below to choose a new password.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email -- your password won't change.</p>`,
  });
}
