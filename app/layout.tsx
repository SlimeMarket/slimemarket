import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SlimeMarket",
  description: "SlimeMarket — Arc-based digital marketplace & smart-contract escrow.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
