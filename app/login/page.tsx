"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Real password field + submit button (unlike the pre-existing Basic Auth prompt, a
// native browser dialog outside the page's DOM) -- lets a real password manager offer
// to save/autofill this, which was the whole point (see dashboardSession.ts's own doc
// comment). This is the operator's own single-shared-password dashboard gate, separate
// from /account/signin's real per-user customer login.
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Something went wrong.");
        return;
      }
      // Only ever a same-app relative path -- `next` came off proxy.ts's own redirect,
      // but never trust a query param as a full URL without checking it stays local.
      router.push(next && next.startsWith("/") ? next : "/dashboard");
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6">
      <h1 className="text-lg font-semibold">Forex AI</h1>
      <p className="mt-1 text-sm text-zinc-500">Enter your dashboard password to continue.</p>

      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </label>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
