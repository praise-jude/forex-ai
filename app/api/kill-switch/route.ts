import fs from "node:fs";
import type { AccountKey } from "@/lib/market/types";
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

function accountFrom(value: string | null): AccountKey {
  return value === "demo" ? "demo" : "live";
}

export async function GET(request: Request) {
  const account = accountFrom(new URL(request.url).searchParams.get("account"));
  const config = loadExecutionConfig(account);
  const envControlled = isEnvKillSwitchActive();
  return Response.json({ active: envControlled || fileActive(config.killSwitchFile), envControlled });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { action?: string; account?: string } | null;
  const action = body?.action;
  if (action !== "pause" && action !== "resume") {
    return Response.json({ error: "invalid_action" }, { status: 400 });
  }

  const account = accountFrom(body?.account ?? null);
  const config = loadExecutionConfig(account);
  // The TRADING_KILL_SWITCH env var is a single global "stop everything" switch, on
  // purpose (see engineMode.ts design notes) — it applies regardless of which account's
  // file-based switch is being toggled here, and can't be overridden by resuming either.
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
