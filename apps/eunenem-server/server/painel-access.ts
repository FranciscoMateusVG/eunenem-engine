export function shouldRedirectPainelRequest(input: {
  ownerAccountId: string;
  sessionAccountId: string | null;
}): boolean {
  return input.sessionAccountId === null || input.sessionAccountId !== input.ownerAccountId;
}
