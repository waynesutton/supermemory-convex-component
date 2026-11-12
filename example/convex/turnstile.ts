// Cloudflare Turnstile server-side check. Plain helper, no Convex functions.
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token: unknown): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fail closed: a missing secret must not turn the check off.
    throw new Error("Turnstile is not configured on this deployment.");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new Error("Complete the human check first.");
  }
  const body = new URLSearchParams({ secret, response: token });
  const response = await fetch(VERIFY_URL, { method: "POST", body });
  if (!response.ok) throw new Error("Human check could not be verified.");
  const result = (await response.json()) as {
    success: boolean;
    hostname?: string;
  };
  if (!result.success) throw new Error("Human check failed. Try again.");
  // Set in production so tokens solved on another site are refused.
  const expected = process.env.TURNSTILE_EXPECTED_HOSTNAME;
  if (expected && result.hostname !== expected) {
    throw new Error("Human check came from an unexpected site.");
  }
}
