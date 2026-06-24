import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import Link from "next/link";
import { HeaderActions } from "../components/HeaderActions";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI YouTube Automation",
  description: "Self-improving content pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen antialiased`}>
        <Providers>
          <header className="sticky top-0 z-50 backdrop-blur-md bg-[#0b1020]/70 border-b border-white/10 shadow-sm">
            <nav className="mx-auto max-w-5xl flex items-center gap-6 px-6 py-4">
              <Link href="/" className="font-semibold text-lg bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">
                YT Automation
              </Link>
              <Link href="/runs" className="text-sm font-medium text-white/70 hover:text-white transition-colors">
                Runs
              </Link>
              <Link href="/schedules" className="text-sm font-medium text-white/70 hover:text-white transition-colors">
                Schedules
              </Link>
              <Link href="/analytics" className="text-sm font-medium text-white/70 hover:text-white transition-colors">
                Analytics
              </Link>
              <div className="ml-auto">
                <HeaderActions />
              </div>
            </nav>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
