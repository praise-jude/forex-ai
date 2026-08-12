import { redirect } from "next/navigation";
import { getSessionCookie } from "@/lib/account/sessionCookie";
import { getSessionUserId } from "@/lib/account/sessions";
import { findUserById } from "@/lib/account/users";
import { SignOutButton } from "./SignOutButton";

// Stage 1 placeholder -- becomes the real customer portal home (subscription, API
// token, usage) in later stages. For now it just proves the account/session system
// actually works end to end.
export default async function AccountPage() {
  const rawToken = await getSessionCookie();
  const userId = rawToken ? await getSessionUserId(rawToken) : null;
  if (!userId) redirect("/account/signin");

  const user = await findUserById(userId);
  if (!user) redirect("/account/signin");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 p-5 text-zinc-100">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold">Welcome, {user.name ?? user.email}</h1>
        <p className="mt-1 text-sm text-zinc-500">{user.email}</p>

        <div className="mt-4 flex items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2.5 py-1 font-semibold ${
              user.emailVerifiedAt ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
            }`}
          >
            {user.emailVerifiedAt ? "Email verified" : "Email not verified"}
          </span>
          {user.googleSub && <span className="rounded-full bg-sky-500/15 px-2.5 py-1 font-semibold text-sky-400">Google linked</span>}
        </div>

        <p className="mt-5 text-xs text-zinc-500">API access, subscriptions, and usage will show up here in a future update.</p>

        <SignOutButton />
      </div>
    </main>
  );
}
