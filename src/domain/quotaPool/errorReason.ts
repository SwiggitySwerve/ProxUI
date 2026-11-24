/** Why the server could not read an account, when the hub says why. */
export type AccountErrorReason = 'signin-expired';

// The hub's status for a rejected refresh token (ProxD conductor_refresh.go) and the provider's
// own answer, e.g. Anthropic's {"error": "invalid_grant", "error_description": "Refresh token expired"}.
const SIGNIN_EXPIRED = /refresh token (invalid|expired)|invalid_grant/i;

/** The provider no longer accepts the credential's refresh token: only signing in again fixes it. */
export const isSignInExpiredMessage = (text: string) => SIGNIN_EXPIRED.test(text);
