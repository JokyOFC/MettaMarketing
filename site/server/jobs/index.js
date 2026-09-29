import { register as registerContracts } from "./contracts.js";
import { createJobs } from "./queue.js";
import { register as registerRenditions } from "./renditions.js";
import { register as registerZips } from "./zips.js";

// Creates the in-process queues and lets each job module register itself.
export function startJobs(ctx) {
  const jobs = createJobs(ctx);
  registerRenditions(jobs, ctx);
  registerZips(jobs, ctx);
  registerContracts(jobs, ctx);
  return jobs;
}
