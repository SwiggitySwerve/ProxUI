import { matchRoutes } from 'react-router-dom';
import {
  readPinnedCredentialFromState,
  type PinnedCredential,
} from '@/features/authFiles/unifiedList';

const AUTH_FILES_ROUTE = [{ path: '/auth-files' }];

export type LoginRedirect = {
  to: string;
  state?: { pinnedCredential: PinnedCredential };
};

/**
 * Where to go once the user is signed in: the full location (path, query, hash) that
 * ProtectedRoute bounced to /login, plus a validated Auth Files credential pin when the
 * redirect lands back on /auth-files. Router state is only ever set by the app itself, but it
 * is still checked so a crafted history entry cannot send anyone off-site or back to /login.
 */
export function resolveLoginRedirect(state: unknown): LoginRedirect {
  const from = (state as { from?: Record<string, unknown> } | null)?.from;
  const pathname = from?.pathname;
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('\\') ||
    // The login route also matches /login/, /login// and /LOGIN; never send anyone back to it.
    /^\/login\/*$/i.test(pathname)
  ) {
    return { to: '/' };
  }
  const search = typeof from?.search === 'string' && from.search.startsWith('?') ? from.search : '';
  const hash = typeof from?.hash === 'string' && from.hash.startsWith('#') ? from.hash : '';
  const to = `${pathname}${search}${hash}`;
  if (!matchRoutes(AUTH_FILES_ROUTE, pathname)) return { to };
  const pinnedCredential = readPinnedCredentialFromState(from?.state);
  return pinnedCredential ? { to, state: { pinnedCredential } } : { to };
}
