import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveSession, isKillzone } from "../sessions";

// LONDON/NEW_YORK are read from process.env once at module load (see sessions.ts's own
// comment) -- mutating process.env after this file's top-level import has already run
// has no effect on the already-imported module's cached constants. Testing an override
// requires a genuinely fresh module evaluation, same as deviceStoreTestHelper.ts's own
// vi.resetModules() + dynamic import pattern for its own load-time config.
async function loadSessionsWithEnv(env: Record<string, string>): Promise<typeof import("../sessions")> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return import("../sessions");
}

const ENV_VARS = ["LONDON_START_HOUR", "LONDON_END_HOUR", "NEW_YORK_START_HOUR", "NEW_YORK_END_HOUR"];

afterEach(() => {
  for (const name of ENV_VARS) delete process.env[name];
});

describe("getActiveSession -- winter (GMT + EST, no DST anywhere)", () => {
  it("classifies 8am London local time as london", () => {
    expect(getActiveSession(Date.UTC(2026, 0, 15, 8, 0))).toBe("london");
  });

  it("excludes the 11am London local boundary", () => {
    expect(getActiveSession(Date.UTC(2026, 0, 15, 11, 0))).not.toBe("london");
  });

  it("classifies 8am New York local time (EST, UTC-5) as newyork", () => {
    expect(getActiveSession(Date.UTC(2026, 0, 15, 13, 0))).toBe("newyork");
  });

  it("excludes the 12pm New York local boundary", () => {
    expect(getActiveSession(Date.UTC(2026, 0, 15, 17, 0))).not.toBe("newyork");
  });
});

// 2026-08-12 (today, per the conversation this fix came from) -- both the UK (BST,
// UTC+1) and US (EDT, UTC-4) are in daylight saving. Ground truth for the exact 2026
// transition dates (London 2026-03-29 -> 2026-10-25, New York 2026-03-08 -> 2026-11-01)
// was confirmed directly against Node's own ICU data before writing these, not assumed.
describe("getActiveSession -- summer (BST + EDT) -- the actual bug this fixes", () => {
  it("classifies 8am London local time (BST, UTC+1 => 07:00 UTC) as london -- the old fixed-UTC-8 code missed this entirely", () => {
    expect(getActiveSession(Date.UTC(2026, 7, 12, 7, 0))).toBe("london");
  });

  it("excludes 11am London local time (BST => 10:00 UTC) -- the old code wrongly included this as 'london' since raw UTC hour 10 was inside its fixed window", () => {
    expect(getActiveSession(Date.UTC(2026, 7, 12, 10, 0))).not.toBe("london");
  });

  it("classifies 8am New York local time (EDT, UTC-4 => 12:00 UTC) as newyork -- the old fixed-UTC-13 code missed this entirely", () => {
    expect(getActiveSession(Date.UTC(2026, 7, 12, 12, 0))).toBe("newyork");
  });

  it("excludes 12pm New York local time (EDT => 16:00 UTC) -- the old code wrongly included this as 'newyork' since raw UTC hour 16 was inside its fixed window", () => {
    expect(getActiveSession(Date.UTC(2026, 7, 12, 16, 0))).not.toBe("newyork");
  });
});

describe("getActiveSession -- DST gap weeks, proving London and New York are computed independently", () => {
  it("2026-03-15: US already in EDT, UK still in GMT -- both regions' 8am killzone starts are still correctly detected on their own calendars", () => {
    expect(getActiveSession(Date.UTC(2026, 2, 15, 8, 0))).toBe("london"); // London still GMT, 8am local = 08:00 UTC
    expect(getActiveSession(Date.UTC(2026, 2, 15, 12, 0))).toBe("newyork"); // NY already EDT, 8am local = 12:00 UTC
  });

  it("2026-10-28: UK back to GMT, US still in EDT -- same independence in the reverse direction", () => {
    expect(getActiveSession(Date.UTC(2026, 9, 28, 8, 0))).toBe("london"); // London back to GMT, 8am local = 08:00 UTC
    expect(getActiveSession(Date.UTC(2026, 9, 28, 12, 0))).toBe("newyork"); // NY still EDT, 8am local = 12:00 UTC
  });
});

describe("getActiveSession -- Asia and off-session", () => {
  it("still classifies the Asia window from a fixed UTC range (Japan doesn't observe DST)", () => {
    expect(getActiveSession(Date.UTC(2026, 7, 12, 1, 0))).toBe("asia");
  });

  it("falls back to off-session outside every window, in both winter and summer", () => {
    expect(getActiveSession(Date.UTC(2026, 0, 15, 5, 0))).toBe("off-session");
    expect(getActiveSession(Date.UTC(2026, 7, 12, 20, 0))).toBe("off-session");
  });
});

describe("isKillzone", () => {
  it("is true during london or newyork, false otherwise -- checked against real BST hours", () => {
    expect(isKillzone(Date.UTC(2026, 7, 12, 7, 0))).toBe(true); // 8am London local (BST)
    expect(isKillzone(Date.UTC(2026, 7, 12, 12, 0))).toBe(true); // 8am NY local (EDT)
    expect(isKillzone(Date.UTC(2026, 7, 12, 1, 0))).toBe(false); // asia
    expect(isKillzone(Date.UTC(2026, 7, 12, 20, 0))).toBe(false); // off-session
  });
});

describe("env var overrides -- interpreted as that region's local hour, not raw UTC", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("respects a custom LONDON_START_HOUR/END_HOUR as local London hours", async () => {
    const mod = await loadSessionsWithEnv({ LONDON_START_HOUR: "9", LONDON_END_HOUR: "10" });
    // 9am London local (BST => 08:00 UTC) now qualifies; the old default 8am no longer does.
    expect(mod.getActiveSession(Date.UTC(2026, 7, 12, 8, 0))).toBe("london");
    expect(mod.getActiveSession(Date.UTC(2026, 7, 12, 7, 0))).not.toBe("london");
  });

  it("respects a custom NEW_YORK_START_HOUR/END_HOUR as local New York hours", async () => {
    const mod = await loadSessionsWithEnv({ NEW_YORK_START_HOUR: "9", NEW_YORK_END_HOUR: "10" });
    // 9am NY local (EDT => 13:00 UTC) now qualifies; the old default 8am no longer does.
    expect(mod.getActiveSession(Date.UTC(2026, 7, 12, 13, 0))).toBe("newyork");
    expect(mod.getActiveSession(Date.UTC(2026, 7, 12, 12, 0))).not.toBe("newyork");
  });

  it("ignores an invalid override (start >= end) and falls back to the default window", async () => {
    const mod = await loadSessionsWithEnv({ LONDON_START_HOUR: "12", LONDON_END_HOUR: "10" }); // invalid: start >= end
    expect(mod.getActiveSession(Date.UTC(2026, 7, 12, 7, 0))).toBe("london"); // still the 8am-local default
  });
});
