// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Blur faces and number plates on this camera (ADR 0068), next to its privacy
// masks. Each follows the workspace setting until it is switched here.
import { useEffect, useState } from "react";
import { type Senseplane, SenseplaneError, type Source } from "senseplane";
import { Toggle } from "../../ui";

type Kind = "blur_faces" | "blur_plates";
type Blurs = { blur_faces?: boolean | null; blur_plates?: boolean | null };

export function BlurSettings({ client, source, onSaved }: { client: Senseplane; source: Source; onSaved: (s: Source) => void }) {
  const own = source as Source & Blurs;
  const [workspace, setWorkspace] = useState<Blurs>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.account.get().then((a) => setWorkspace(a as Blurs)).catch(() => setWorkspace({}));
  }, [client]);

  const set = async (kind: Kind, value: boolean | null) => {
    setBusy(true);
    setMsg("");
    try {
      onSaved(await client.sources.update(source.id, { [kind]: value }));
      setMsg("Saved. New snapshots and AI checks use it within a few seconds.");
    } catch (e) {
      setMsg(e instanceof SenseplaneError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const row = (kind: Kind, label: string, hint: string) => {
    const mine = own[kind];
    const on = mine ?? workspace[kind] ?? false;
    return (
      <>
        <Toggle label={label} hint={hint} checked={on} disabled={busy} onChange={(v) => void set(kind, v)} card={false} />
        <p className="muted cam-blur-follow">
          {mine === null || mine === undefined
            ? `Follows the workspace (${on ? "on" : "off"}).`
            : <>Set for this camera. <button type="button" className="link-btn" disabled={busy} onClick={() => void set(kind, null)}>Use the workspace setting</button></>}
        </p>
      </>
    );
  };

  return (
    <section className="cam-blur" aria-labelledby="cam-blur-h">
      <h3 id="cam-blur-h">Blurring</h3>
      <p className="muted">
        Blurs what this camera shares: snapshots, looks and answers, and every picture sent to an AI model. Recordings stay as they were
        filmed. It finds most faces and some plates, not all: it helps, but it is not a guarantee.
      </p>
      {row("blur_faces", "Blur faces", "Faces, and the heads of people whose face can't be found.")}
      {row("blur_plates", "Blur number plates", "Best effort: the plate model misses many plates outside China.")}
      {msg && <p role="status" className="muted">{msg}</p>}
    </section>
  );
}
