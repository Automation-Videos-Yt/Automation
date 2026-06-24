"use client";

import Link from "next/link";
import { useAuth } from "../lib/AuthContext";
import { UserDropdown } from "./UserDropdown";

export function HeaderActions() {
  const { user } = useAuth();

  if (!user) {
    return (
      <Link
        href="/login"
        className="text-sm font-medium text-white px-4 py-1.5 rounded-full bg-indigo-500 hover:bg-indigo-600 transition-colors"
      >
        Sign In
      </Link>
    );
  }

  return <UserDropdown />;
}
