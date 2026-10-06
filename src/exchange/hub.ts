// Route-exchange hub — the interactive side of the middleware.
//
// A standalone, in-memory broker: a pilot (PPU) and a bridge (ship ECDIS) pair
// with a short-lived 6-digit code, then exchange a route offer, its delivery
// status, and chat over one WebSocket each. Nothing is persisted and Firestore is
// not involved — this is a message relay, not a database. (The AIS relay's
// Firestore use is a separate concern; see README.)
//
// Protocol (JSON over ws /ws?role=pilot|bridge&code=NNNNNN):
//   client → hub : {type:"route", ...envelope} (bridge) · {type:"status", id, state, note} (pilot) · {type:"chat", text}
//   hub → client : {type:"hello", role, code, peerConnected} · {type:"peer", connected, who}
//                  {type:"route", id, ...envelope} (to pilot) · {type:"status", id, state, note, at} (to bridge) · {type:"chat", from, text, at}

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export interface RouteEnvelope {
  id?: string;
  to?: { pairing?: string };
  from?: { shipName?: string; mmsi?: number; system?: string };
  name?: string;
  rtz?: string;
  [k: string]: unknown;
}

type Role = "pilot" | "bridge";

interface Session {
  code: string;
  pilot: WebSocket | null;
  bridge: WebSocket | null;
  expiresAt: number;
  lastOffer: RouteEnvelope | null;
}

const CODE_TTL_MS = 30 * 60 * 1000;

function send(ws: WebSocket | null, msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

let seq = 0;
const newId = (): string => `rx_${Date.now().toString(36)}${(seq++).toString(36)}`;

export class RouteHub {
  private sessions = new Map<string, Session>();
  private wss = new WebSocketServer({ noServer: true });

  /** Wire the WebSocket upgrade for /ws onto the HTTP server. */
  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== "/ws") return; // not ours — leave it for any other handler
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, url));
    });
    const t = setInterval(() => this.prune(), 60_000);
    t.unref?.();
  }

  activeSessions(): number {
    return this.sessions.size;
  }

  /** REST `POST /routes` path: hand an offer to the paired pilot. */
  submitRoute(env: RouteEnvelope): { id: string; delivered: boolean; error?: string } {
    const code = env.to?.pairing ?? "";
    const session = this.sessions.get(code);
    const id = env.id ?? newId();
    if (!session) return { id, delivered: false, error: "unknown_or_unpaired_code" };
    const offer = { ...env, id };
    session.lastOffer = offer;
    send(session.pilot, { type: "route", ...offer });
    const delivered = Boolean(session.pilot);
    if (delivered) send(session.bridge, { type: "status", id, state: "delivered", at: new Date().toISOString() });
    return { id, delivered };
  }

  private mintCode(): string {
    for (let i = 0; i < 50; i++) {
      const c = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.sessions.has(c)) return c;
    }
    throw new Error("could not mint a unique pairing code");
  }

  private createSession(preferred?: string): Session {
    const code = preferred && /^\d{6}$/.test(preferred) && !this.sessions.has(preferred) ? preferred : this.mintCode();
    const s: Session = { code, pilot: null, bridge: null, expiresAt: Date.now() + CODE_TTL_MS, lastOffer: null };
    this.sessions.set(code, s);
    return s;
  }

  private onConnection(ws: WebSocket, url: URL): void {
    const role: Role = url.searchParams.get("role") === "pilot" ? "pilot" : "bridge";
    const reqCode = url.searchParams.get("code") ?? "";

    let session: Session | undefined;
    if (role === "pilot") {
      // The pilot mints (or reclaims) the code and shows it as digits + a QR.
      session = (reqCode && this.sessions.get(reqCode)) || this.createSession(reqCode);
      session.pilot = ws;
      session.expiresAt = Date.now() + CODE_TTL_MS;
    } else {
      // The bridge joins an existing code (typed, or carried in a scanned QR URL).
      session = this.sessions.get(reqCode);
      if (!session) {
        send(ws, { type: "error", error: "unknown_code", code: reqCode });
        ws.close();
        return;
      }
      session.bridge = ws;
    }

    const code = session.code;
    const peer = role === "pilot" ? session.bridge : session.pilot;
    send(ws, { type: "hello", role, code, peerConnected: Boolean(peer) });
    send(peer, { type: "peer", connected: true, who: role });

    ws.on("message", (data: RawData) => this.onMessage(role, code, data));
    ws.on("close", () => {
      const s = this.sessions.get(code);
      if (!s) return;
      if (role === "pilot" && s.pilot === ws) s.pilot = null;
      if (role === "bridge" && s.bridge === ws) s.bridge = null;
      send(role === "pilot" ? s.bridge : s.pilot, { type: "peer", connected: false, who: role });
    });
  }

  private onMessage(role: Role, code: string, data: RawData): void {
    const s = this.sessions.get(code);
    if (!s) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const at = new Date().toISOString();
    const peer = role === "pilot" ? s.bridge : s.pilot;

    switch (msg.type) {
      case "chat":
        send(peer, { type: "chat", from: role, text: String(msg.text ?? ""), at });
        return;
      case "route": {
        if (role !== "bridge") return;
        const id = (msg.id as string) ?? newId();
        const offer = { ...msg, id, type: "route" };
        s.lastOffer = offer;
        send(s.pilot, offer);
        send(s.bridge, { type: "status", id, state: "delivered", at });
        return;
      }
      case "status":
        if (role !== "pilot") return;
        send(s.bridge, { type: "status", id: msg.id, state: msg.state, note: msg.note ?? null, at });
        return;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, s] of this.sessions) {
      if (!s.pilot && !s.bridge && now > s.expiresAt) this.sessions.delete(code);
    }
  }
}
