"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "../lib/AuthContext";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";

export function UserDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuth();
  const router = useRouter();

  const qc = useQueryClient();
  const { data: ytStatus, isLoading: ytLoading } = useQuery({
    queryKey: ["yt-status"],
    queryFn: () => api.youtubeStatus(),
    refetchOnWindowFocus: true,
    enabled: !!user, // Only fetch if logged in
  });

  const disconnect = useMutation({
    mutationFn: () => api.youtubeDisconnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["yt-status"] }),
  });

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = () => {
    logout();
    router.push("/");
  };

  if (!user) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm font-medium text-white/80 hover:text-white transition-colors bg-white/5 border border-white/10 px-3 py-1.5 rounded-full"
      >
        <div className="w-6 h-6 rounded-full bg-indigo-500/50 flex items-center justify-center text-xs text-white">
          {user.email?.charAt(0).toUpperCase() || "U"}
        </div>
        <span>Account</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-[#0f172a] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <div className="text-sm font-medium text-white truncate">{user.email}</div>
          </div>
          
          <div className="p-2">
            <div className="px-2 py-2">
              <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                YouTube Connection
              </div>
              {ytLoading ? (
                <div className="text-xs text-white/40">Loading...</div>
              ) : ytStatus?.connected ? (
                <div className="flex flex-col gap-1">
                  <div className="text-xs text-emerald-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                    Connected to {ytStatus.channelTitle ?? ytStatus.channelId}
                  </div>
                  <button
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                    className="text-left text-xs text-red-400 hover:text-red-300 transition-colors mt-1"
                  >
                    {disconnect.isPending ? "Disconnecting..." : "Disconnect YouTube"}
                  </button>
                </div>
              ) : (
                <a
                  href={api.youtubeConnectUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center text-xs rounded-md bg-red-500/20 border border-red-500/40 text-red-200 px-3 py-2 hover:bg-red-500/30 transition-colors"
                >
                  Connect YouTube
                </a>
              )}
            </div>
          </div>

          <div className="p-2 border-t border-white/10">
            <button
              onClick={handleLogout}
              className="w-full text-left px-2 py-2 text-sm text-white/70 hover:text-white hover:bg-white/5 rounded-md transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
