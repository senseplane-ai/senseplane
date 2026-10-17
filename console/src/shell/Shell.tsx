// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The app shell: sidebar (logo, New chat, nav, recent chats, user) and the main
// area. On phones the sidebar folds into a top bar with a menu button.
import { type ReactNode, useEffect, useState } from "react";
import { Link, navigate, useLocation } from "../router";
import { Badge, Icon, type IconName, Logo } from "../ui";
import { useApp } from "./AppData";
import { isVideo } from "./sources";

interface NavItem { to: string; label: string; icon: IconName; match: (p: string) => boolean; extra?: ReactNode }

const starts = (prefix: string) => (p: string) => p === prefix || p.startsWith(`${prefix}/`);

function initials(text: string): string {
  const parts = text.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { sources, limits, unreadEvents, conversations, chatsAvailable, me, account, signOut } = useApp();
  const cams = (sources ?? []).filter(isVideo);
  const online = cams.filter((s) => s.status === "online").length;
  const anyLive = limits.live_view && online > 0;

  const main: NavItem[] = [
    { to: "/", label: "Ask", icon: "ask", match: (p) => p === "/" || starts("/chats")(p) },
    {
      to: "/cameras", label: "Cameras", icon: "camera", match: starts("/cameras"),
      extra: sources && cams.length > 0 ? <span className="nav-count" aria-label={`${online} of ${cams.length} online`}>{online}/{cams.length}</span> : null,
    },
    { to: "/live", label: "Live view", icon: "live", match: starts("/live"), extra: anyLive ? <span className="nav-live-dot" aria-label="Cameras live" /> : null },
    { to: "/events", label: "Events", icon: "events", match: starts("/events"), extra: unreadEvents > 0 ? <Badge label={`${unreadEvents} new`}>{unreadEvents > 99 ? "99+" : unreadEvents}</Badge> : null },
    { to: "/watches", label: "Watches", icon: "watch", match: starts("/watches") },
    { to: "/search", label: "Search history", icon: "search", match: starts("/search") },
  ];
  const admin: NavItem[] = [
    { to: "/agents", label: "Agents", icon: "agents", match: starts("/agents") },
    { to: "/webhooks", label: "Webhooks", icon: "webhooks", match: starts("/webhooks") },
    { to: "/usage", label: "Usage", icon: "usage", match: starts("/usage") },
    { to: "/settings", label: "Settings", icon: "settings", match: starts("/settings") },
  ];
  const item = (n: NavItem) => (
    <Link key={n.to} to={n.to} aria-current={n.match(pathname) ? "page" : undefined} onClick={onNavigate}>
      <Icon name={n.icon} size={16} />
      {n.label}
      {n.extra}
    </Link>
  );

  const who = me?.user.name || me?.user.email || account?.name || "Signed in";
  const sub = me ? me.account.name : account && who !== account.name ? account.name : "";
  const chats = (conversations ?? []).slice(0, 8);

  return (
    <>
      <Link to="/" className="side-logo" aria-label="Senseplane home" onClick={onNavigate}><Logo /></Link>
      <button type="button" className="btn btn-primary btn-md side-new" onClick={() => { navigate(`/?new=${Date.now()}`); onNavigate?.(); }}>
        <Icon name="plus" size={15} stroke={2} />New chat
      </button>
      <nav className="side-nav" aria-label="Console">
        {main.map(item)}
        <div className="side-divider" role="separator" />
        {admin.map(item)}
      </nav>
      {chatsAvailable && (
        <div className="side-chats">
          <span className="side-heading" id="recent-chats">Recent chats</span>
          <ul aria-labelledby="recent-chats">
            {chats.map((c) => (
              <li key={c.id}>
                <Link to={`/chats/${c.id}`} aria-current={pathname === `/chats/${c.id}` ? "page" : undefined} onClick={onNavigate} title={c.title ?? "Untitled chat"}>
                  {c.title || "Untitled chat"}
                </Link>
              </li>
            ))}
            {conversations && chats.length === 0 && <li className="side-empty">No chats yet</li>}
          </ul>
        </div>
      )}
      <div className="side-user">
        <span className="avatar" aria-hidden="true">{initials(who)}</span>
        <span className="side-user-text">
          <span className="side-user-name">{who}</span>
          {sub && <span className="side-user-sub">{sub}</span>}
        </span>
        <button type="button" className="icon-btn icon-btn-plain side-signout" aria-label="Sign out" title="Sign out" onClick={signOut} style={{ width: 30, height: 30 }}>
          <Icon name="signOut" size={16} />
        </button>
      </div>
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="topbar">
        <Link to="/" aria-label="Senseplane home"><Logo size={20} /></Link>
        <button
          type="button" className="icon-btn icon-btn-secondary" aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(!open)} style={{ width: 38, height: 38 }}
        >
          <Icon name={open ? "close" : "menu"} size={18} />
        </button>
      </header>
      <aside id="sidebar" className="sidebar" data-open={open || undefined} aria-label="Sidebar">
        <div className="sidebar-inner"><Sidebar onNavigate={() => setOpen(false)} /></div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
