// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Shared, lightly polled state for the signed-in console: sources, account and
// limits, the user, recent chats and the unread events count. Pages read it
// with useApp() instead of each fetching the same lists.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Senseplane, type Source } from "senseplane";
import {
  type AccountWithLimits, ApiExtra, type Conversation, DEFAULT_LIMITS, type Limits, type Me, isUnavailable,
} from "../api/extra";
import { prefs } from "../session";

export interface AppData {
  apiUrl: string;
  apiKey: string;
  client: Senseplane;
  extra: ApiExtra;
  sources: Source[] | null;
  refreshSources: () => Promise<void>;
  /** Update one source in the shared list after a PATCH. */
  putSource: (s: Source) => void;
  account: AccountWithLimits | null;
  limits: Limits;
  me: Me | null;
  /** null while loading; [] when there are none or the server has no conversations API. */
  conversations: Conversation[] | null;
  chatsAvailable: boolean;
  refreshConversations: () => Promise<void>;
  unreadEvents: number;
  markEventsSeen: () => void;
  signOut: () => void;
}

const Ctx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppDataProvider");
  return v;
}

/** For tests and stories: provide a ready-made value. */
export const AppDataContext = Ctx;

const SOURCES_POLL_MS = 10_000;
const EVENTS_POLL_MS = 30_000;

export function AppDataProvider({ apiUrl, apiKey, onUnauthorized, onSignOut, children }: {
  apiUrl: string; apiKey: string; onUnauthorized: () => void; onSignOut: () => void; children: ReactNode;
}) {
  // A 401 on any call means the session expired or the key was revoked.
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const guardedFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 401) unauthorized.current();
    return res;
  }, []);
  const client = useMemo(() => new Senseplane({ apiKey, baseUrl: apiUrl, fetch: guardedFetch }), [apiKey, apiUrl, guardedFetch]);
  const extra = useMemo(() => new ApiExtra(apiUrl, apiKey, guardedFetch), [apiKey, apiUrl, guardedFetch]);

  const [sources, setSources] = useState<Source[] | null>(null);
  const [account, setAccount] = useState<AccountWithLimits | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [chatsAvailable, setChatsAvailable] = useState(true);
  const [unreadEvents, setUnread] = useState(0);

  const refreshSources = useCallback(async () => {
    try {
      const list: Source[] = [];
      for await (const s of client.sources.list()) list.push(s);
      setSources(list);
    } catch {
      setSources((s) => s ?? []);
    }
  }, [client]);

  const refreshConversations = useCallback(async () => {
    try {
      const page = await extra.conversations.list();
      setConversations(page.data);
      setChatsAvailable(true);
    } catch (e) {
      setConversations([]);
      if (isUnavailable(e)) setChatsAvailable(false);
    }
  }, [extra]);

  const countUnread = useCallback(async () => {
    const seen = prefs.get<string | null>("eventsSeenAt", null) ?? new Date(Date.now() - 86400_000).toISOString();
    try {
      const page = await extra.eventsPage({ from: seen, limit: "100" });
      setUnread(page.data.length + (page.next_cursor ? 1 : 0));
    } catch {
      setUnread(0);
    }
  }, [extra]);

  const markEventsSeen = useCallback(() => {
    prefs.set("eventsSeenAt", new Date().toISOString());
    setUnread(0);
  }, []);

  useEffect(() => {
    let live = true;
    void refreshSources();
    void refreshConversations();
    void countUnread();
    void extra.account().then((a) => live && setAccount(a)).catch(() => undefined);
    void extra.me().then((m) => live && setMe(m)).catch(() => undefined);
    const s = setInterval(() => void refreshSources(), SOURCES_POLL_MS);
    const e = setInterval(() => void countUnread(), EVENTS_POLL_MS);
    return () => {
      live = false;
      clearInterval(s);
      clearInterval(e);
    };
  }, [extra, refreshSources, refreshConversations, countUnread]);

  const putSource = useCallback((s: Source) => setSources((all) => all ? all.map((x) => (x.id === s.id ? s : x)) : all), []);

  const value = useMemo<AppData>(() => ({
    apiUrl, apiKey, client, extra, sources, refreshSources, putSource, account,
    limits: { ...DEFAULT_LIMITS, ...(account?.limits ?? {}) },
    me, conversations, chatsAvailable, refreshConversations, unreadEvents, markEventsSeen, signOut: onSignOut,
  }), [apiUrl, apiKey, client, extra, sources, refreshSources, putSource, account, me, conversations, chatsAvailable, refreshConversations, unreadEvents, markEventsSeen, onSignOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
