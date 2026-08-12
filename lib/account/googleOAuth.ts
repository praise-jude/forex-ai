import { OAuth2Client } from "google-auth-library";

// The redirect/code-exchange flow itself is a plain fetch-shaped call via the SDK's own
// helpers (not hand-parsed JWT/JWKS) -- but the one genuinely crypto-sensitive step,
// verifying the returned ID token's signature/audience/issuer, uses google-auth-library's
// own verifyIdToken(), Google's documented recommendation, which handles their JWKS key
// rotation for us. Same "small trusted library for the one real crypto step" posture as
// passwords.ts's use of bcryptjs.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function client(): OAuth2Client {
  return new OAuth2Client({
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: requireEnv("GOOGLE_OAUTH_REDIRECT_URI"),
  });
}

/** The URL to send the browser to for Google Sign-In. `state` is a short-lived random
 * value the caller round-trips through its own httpOnly cookie (double-submit) --
 * verified on callback, no server-side state store needed. */
export function buildGoogleAuthUrl(state: string): string {
  return client().generateAuthUrl({
    response_type: "code",
    access_type: "online", // no refresh token needed -- this app only ever verifies identity, doesn't call Google APIs on the user's behalf later
    scope: ["openid", "email", "profile"],
    state,
  });
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
}

/** Exchanges the authorization code from Google's redirect for tokens, then verifies
 * the returned ID token's signature/audience/issuer before trusting any claim in it --
 * never reads the email/sub off an unverified token. */
export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const oauth2Client = client();
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return an id_token");

  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: requireEnv("GOOGLE_CLIENT_ID"),
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Google ID token had no payload");
  if (!payload.email) throw new Error("Google ID token had no email claim");

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified ?? false,
    name: payload.name,
  };
}
