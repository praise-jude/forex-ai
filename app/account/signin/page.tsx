"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

const OAUTH_ERROR_MESSAGE: Record<string, string> = {
  google_state_mismatch: "The Google sign-in attempt expired or was invalid — please try again.",
  google_exchange_failed: "Google sign-in failed — please try again.",
};

function SigninForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(oauthError ? (OAUTH_ERROR_MESSAGE[oauthError] ?? "Sign-in failed.") : null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Something went wrong.");
        return;
      }
      router.push("/account");
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6">
      <h1 className="text-lg font-semibold">Welcome back</h1>
      <p className="mt-1 text-sm text-zinc-500">Sign in to your Forex AI account.</p>

      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Password</span>
          <input
            type="password"
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

      <p className="mt-3 text-center text-xs">
        <Link href="/account/reset-password" className="text-sky-400 hover:underline">
          Forgot password?
        </Link>
      </p>

      <div className="my-4 flex items-center gap-3 text-[11px] text-zinc-600">
        <div className="h-px flex-1 bg-white/10" />
        OR
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <a
        href="/api/account/google/start"
        className="flex w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700"
      >
        Continue with Google
      </a>

      <p className="mt-5 text-center text-xs text-zinc-500">
        Don&apos;t have an account?{" "}
        <Link href="/account/signup" className="text-sky-400 hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}

export default function SigninPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <Suspense fallback={null}>
        <SigninForm />
      </Suspense>
    </main>
  );
}
