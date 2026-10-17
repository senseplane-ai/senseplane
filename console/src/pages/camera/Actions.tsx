// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Header actions: Capture link (browser cameras), Pause, and a small More menu.
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { Source } from "senseplane";
import { errorText, isUnavailable } from "../../api/extra";
import { useApp } from "../../shell/AppData";
import { Button, Dialog, IconButton, useToast } from "../../ui";

export function CameraActions({ source }: { source: Source }) {
  const { client, extra, putSource } = useApp();
  const toast = useToast();
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const paused = source.status === "paused";

  useEffect(() => {
    if (!menu) return;
    const off = (e: globalThis.MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const newLink = async () => {
    setBusy(true);
    try {
      const s = await client.sources.rotateCaptureLink(source.id);
      const url = s.ingest?.capture_url;
      if (!url) throw new Error("The server returned no capture link for this camera.");
      setLink({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    try {
      const s = await extra.pauseSource(source.id, !paused);
      if (s && typeof s === "object" && "id" in s) putSource(s as Source);
      toast(paused ? "Camera resumed. It records again once it reconnects." : "Camera paused. Nothing is recorded or analysed until you resume it.");
    } catch (e) {
      toast(isUnavailable(e) ? "Pausing a camera isn't available on this server yet." : errorText(e), isUnavailable(e) ? "info" : "error");
    }
  };

  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast(done), () => toast("Couldn't copy.", "error"));
  };

  return (
    <div className="page-header-actions">
      {source.type === "browser" && <Button onClick={() => void newLink()} busy={busy}>Capture link</Button>}
      <Button onClick={() => void pause()}>{paused ? "Resume" : "Pause"}</Button>
      <div className="cam-menu-wrap" ref={menuRef}>
        <IconButton icon="more" label="More actions" variant="secondary" size={38} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
        {menu && (
          <div className="cam-menu" role="menu" aria-label="More actions">
            <button type="button" role="menuitem" onClick={() => { copy(source.id, "Camera ID copied."); setMenu(false); }}>Copy camera ID</button>
          </div>
        )}
      </div>
      <Dialog
        open={!!link} onClose={() => setLink(null)} title="Capture link"
        actions={link && <>
          <a className="btn btn-ghost btn-md" href={link.url} target="_blank" rel="noreferrer">Open on this computer</a>
          <Button variant="primary" onClick={() => copy(link.url, "Link copied.")}>Copy link</Button>
        </>}
      >
        {link && <>
          <img src={link.qr} alt={`QR code to start capturing for ${source.name}`} width={240} height={240} className="cam-qr" />
          <p>Scan with the phone you want to use as this camera, allow the camera, and keep the screen on.</p>
          <p className="field-hint">Earlier capture links for this camera stop working. Open this one within 10 minutes; the first device that opens it becomes the camera.</p>
        </>}
      </Dialog>
    </div>
  );
}
