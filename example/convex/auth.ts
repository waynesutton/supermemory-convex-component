import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount } from "@convex-dev/auth/server";
import { verifyTurnstile } from "./turnstile";
import { rateLimiter } from "./demo";

// Convex Auth's Anonymous provider, plus a Turnstile check before the account
// is created. Anonymous's own `profile` hook is synchronous, so the check has
// to live in `authorize`.
const TurnstileAnonymous = ConvexCredentials({
  id: "anonymous",
  authorize: async (params, ctx) => {
    await verifyTurnstile(params.turnstileToken);
    const { ok } = await rateLimiter.limit(ctx, "signup");
    if (!ok) throw new Error("The demo is busy. Try again in a few minutes.");
    const { user } = await createAccount(ctx, {
      provider: "anonymous",
      account: { id: crypto.randomUUID() },
      profile: { isAnonymous: true },
    });
    return { userId: user._id };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [TurnstileAnonymous],
});
