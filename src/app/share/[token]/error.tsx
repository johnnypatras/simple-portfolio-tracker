"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function ShareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { Sentry.captureException(error); }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="max-w-md text-center">
        <h2 className="text-xl font-semibold text-zinc-100 mb-2">
          Unable to load portfolio
        </h2>
        <p className="text-sm text-zinc-400 mb-6">
          This shared portfolio could not be loaded. The link may be invalid or
          the portfolio is temporarily unavailable.
        </p>
        <button
          onClick={reset}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
