import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("supermemory", {
  env: {
    // Optional so the key can also be passed per call from the app.
    SUPERMEMORY_API_KEY: v.optional(v.string()),
  },
});
