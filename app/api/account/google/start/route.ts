import { buildGoogleAuthUrl } from "@/lib/account/googleOAuth";
import { generateState, setOAuthState } from "@/lib/account/oauthState";

export const runtime = "nodejs";

export async function GET() {
  const state = generateState();
  await setOAuthState(state);
  return Response.redirect(buildGoogleAuthUrl(state), 302);
}
