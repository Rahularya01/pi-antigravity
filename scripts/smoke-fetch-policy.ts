/** Smoke failures distinguish broken content from explicitly observed upstream failure. */
export function isUpstreamAvailabilityError(message: string): boolean {
  return /HTTP (?:4\d\d|5\d\d)|no readable article content|overall (?:10-second )?deadline|Web fetch aborted|transport failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(
    message,
  );
}
export function classifyFetchSmoke(input: {
  found: boolean;
  canonicalObserved: boolean;
  assessment?: string;
  partial?: boolean | null;
  attempts?: Array<{ stage?: string; source?: string; outcome: string }>;
}): { status: "pass" | "warn" | "fail"; insufficientCoverage: boolean } {
  const unavailable = input.attempts?.some((attempt) => {
    if (attempt.stage === "redirect") return false;
    // An ordinary crawl-cache miss is not an availability failure.
    if ((attempt.stage ?? attempt.source) === "cache" && /HTTP (?:404|410)/.test(attempt.outcome))
      return false;
    return isUpstreamAvailabilityError(attempt.outcome);
  });
  if (unavailable && (input.assessment !== "readable" || input.partial === true))
    return { status: "warn", insufficientCoverage: true };
  if (!input.found || input.assessment !== "readable")
    return { status: "fail", insufficientCoverage: false };
  return { status: input.canonicalObserved ? "pass" : "warn", insufficientCoverage: false };
}
