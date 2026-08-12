"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      // Always the same generic message regardless of what the server actually found --
      // matches the API route's own deliberate email-enumeration protection.
      setMessage(json.message ?? "If an account exists for that email, a reset link has been sent.");
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-zinc-500">Enter your email and we&apos;ll send you a reset link.</p>
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
        {message && <p className="text-xs text-zinc-400">{message}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </>
  );
}

function ConfirmResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Something went wrong.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1 className="text-lg font-semibold text-emerald-400">Password updated</h1>
        <p className="mt-2 text-sm text-zinc-400">You can now sign in with your new password.</p>
        <Link
          href="/account/signin"
          className="mt-5 inline-block rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
        >
          Sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">New password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          <span className="text-[11px] text-zinc-500">At least 8 characters.</span>
        </label>
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
    </>
  );
}

function ResetPasswordContent() {
  const token = useSearchParams().get("token");
  return <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6">{token ? <ConfirmResetForm token={token} /> : <RequestResetForm />}</div>;
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <Suspense fallback={null}>
        <ResetPasswordContent />
      </Suspense>
    </main>
  );
}
