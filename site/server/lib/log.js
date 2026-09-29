// Minimal leveled logger (ctx.log). Never pass passwords or tokens to it.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const at = (name, write) =>
    LEVELS[name] >= threshold
      ? (...args) => write(`${new Date().toISOString()} ${name.toUpperCase()}`, ...args)
      : () => {};
  return {
    debug: at("debug", console.debug),
    info: at("info", console.log),
    warn: at("warn", console.warn),
    error: at("error", console.error),
  };
}
