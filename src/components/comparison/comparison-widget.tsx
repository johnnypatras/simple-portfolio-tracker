"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, Loader2 } from "lucide-react";
import {
  getComparisonData,
  type ComparisonData,
} from "@/lib/actions/comparison";
import { ComparisonContent } from "./comparison-content";

interface ComparisonWidgetProps {
  token: string;
  ownerName: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ComparisonWidget({
  token,
  ownerName,
  isOpen,
  onClose,
}: ComparisonWidgetProps) {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  // Fetch comparison data on first open
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getComparisonData(token);
      if (result.ok) {
        setData(result.data);
      } else {
        setError(
          result.error === "invalid_token"
            ? "This share link has expired."
            : "Could not load comparison data."
        );
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isOpen && !hasFetched.current) {
      hasFetched.current = true;
      fetchData();
    }
  }, [isOpen, fetchData]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay to avoid closing immediately from the trigger click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [isOpen, onClose]);

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Prevent body scroll when open on mobile
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Panel — right slide on desktop, bottom sheet on mobile */}
      <div
        ref={panelRef}
        className={`
          fixed z-50 bg-zinc-900 border border-zinc-800/50 shadow-2xl shadow-black/50
          transition-transform duration-300 ease-out overflow-y-auto

          bottom-0 left-0 right-0 max-h-[75vh] rounded-t-2xl
          sm:bottom-auto sm:left-auto sm:top-0 sm:right-0
          sm:w-96 sm:h-full sm:max-h-none sm:rounded-t-none sm:rounded-l-xl

          ${
            isOpen
              ? "translate-y-0 sm:translate-x-0"
              : "translate-y-full sm:translate-y-0 sm:translate-x-full"
          }
        `}
      >
        {/* Drag handle (mobile only) */}
        <div className="sm:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="sticky top-0 bg-zinc-900 z-10 flex items-center justify-between px-4 py-3 border-b border-zinc-800/50">
          <h2 className="text-sm font-semibold text-zinc-100">
            You vs {ownerName}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content area */}
        <div className="px-4 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
              <span className="text-xs text-zinc-500">
                Loading comparison...
              </span>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <span className="text-sm text-zinc-400">{error}</span>
              <button
                onClick={() => {
                  hasFetched.current = false;
                  fetchData();
                }}
                className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {!loading && !error && data && <ComparisonContent data={data} />}
        </div>
      </div>
    </>
  );
}
