"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: name || undefined }),
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
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold">Create your Forex AI account</h1>
        <p className="mt-1 text-sm text-zinc-500">API access for developers, traders, and trading platforms.</p>

        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Full name (optional)</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
          </label>
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
            {busy ? "Creating account…" : "Create account"}
          </button>
        </form>

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
          Already have an account?{" "}
          <Link href="/account/signin" className="text-sky-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
