// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type { UsageWithLive } from "../../api/extra";
import { Link } from "../../router";
import { useApp } from "../../shell/AppData";
import { Icon, Meter } from "../../ui";

const num = (n: number) => Math.round(n).toLocaleString("en-US");
const VIEWERS_MS = 15_000;

/** Viewer-minutes and concurrent viewers against the workspace's limits (null = unlimited). */
export function Allowance() {
  const { extra, limits } = useApp();
  const [usage, setUsage] = useState<UsageWithLive | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void extra.usage().then((u) => alive && setUsage(u)).catch(() => undefined);
    load();
    const t = setInterval(load, VIEWERS_MS); // people come and go
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [extra]);
  const minutes = typeof usage?.live_view_minutes === "number" ? usage.live_view_minutes : null;
  const maxMinutes = limits.live_view_minutes;
  const viewers = typeof usage?.live_viewers_now === "number" ? usage.live_viewers_now : null;
  return (
    <div className="lv-allowance">
      <span className="lv-allowance-meters">
        {minutes != null && (
          maxMinutes != null ? (
            <>
              <span><span className="lv-num">{num(minutes)}</span> of {num(maxMinutes)} viewer-minutes this month</span>
              <Meter value={minutes} max={maxMinutes} label="Viewer-minutes used this month" />
            </>
          ) : (
            <span><span className="lv-num">{num(minutes)}</span> viewer-minutes this month</span>
          )
        )}
        {viewers != null && (limits.max_live_viewers != null
          ? <span><span className="lv-num">{num(viewers)}</span> of {num(limits.max_live_viewers)} people watching now</span>
          : <span><span className="lv-num">{num(viewers)}</span> {viewers === 1 ? "person" : "people"} watching now</span>)}
      </span>
      <span className="lv-allowance-note">A 3×3 grid uses one viewer-minute per camera. Pauses after 10 idle minutes.</span>
    </div>
  );
}

/** Shown when the workspace's limits don't include live view. */
export function Locked() {
  const { account } = useApp();
  const plan = typeof account?.plan_label === "string" && account.plan_label ? account.plan_label : null;
  return (
    <div className="lv-locked">
      <div className="lv-locked-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <span key={i} />)}
      </div>
      <div className="lv-locked-overlay">
        <div className="lv-locked-card">
          <Icon name="live" size={28} stroke={1.6} style={{ color: "var(--live)" }} />
          <h2>{plan ? `Live view isn't included in your ${plan} plan` : "Live view isn't included in this workspace"}</h2>
          <p className="muted">Watch any camera as it happens, side by side. Your cameras still record everything, and you can replay any moment from the camera page.</p>
          <div className="lv-locked-actions">
            <Link className="btn btn-primary btn-md" to="/usage">See usage</Link>
            <Link className="btn btn-ghost btn-md" to="/cameras">Replay recordings</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
