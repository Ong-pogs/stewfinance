"use client";

/**
 * RegisterSW — registers /sw.js client-side for PWA installability + offline
 * shell. Mounted once in app/layout.tsx.
 *
 * Safety:
 *   - No-op unless the browser supports service workers.
 *   - Registers ONLY in production, so `next dev` is never affected by a cached
 *     shell (avoids the classic "why is my edit not showing" SW trap).
 *   - Renders nothing.
 */

import { useEffect } from "react";

export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    // Register after load so SW work never competes with first paint.
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failure is non-fatal — the app works without the SW.
      });
    };
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
