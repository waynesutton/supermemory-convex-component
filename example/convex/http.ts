import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { auth } from "./auth";
import { components } from "./_generated/api";

const http = httpRouter();
// Exact auth routes first; the static catch-all serves everything else.
auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

export default http;
