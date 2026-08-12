import { exchangeGoogleCode } from "@/lib/account/googleOAuth";
import { consumeOAuthState } from "@/lib/account/oauthState";
import { createUser, findUserByEmail, findUserByGoogleSub, linkGoogleAccount, markEmailVerified } from "@/lib/account/users";
import { createSession } from "@/lib/account/sessions";
import { setSessionCookie } from "@/lib/account/sessionCookie";

export const runtime = "nodejs";

function redirectToSignin(origin: string, error: string): Response {
  return Response.redirect(`${origin}/account/signin?error=${error}`, 303);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = await consumeOAuthState();

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectToSignin(url.origin, "google_state_mismatch");
  }

  let identity: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    identity = await exchangeGoogleCode(code);
  } catch (error) {
    console.error("[account] Google code exchange failed:", error);
    return redirectToSignin(url.origin, "google_exchange_failed");
  }

  let user = await findUserByGoogleSub(identity.sub);

  if (!user) {
    // Same email already has a password-based account -- link Google to it rather than
    // creating a second, disconnected account for the same person. Google has already
    // verified this address, so mark it verified here too if it wasn't already.
    const existingByEmail = await findUserByEmail(identity.email);
    if (existingByEmail) {
      await linkGoogleAccount(existingByEmail.id, identity.sub);
      if (!existingByEmail.emailVerifiedAt) await markEmailVerified(existingByEmail.id);
      user = existingByEmail;
    } else {
      user = await createUser({
        email: identity.email,
        googleSub: identity.sub,
        name: identity.name,
        emailVerified: identity.emailVerified,
      });
    }
  }

  const session = await createSession(user.id, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: request.headers.get("x-forwarded-for") ?? undefined,
  });
  await setSessionCookie(session);

  return Response.redirect(`${url.origin}/account`, 303);
}
