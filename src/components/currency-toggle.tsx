"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProfile } from "@/lib/actions/profile";
import type { BaseCurrency } from "@/lib/types";

const options: { value: BaseCurrency; symbol: string }[] = [
  { value: "EUR", symbol: "€" },
  { value: "USD", symbol: "$" },
];

export function CurrencyToggle({
  initialCurrency,
}: {
  initialCurrency: BaseCurrency;
}) {
  const [active, setActive] = useState<BaseCurrency>(initialCurrency);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSwitch(next: BaseCurrency) {
    if (next === active) return;
    setActive(next); // optimistic UI update

    startTransition(async () => {
      await updateProfile({ primary_currency: next });
      router.refresh(); // re-fetch all server components with new currency
    });
  }

  return (
    <div
      role="group"
      aria-label="Display currency"
      className={`flex items-center bg-zinc-800/60 rounded-lg p-0.5 transition-opacity ${
        isPending ? "opacity-60" : ""
      }`}
    >
      {options.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            onClick={() => handleSwitch(opt.value)}
            aria-pressed={isActive}
            disabled={isPending}
            className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
              isActive
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-300"
            }`}
          >
            {opt.symbol} {opt.value}
          </button>
        );
      })}
    </div>
  );
}
