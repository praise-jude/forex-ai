import fs from "node:fs";
import { loadExecutionConfig } from "@/lib/market/executionConfig";
import { isEnvKillSwitchActive } from "@/lib/market/riskManager";

export const runtime = "nodejs";

function fileActive(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

export async function GET() {
  const config = loadExecutionConfig();
  const envControlled = isEnvKillSwitchActive();
  return Response.json({ active: envControlled || fileActive(config.killSwitchFile), envControlled });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== "pause" && action !== "resume") {
    return Response.json({ error: "invalid_action" }, { status: 400 });
  }

  const config = loadExecutionConfig();
  const envControlled = isEnvKillSwitchActive();

  // The file is the only part of the kill switch this app can actually control at
  // runtime — the env var is platform-managed (set in Railway's dashboard) and isn't
  // writable from within the running process. Resuming can't override it; stopping
  // trades no matter what always succeeds, since it only ever adds a block.
  if (action === "resume" && envControlled) {
    return Response.json(
      {
        error: "env_controlled",
        message: "Trading is paused via the platform's TRADING_KILL_SWITCH variable — this button can't override it.",
      },
      { status: 409 }
    );
  }

  try {
    if (action === "pause") fs.writeFileSync(config.killSwitchFile, "");
    else fs.rmSync(config.killSwitchFile, { force: true });
  } catch (error) {
    return Response.json({ error: "fs_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }

  return Response.json({ active: envControlled || fileActive(config.killSwitchFile), envControlled });
}
