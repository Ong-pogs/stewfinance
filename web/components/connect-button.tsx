"use client";
import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { track } from "@/lib/track";

export function ConnectButton() {
  const { connected, publicKey } = useWallet();
  useEffect(() => {
    if (connected && publicKey) track("connect", { wallet: publicKey.toBase58() });
  }, [connected, publicKey]);
  return <WalletMultiButton />;
}
