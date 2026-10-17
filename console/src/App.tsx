// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Console entry (ADR 0046): session, routes and the app shell.
import { useCallback, useEffect, useState } from "react";
import { AddCameraPage } from "./pages/AddCamera";
import { AskPage } from "./pages/Ask";
import { CameraPage } from "./pages/Camera";
import { CamerasPage } from "./pages/Cameras";
import { ConnectPage } from "./pages/Connect";
import { LiveViewPage } from "./pages/LiveView";
import { NotFoundPage } from "./pages/NotFound";
import { InvitePage } from "./pages/Invite";
import { SignInPage } from "./pages/SignIn";
import * as Admin from "./pages/admin";
import { matchPath, navigate, useLocation } from "./router";
import {
  API_URL, AUTH_URL, endSession, forgetConnect, forgetInvite, readKey, shareSession, storeKey, takeAuthHash, takeConnectHash, takeInviteHash,
} from "./session";
import { AppDataProvider, useApp } from "./shell/AppData";
import { Shell } from "./shell/Shell";
import { ToastProvider } from "./ui";

const fromHash = takeAuthHash();
const inviteFromHash = takeInviteHash();
const connectFromHash = takeConnectHash();

const ADMIN_ROUTES = {
  "/events": Admin.EventsPage,
  "/watches": Admin.WatchesPage,
  "/search": Admin.SearchPage,
  "/agents": Admin.AgentsPage,
  "/webhooks": Admin.WebhooksPage,
  "/usage": Admin.UsagePage,
  "/settings": Admin.SettingsPage,
} as const;

/** Picks the page for a path. Exported for routing tests. */
export function resolveRoute(pathname: string): { page: string; params: Record<string, string>; bare?: boolean } {
  if (pathname === "/" || pathname === "") return { page: "ask", params: {} };
  let m = matchPath("/chats/:id", pathname);
  if (m) return { page: "ask", params: m };
  if (matchPath("/cameras/new", pathname)) return { page: "add-camera", params: {}, bare: true };
  if (matchPath("/cameras", pathname)) return { page: "cameras", params: {} };
  m = matchPath("/cameras/:id", pathname);
  if (m) return { page: "camera", params: m };
  if (matchPath("/live", pathname)) return { page: "live", params: {} };
  for (const path of Object.keys(ADMIN_ROUTES)) if (matchPath(`${path}/*`, pathname)) return { page: path, params: {} };
  return { page: "not-found", params: {} };
}

function Routes() {
  const { pathname } = useLocation();
  const app = useApp();
  const route = resolveRoute(pathname);
  useEffect(() => {
    if (route.page === "/events") app.markEventsSeen();
  }, [route.page, app.markEventsSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (route.bare) return <AddCameraPage />;
  let page: React.ReactNode;
  switch (route.page) {
    case "ask": page = <AskPage key="ask" conversationId={route.params.id} />; break;
    case "cameras": page = <CamerasPage />; break;
    case "camera": page = <CameraPage key={route.params.id} id={route.params.id!} />; break;
    case "live": page = <LiveViewPage />; break;
    case "not-found": page = <NotFoundPage />; break;
    default: {
      const Page = ADMIN_ROUTES[route.page as keyof typeof ADMIN_ROUTES];
      // The admin screens render content only; the shell gives them the page column and padding.
      page = <div className="page"><Page client={app.client} apiUrl={app.apiUrl} apiKey={app.apiKey} navigate={(p: string) => navigate(p)} /></div>;
    }
  }
  return <Shell>{page}</Shell>;
}

export function App() {
  const [apiKey, setApiKey] = useState(() => readKey(fromHash.session));
  const [notice, setNotice] = useState(fromHash.error ?? "");
  // An OAuth round trip for an invite comes back with a session (or an error): the invite is done.
  const [invite, setInvite] = useState(() => (fromHash.session || fromHash.error ? "" : inviteFromHash));
  useEffect(() => {
    if (!invite) forgetInvite();
  }, [invite]);
  // An MCP client's consent request (ADR 0048); it survives a Google/GitHub round trip in this tab.
  const [connect, setConnect] = useState(connectFromHash);
  // Lend this tab's session to a consent page opened in another tab (same origin only).
  useEffect(() => shareSession(apiKey), [apiKey]);

  const signIn = useCallback((key: string) => {
    storeKey(key);
    setNotice("");
    setApiKey(key);
  }, []);
  const signOut = useCallback(() => {
    endSession(apiKey);
    setApiKey("");
  }, [apiKey]);
  const expired = useCallback(() => {
    storeKey("");
    setNotice("Your session ended. Sign in again.");
    setApiKey("");
  }, []);

  const leaveInvite = useCallback(() => {
    setInvite("");
    navigate("/", { replace: true });
  }, []);
  const leaveConnect = useCallback(() => {
    forgetConnect();
    setConnect("");
    navigate("/", { replace: true });
  }, []);
  // Switching account on the consent page forgets the session here without ending it (it may be another tab's).
  const forget = useCallback(() => {
    storeKey("");
    setApiKey("");
  }, []);

  if (connect) {
    return (
      <ToastProvider>
        <ConnectPage request={connect} apiUrl={API_URL} authUrl={AUTH_URL} apiKey={apiKey || undefined} notice={notice} onSession={signIn} onSignOut={forget} onDone={leaveConnect} />
      </ToastProvider>
    );
  }

  if (invite) {
    return (
      <ToastProvider>
        <InvitePage token={invite} authUrl={AUTH_URL} apiKey={apiKey || undefined} onSession={signIn} onDone={leaveInvite} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      {apiKey ? (
        <AppDataProvider key={apiKey} apiUrl={API_URL} apiKey={apiKey} onUnauthorized={expired} onSignOut={signOut}>
          <Routes />
        </AppDataProvider>
      ) : (
        <SignInPage authUrl={AUTH_URL} onSession={signIn} initialError={notice} />
      )}
    </ToastProvider>
  );
}
