import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";

import { Logout } from "#~/basics/logout";
import { botInviteUrl } from "#~/helpers/botPermissions";
import { useUser } from "#~/utils";

interface DiscordLayoutProps {
  children: React.ReactNode;
  rightPanel?: React.ReactNode;
  guilds: {
    id: string;
    name: string;
    icon?: string;
    hasBot: boolean;
    authz: string[];
  }[];
  manageableGuilds: {
    id: string;
    name: string;
    icon?: string;
    hasBot: boolean;
    authz: string[];
  }[];
}

export function DiscordLayout({
  children,
  rightPanel,
  guilds,
}: DiscordLayoutProps) {
  const user = useUser();
  const location = useLocation();
  const [accountExpanded, setAccountExpanded] = useState(false);
  const { guildId } = useParams();

  // Filter to only show manageable guilds (where Euno is installed) in the server selector
  const manageableGuilds = guilds.filter((guild) => guild.hasBot);

  const isActive = (href: string, strict = false) => {
    const isExact = location.pathname === href;
    return strict
      ? isExact
      : isExact || location.pathname.startsWith(href + "/");
  };

  return (
    <div className="bg-surface-deep flex h-screen text-stone-100">
      {/* Server Selector Column */}
      <div className="bg-surface-deep flex w-16 flex-col border-r border-stone-800">
        {/* Home/Euno Icon */}
        <div className="flex h-16 items-center justify-center border-b border-stone-800">
          <Link
            to="/app"
            className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl ${
              isActive("/app", true)
                ? "bg-accent-strong rounded-xl"
                : "bg-surface-raised hover:bg-surface-overlay"
            }`}
          >
            E
          </Link>
        </div>

        {/* Server Icons */}
        <div className="flex-1 space-y-2 overflow-y-auto py-3">
          {manageableGuilds.map((guild) => (
            <div key={guild.id} className="flex justify-center">
              <Link
                to={`/app/${guild.id}`}
                className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl ${
                  isActive(`/app/${guild.id}`)
                    ? "bg-accent-strong rounded-xl"
                    : "bg-surface-raised hover:bg-surface-overlay"
                }`}
                title={guild.name}
              >
                {guild.icon ? (
                  <img
                    src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`}
                    alt={guild.name}
                    className="h-10 w-10 rounded-xl"
                  />
                ) : (
                  <span className="font-semibold text-stone-100">
                    {guild.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </Link>
            </div>
          ))}
          <div className="flex justify-center">
            <Link
              target="_blank"
              to={botInviteUrl()}
              className={`bg-surface-overlay flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl hover:bg-stone-600`}
              title={"Add to server"}
            >
              <span className="font-semibold text-stone-100">+</span>
            </Link>
          </div>
        </div>

        {/* Settings gear at bottom */}
        {/* <div className="pb-3">
          <Link
            to={`/app/${guildId}/settings`}
            className={`mx-3 flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 ${
              isActive("/settings")
                ? "rounded-xl bg-indigo-600"
                : "bg-gray-700 hover:rounded-xl hover:bg-gray-600"
            }`}
          >
            <span className="text-lg">⚙️</span>
          </Link>
        </div> */}
      </div>

      {/* Channel Sidebar */}
      <div className="bg-surface-base flex w-60 flex-col">
        {/* Channel Header */}
        <div className="flex h-16 items-center border-b border-stone-700 px-4">
          <h2 className="font-serif text-lg font-semibold text-stone-100">
            Euno Dashboard
          </h2>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-4">
          {guildId ? (
            <>
              {guildId === "102860784329052160" && (
                <>
                  <Link
                    to={`/app/${guildId}/sh`}
                    className={`group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      isActive(`/app/${guildId}/sh`)
                        ? "bg-surface-overlay text-stone-100"
                        : "hover:bg-surface-overlay text-stone-400 hover:text-stone-100"
                    }`}
                  >
                    🌟 Star Hunter
                  </Link>
                  <hr className="border-stone-700" />
                </>
              )}
              <Link
                to={`/app/${guildId}`}
                className={`group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive(`/app/${guildId}`, true)
                    ? "bg-surface-overlay text-stone-100"
                    : "hover:bg-surface-overlay text-stone-400 hover:text-stone-100"
                }`}
              >
                📊 Overview
              </Link>
              <Link
                to={`/app/${guildId}/settings`}
                className={`group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive(`/app/${guildId}/settings`)
                    ? "bg-surface-overlay text-stone-100"
                    : "hover:bg-surface-overlay text-stone-400 hover:text-stone-100"
                }`}
              >
                ⚙️ Settings
              </Link>
            </>
          ) : null}
        </nav>

        {/* Expanded Account Menu */}
        {accountExpanded && (
          <div className="bg-surface-overlay border-t border-stone-700">
            <div className="px-3 py-2">
              <p className="mb-2 text-xs text-stone-500">Account</p>
              <div className="space-y-1">
                {/* <Link
                    to="/profile"
                    className="block rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100"
                  >
                    Profile
                  </Link> */}
                <Link
                  to="/profile"
                  className="block rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100"
                >
                  Profile
                </Link>

                <Link
                  to="/terms"
                  className="block rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100"
                >
                  Terms of Service
                </Link>
                <Link
                  to="/privacy"
                  className="block rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100"
                >
                  Privacy Policy
                </Link>
                <Link
                  to="mailto:support@euno.reactiflux.com"
                  className="block rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100"
                >
                  Contact Support
                </Link>

                <hr className="border-stone-700" />

                <div className="rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-600 hover:text-stone-100">
                  <Logout>Log Out</Logout>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Account Section */}
        <div className="bg-surface-base border-t border-stone-700">
          <button
            onClick={() => setAccountExpanded(!accountExpanded)}
            className="hover:bg-surface-overlay flex w-full items-center px-3 py-3 text-left text-sm transition-colors"
          >
            <div className="bg-accent-strong flex h-8 w-8 items-center justify-center rounded-full text-stone-100">
              {user.email?.charAt(0).toUpperCase()}
            </div>
            <div className="ml-3 min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-stone-100">
                {user.email?.split("@")[0]}
              </p>
              <p className="truncate text-xs text-stone-500">Online</p>
            </div>
            <svg
              className={`h-4 w-4 text-stone-500 transition-transform ${
                accountExpanded ? "rotate-180" : ""
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="bg-surface-raised flex flex-1 overflow-hidden">
        {/* Main Content */}
        <main className={`flex-1 overflow-auto ${rightPanel ? "pr-0" : ""}`}>
          {children}
        </main>

        {/* Right Panel (conditional) */}
        {rightPanel && (
          <aside className="bg-surface-base w-80 overflow-auto border-l border-stone-700">
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
