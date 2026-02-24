"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProfile } from "@/lib/actions/profile";
import type { Currency } from "@/lib/types";

const options: { value: Currency; symbol: string }[] = [
  { value: "EUR", symbol: "€" },
  { value: "USD", symbol: "$" },
];

export function CurrencyToggle({
  initialCurrency,
}: {
  initialCurrency: Currency;
}) {
  const [active, setActive] = useState<Currency>(initialCurrency);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSwitch(next: Currency) {
    if (next === active) return;
    setActive(next); // optimistic UI update

    startTransition(async () => {
      await updateProfile({ primary_currency: next });
      router.refresh(); // re-fetch all server components with new currency
    });
  }

  return (
    <div
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
            disabled={isPending}
            className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
              isActive
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {opt.symbol} {opt.value}
          </button>
        );
      })}
    </div>
  );
}
