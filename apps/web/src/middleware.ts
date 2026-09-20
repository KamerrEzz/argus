// Coarse route guard. The session cookie is set by the API on the shared
// `localhost` host (cookies are port-agnostic), so a request to the web app
// carries `acr_session` too and this gives instant redirects without a flash.
// The authoritative check is `GET /auth/me` inside the shell: middleware only
// proves the cookie exists, not that it is valid.

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'acr_session';

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (pathname === '/login' || pathname.startsWith('/login/')) {
    if (hasSession) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('next', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
