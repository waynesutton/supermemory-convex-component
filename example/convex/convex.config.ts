import { defineApp } from "convex/server";
import { v } from "convex/values";
import supermemory from "@waynesutton/convex-supermemory/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp({
  env: {
    SUPERMEMORY_API_KEY: v.optional(v.string()),
  },
});

// Passed by reference, so rotating the key in the dashboard takes effect
// without a redeploy.
app.use(supermemory, {
  env: { SUPERMEMORY_API_KEY: app.env.SUPERMEMORY_API_KEY },
});
app.use(rateLimiter);

export default app;
