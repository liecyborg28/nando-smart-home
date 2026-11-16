import { after } from "next/server";

/**
 * Ask the host to keep the process alive until `task` settles, AFTER the response has been sent.
 *
 * Serverless platforms (Vercel) may freeze a function the moment the response is out, which would
 * drop work that was started but not awaited, such as the audit insert. Next.js `after()` maps to the
 * platform's own "wait until" primitive. On a long-running server it simply runs the task afterwards.
 *
 * Outside a Next.js request (unit tests, scripts) `after()` throws; there is nothing to extend then.
 */
export function afterResponse(task: () => Promise<void> | undefined): void {
  try {
    after(async () => {
      await task();
    });
  } catch {
    // Not inside a request scope.
  }
}
