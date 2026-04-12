import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "./providers";
import Link from "next/link";
import { YouTubeBadge } from "../components/YouTubeBadge";

export const metadata: Metadata = {
  title: "AI YouTube Automation",
  description: "Self-improving content pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <header className="border-b border-white/10">
            <nav className="mx-auto max-w-5xl flex items-center gap-6 px-6 py-4">
              <Link href="/" className="font-semibold">
                YT Automation
              </Link>
              <Link href="/runs" className="text-white/70 hover:text-white">
                Runs
              </Link>
              <div className="ml-auto">
                <YouTubeBadge />
              </div>
            </nav>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
