import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Top of every UTC hour, so "resets every hour" means something a visitor
// can predict. The UI counts down to it.
// eslint-disable-next-line @convex-dev/no-top-of-hour-crons
crons.hourly("reset demo data", { minuteUTC: 0 }, internal.demo.reset, {});

export default crons;
