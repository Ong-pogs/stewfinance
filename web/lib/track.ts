"use client";
function sessionId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem("stew_sid");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("stew_sid", id); }
  return id;
}
export function track(event: string, props?: Record<string, unknown> & { wallet?: string }) {
  try {
    const wallet = props?.wallet;
    fetch("/api/track", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, sessionId: sessionId(), wallet, props }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
