// src/ais/relay.ts — the upstream aisstream side of the relay.
//
// One WebSocket per org to wss://stream.aisstream.io, subscribed to that org's
// boxes with its own key. Decoded reports are folded into
// orgs/{orgId}/aisTargets through firestore.ts; feed health is published to
// orgs/{orgId}/config/aisStatus so the Admin AIS tab can show it. The key never
// leaves this process — the app reads the target docs over Firestore's own
// realtime channel, so no pilot device ever holds the aisstream credential.
//
// Only the instance holding the Firestore lease runs any feeds, so a second
// Cloud Run instance can't double the upstream connections or the writes.

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { config } from "../config.ts";
import { decodeMessage, hasPosition, type NormalisedTarget } from "./decode.ts";
import {
  watchAisConfigs,
  readApiKey,
  writeTarget,
  pruneStale,
  writeStatus,
  acquireOrRenewLease,
  releaseLease,
  type OrgAisConfig,
  type AisStatus,
} from "./firestore.ts";

// Re-export so callers that imported the type from here still compile.
export type { NormalisedTarget };

/** A stable signature of what a feed subscribes to, to detect real changes. */
function signature(apiKey: string, boxes: number[][][]): string {
  return `${apiKey}|${JSON.stringify(boxes)}`;
}

/** One org's upstream connection: reconnect backoff, throttling, health. */
class OrgFeed {
  readonly orgId: string;
  private apiKey: string;
  private boxes: number[][][];
  private ws: WebSocket | null = null;
  private closed = false;
  private fatal = false; // a bad key/subscription — stop retrying, surface it
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private lastWrite = new Map<string, number>(); // mmsi → last position write ms
  private seen = new Map<string, number>(); // mmsi → last heard ms (for count/cap)
  private state: AisStatus["state"] = "connecting";
  private message: string | null = null;
  private lastMessageAt: number | null = null;
  private capped = false;

  constructor(orgId: string, apiKey: string, boxes: number[][][]) {
    this.orgId = orgId;
    this.apiKey = apiKey;
    this.boxes = boxes;
  }

  get sig(): string {
    return signature(this.apiKey, this.boxes);
  }

  start(): void {
    this.closed = false;
    this.setState("connecting");
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.fatal) return;
    const ws = new WebSocket(config.ais.streamUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 1000;
      ws.send(
        JSON.stringify({
          APIKey: this.apiKey,
          BoundingBoxes: this.boxes,
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }),
      );
      console.log(`[ais] ${this.orgId} connected, ${this.boxes.length} box(es)`);
    });

    ws.on("message", (raw) => {
      let env: any;
      try {
        env = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // aisstream reports a bad key/subscription as { error } then closes.
      // Retrying with the same bad key just hammers it, so stop and surface it.
      if (env?.error) {
        this.fail(String(env.error));
        return;
      }
      if (this.state !== "live") this.setState("live");
      this.lastMessageAt = Date.now();
      const target = decodeMessage(env);
      if (target) this.persist(target);
    });

    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (err) => {
      console.error(`[ais] ${this.orgId} socket error: ${err.message}`);
      ws.close();
    });
  }

  private persist(t: NormalisedTarget): void {
    const now = Date.now();
    const known = this.seen.has(t.mmsi);

    // Vessel cap: once an org is tracking the ceiling, a *new* vessel is
    // dropped (known ones keep updating) so a far-too-wide box can't run up an
    // unbounded bill. Flagged on the status doc.
    if (!known && this.liveCount(now) >= config.ais.maxVesselsPerOrg) {
      if (!this.capped) {
        this.capped = true;
        console.warn(`[ais] ${this.orgId} hit vessel cap (${config.ais.maxVesselsPerOrg}) — box likely too wide`);
      }
      return;
    }
    this.seen.set(t.mmsi, now);

    // Throttle position-only updates; always let static data (a name) through.
    if (hasPosition(t)) {
      const last = this.lastWrite.get(t.mmsi) ?? 0;
      if (now - last < config.ais.positionThrottleMs) return;
      this.lastWrite.set(t.mmsi, now);
    }
    writeTarget(this.orgId, t).catch((err) =>
      console.error(`[ais] ${this.orgId} write ${t.mmsi} failed: ${err.message}`),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.fatal) return;
    this.ws = null;
    this.setState("connecting");
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  private fail(message: string): void {
    this.fatal = true;
    this.message = message;
    this.setState("error");
    console.error(`[ais] ${this.orgId} fatal: ${message} — not retrying until settings change`);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }

  private setState(state: AisStatus["state"]): void {
    this.state = state;
    if (state !== "error") this.message = null;
    // Push the change straight away; the periodic flush covers counts/liveness.
    writeStatus(this.orgId, this.snapshot()).catch(() => {});
  }

  /** Vessels heard within the stale window — the number worth showing. */
  liveCount(now = Date.now()): number {
    let n = 0;
    for (const at of this.seen.values()) if (now - at < config.ais.staleMs) n++;
    return n;
  }

  /** Drop long-unheard vessels from the in-memory maps so they don't leak. */
  compact(now = Date.now()): void {
    for (const [mmsi, at] of this.seen) if (now - at >= config.ais.staleMs) this.seen.delete(mmsi);
    for (const [mmsi, at] of this.lastWrite) if (now - at >= config.ais.staleMs) this.lastWrite.delete(mmsi);
    if (this.capped && this.liveCount(now) < config.ais.maxVesselsPerOrg) this.capped = false;
  }

  snapshot(): AisStatus {
    return {
      state: this.state,
      message: this.message,
      vesselCount: this.liveCount(),
      lastMessageAt: this.lastMessageAt,
      capped: this.capped,
    };
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }
}

/** Owns every feed, reconciling them against config — but only while leader. */
export class AisRelay {
  private readonly instanceId = randomUUID();
  private feeds = new Map<string, OrgFeed>();
  private configs: OrgAisConfig[] = []; // last seen, to reconcile on becoming leader

  private leaseTimer: NodeJS.Timeout | null = null;
  private leader = false;

  private unwatch: (() => void) | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  start(): void {
    console.log(`[ais] relay starting (instance ${this.instanceId})`);
    this.leaseLoop();
  }

  /** Try to hold the lease; activate on gaining it, stand down on losing it. */
  private async leaseLoop(): Promise<void> {
    if (this.stopped) return;
    let held = false;
    try {
      held = await acquireOrRenewLease(this.instanceId, config.ais.leaseTtlMs);
    } catch (err) {
      console.error("[ais] lease error:", err instanceof Error ? err.message : err);
    }
    if (held && !this.leader) this.becomeLeader();
    else if (!held && this.leader) this.standDown();
    this.leaseTimer = setTimeout(() => this.leaseLoop(), config.ais.leaseRenewMs);
  }

  private becomeLeader(): void {
    this.leader = true;
    console.log(`[ais] ${this.instanceId} is leader — starting feeds`);
    this.unwatch = watchAisConfigs((configs) => {
      this.configs = configs;
      if (this.leader) this.reconcile(configs).catch((e) => console.error("[ais] reconcile failed:", e));
    });
    this.pruneTimer = setInterval(() => this.prune(), config.ais.pruneIntervalMs);
    this.statusTimer = setInterval(() => this.flushStatus(), config.ais.statusIntervalMs);
  }

  private standDown(): void {
    this.leader = false;
    console.warn(`[ais] ${this.instanceId} lost lease — stopping feeds`);
    this.unwatch?.();
    this.unwatch = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.pruneTimer = this.statusTimer = null;
    for (const feed of this.feeds.values()) feed.stop();
    this.feeds.clear();
  }

  /** Bring running feeds in line with what the orgs now want. */
  private async reconcile(configs: OrgAisConfig[]): Promise<void> {
    const wanted = new Set<string>();

    for (const c of configs) {
      if (!c.enabled || !c.keySet || c.boundingBoxes.length === 0) continue;
      let apiKey = "";
      try {
        apiKey = await readApiKey(c.orgId);
      } catch (err) {
        console.error(`[ais] ${c.orgId} key read failed:`, err instanceof Error ? err.message : err);
        continue;
      }
      if (!apiKey) {
        console.warn(`[ais] ${c.orgId} enabled but no key readable — skipping`);
        await writeStatus(c.orgId, { state: "error", message: "No API key found." }).catch(() => {});
        continue;
      }
      wanted.add(c.orgId);
      const sig = signature(apiKey, c.boundingBoxes);
      const existing = this.feeds.get(c.orgId);
      if (existing && existing.sig === sig) continue; // unchanged — leave it running
      existing?.stop();
      const feed = new OrgFeed(c.orgId, apiKey, c.boundingBoxes);
      this.feeds.set(c.orgId, feed);
      feed.start();
    }

    // Close feeds for orgs that turned AIS off or vanished from the set.
    for (const [orgId, feed] of this.feeds) {
      if (!wanted.has(orgId)) {
        feed.stop();
        this.feeds.delete(orgId);
        await writeStatus(orgId, { state: "off", vesselCount: 0 }).catch(() => {});
        console.log(`[ais] ${orgId} stopped`);
      }
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [orgId, feed] of this.feeds) {
      feed.compact(now);
      pruneStale(orgId, config.ais.staleMs)
        .then((n) => n && console.log(`[ais] ${orgId} pruned ${n} stale`))
        .catch((err) => console.error(`[ais] ${orgId} prune failed: ${err.message}`));
    }
  }

  private flushStatus(): void {
    for (const [orgId, feed] of this.feeds) {
      writeStatus(orgId, feed.snapshot()).catch(() => {});
    }
  }

  /** Orgs currently connected — surfaced on /healthz. */
  activeOrgs(): string[] {
    return [...this.feeds.keys()];
  }

  isLeader(): boolean {
    return this.leader;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.standDown();
    await releaseLease(this.instanceId);
  }
}
