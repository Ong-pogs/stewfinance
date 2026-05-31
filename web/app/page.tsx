"use client";
import Link from "next/link";
import { useEffect } from "react";
import { track } from "@/lib/track";

export default function Home() {
  useEffect(() => { track("visit", { props: { page: "/" } }); }, []);
  return (
    <main className="mx-auto max-w-3xl px-6 py-20 text-center">
      <h1 className="text-5xl font-bold tracking-tight">
        A savings account where the <span className="stew-accent">interest is the prize</span>.
      </h1>
      <p className="mt-6 text-lg text-zinc-400">
        Deposit USDC. Your principal stays yours. Each week the pooled yield becomes one
        winner&apos;s prize. No loss, all upside.
      </p>
      <div className="mt-10">
        <Link href="/app"
          className="stew-bg cauldron-glow inline-block rounded-xl px-8 py-4 font-semibold text-white">
          Try the demo →
        </Link>
      </div>
      <ol className="mt-16 grid gap-6 text-left sm:grid-cols-3">
        <li className="rounded-xl border border-zinc-800 p-5">
          <div className="stew-accent text-sm font-mono">01</div>
          <div className="mt-2 font-semibold">Deposit USDC</div>
          <div className="mt-1 text-sm text-zinc-400">Min 10. Withdraw anytime (24h cooldown).</div>
        </li>
        <li className="rounded-xl border border-zinc-800 p-5">
          <div className="stew-accent text-sm font-mono">02</div>
          <div className="mt-2 font-semibold">Pool earns yield</div>
          <div className="mt-1 text-sm text-zinc-400">Pooled USDC earns interest while you hold.</div>
        </li>
        <li className="rounded-xl border border-zinc-800 p-5">
          <div className="stew-accent text-sm font-mono">03</div>
          <div className="mt-2 font-semibold">Weekly prize</div>
          <div className="mt-1 text-sm text-zinc-400">The interest goes to one winner. Principal stays.</div>
        </li>
      </ol>
    </main>
  );
}
