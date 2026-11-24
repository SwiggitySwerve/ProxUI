/** OAuth Login on one hub: a sign-in started there is saved on that hub, not the default one. */
export const oauthPath = (instanceId: string) => `/oauth?source=${encodeURIComponent(instanceId)}`;
