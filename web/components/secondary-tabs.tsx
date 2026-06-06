"use client";
import { useState, type ReactNode } from "react";

type TabKey = "leaderboard" | "badges" | "history" | "activity";

const TABS: { key: TabKey; label: string }[] = [
  { key: "leaderboard", label: "Leaderboard" },
  { key: "badges", label: "Badges" },
  { key: "history", label: "History" },
  { key: "activity", label: "Activity" },
];

/**
 * SecondaryTabs — hosts the secondary panels (Leaderboard / Badges / History /
 * Activity) and renders ONE at a time. Pure presentation: it takes the already
 * rendered panels as props and toggles which is visible via local state.
 */
export function SecondaryTabs({
  leaderboard,
  badges,
  history,
  activity,
}: {
  leaderboard: ReactNode;
  badges: ReactNode;
  history: ReactNode;
  activity: ReactNode;
}) {
  const [active, setActive] = useState<TabKey>("leaderboard");

  const panels: Record<TabKey, ReactNode> = {
    leaderboard,
    badges,
    history,
    activity,
  };

  return (
    <div>
      <div role="tablist" className="flex gap-2">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(tab.key)}
              className={`rounded-[--radius] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="mt-4">
        {panels[active]}
      </div>
    </div>
  );
}
