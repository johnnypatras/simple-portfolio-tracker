"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { Sentry.captureException(error); }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        <h2 className="text-xl font-semibold text-zinc-100 mb-2">
          Failed to load dashboard
        </h2>
        <p className="text-sm text-zinc-400 mb-6">
          Something went wrong while loading this page. This is usually
          temporary.
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
