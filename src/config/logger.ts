import pino from "pino";

// Pretty-printing is opt-in (PRETTY_LOGS=1), not inferred from NODE_ENV.
// Inferring it from NODE_ENV is what caused the original bug: if NODE_ENV
// is ever unset/misspelled/not exactly "production" at container start,
// this used to silently switch to the pino-pretty transport — which is a
// separate npm package that has to be require()'d at runtime and crashes
// the whole process if it isn't installed. Defaulting to plain JSON output
// removes that failure mode entirely; `npm run dev` sets PRETTY_LOGS=1
// explicitly for a nicer local console.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.PRETTY_LOGS === "1" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});
