import Link from "next/link";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const verified = status === "verified";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6 text-center">
        {verified ? (
          <>
            <h1 className="text-lg font-semibold text-emerald-400">Email verified</h1>
            <p className="mt-2 text-sm text-zinc-400">Your address is confirmed. You&apos;re all set.</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-rose-400">Link invalid or expired</h1>
            <p className="mt-2 text-sm text-zinc-400">
              This verification link is no longer valid. Sign in and a fresh one can be requested from your account page.
            </p>
          </>
        )}
        <Link
          href="/account"
          className="mt-5 inline-block rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
        >
          Go to your account
        </Link>
      </div>
    </main>
  );
}
