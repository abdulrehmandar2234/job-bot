// Shared pacing for job-site requests. Tests set `timing.scale = 0` so paced loops run instantly.
export const timing = { scale: 1 };
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * timing.scale));
