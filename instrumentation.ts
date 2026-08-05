export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMarketEngine } = await import("./lib/market/bootstrap");
    startMarketEngine();
  }
}
