import { afterEach, describe, expect, it } from "vitest";
import {
  getConfirmationMode,
  isProposalExpired,
  resetConfirmationModeForTests,
  setConfirmationMode,
} from "../confirmationMode";

describe("confirmationMode", () => {
  afterEach(() => {
    resetConfirmationModeForTests();
  });

  it("defaults to confirm mode with a 120 second proposal window", () => {
    expect(getConfirmationMode()).toEqual({ manualMode: "confirm", proposalTtlSeconds: 120 });
  });

  it("setConfirmationMode updates manualMode and proposalTtlSeconds independently", () => {
    setConfirmationMode({ manualMode: "signal_only" });
    expect(getConfirmationMode()).toEqual({ manualMode: "signal_only", proposalTtlSeconds: 120 });

    setConfirmationMode({ proposalTtlSeconds: 60 });
    expect(getConfirmationMode()).toEqual({ manualMode: "signal_only", proposalTtlSeconds: 60 });
  });

  it("ignores a non-positive or non-finite proposalTtlSeconds", () => {
    setConfirmationMode({ proposalTtlSeconds: 0 });
    expect(getConfirmationMode().proposalTtlSeconds).toBe(120);
    setConfirmationMode({ proposalTtlSeconds: -5 });
    expect(getConfirmationMode().proposalTtlSeconds).toBe(120);
    setConfirmationMode({ proposalTtlSeconds: Number.NaN });
    expect(getConfirmationMode().proposalTtlSeconds).toBe(120);
  });

  it("resetConfirmationModeForTests returns to the boot default", () => {
    setConfirmationMode({ manualMode: "signal_only", proposalTtlSeconds: 30 });
    resetConfirmationModeForTests();
    expect(getConfirmationMode()).toEqual({ manualMode: "confirm", proposalTtlSeconds: 120 });
  });

  describe("isProposalExpired", () => {
    const state = { manualMode: "confirm" as const, proposalTtlSeconds: 120 };

    it("is not expired comfortably inside the window", () => {
      expect(isProposalExpired(1_000_000, 1_000_000 + 60_000, state)).toBe(false);
    });

    it("is expired comfortably outside the window", () => {
      expect(isProposalExpired(1_000_000, 1_000_000 + 200_000, state)).toBe(true);
    });
  });
});
