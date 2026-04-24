import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { saveGmailConfig } from '@/lib/gmail-api';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const appUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

  if (error) {
    return NextResponse.redirect(`${appUrl}/emails?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return NextResponse.redirect(`${appUrl}/emails?error=no_code`);
  }

  // Vérification CSRF
  const cookieStore = await cookies();
  const savedState = cookieStore.get('gmail_oauth_state')?.value;
  if (!savedState || savedState !== state) {
    return NextResponse.redirect(`${appUrl}/emails?error=invalid_state`);
  }

  // Échange code → tokens
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error('[gmail/callback] token error:', err);
    return NextResponse.redirect(`${appUrl}/emails?error=token_exchange`);
  }

  const tokens = await tokenResp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    return NextResponse.redirect(`${appUrl}/emails?error=no_refresh_token`);
  }

  // Récupérer l'email de l'utilisateur
  const userinfoResp = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userinfo = await userinfoResp.json() as { email?: string };

  // Sauvegarder en base
  await saveGmailConfig({
    email: userinfo.email ?? 'inconnu',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  });

  const resp = NextResponse.redirect(`${appUrl}/emails?connected=1`);
  resp.cookies.delete('gmail_oauth_state');
  return resp;
}
