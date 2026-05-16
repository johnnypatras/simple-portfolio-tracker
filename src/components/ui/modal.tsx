"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import FocusTrap from "focus-trap-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm overflow-y-auto p-4"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <FocusTrap focusTrapOptions={{ initialFocus: false, fallbackFocus: () => panelRef.current!, allowOutsideClick: true }}>
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md shadow-2xl flex flex-col max-h-[85dvh] outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 md:px-5 md:py-4 border-b border-zinc-800/50 shrink-0">
            <h2 id={titleId} className="text-base font-semibold text-zinc-100">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-lg text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <X aria-hidden="true" className="w-4 h-4" />
            </button>
          </div>
          {/* Body — scrollable when content exceeds viewport */}
          <div className="px-4 py-3 md:px-5 md:py-4 overflow-y-auto">{children}</div>
        </div>
      </FocusTrap>
    </div>
  );
}
