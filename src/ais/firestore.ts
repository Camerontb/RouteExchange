// src/ais/firestore.ts — the Firestore side of the AIS relay.
//
// The relay is the only writer of orgs/{orgId}/aisTargets and the only reader
// of orgs/{orgId}/secrets/ais. It uses the Admin SDK, which bypasses the
// security rules that keep every browser out of those two places. On Cloud Run
// the credentials come from the service account (applicationDefault); locally,
// point GOOGLE_APPLICATION_CREDENTIALS at a service-account key.

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { NormalisedTarget } from "./decode.ts";

let db: Firestore | null = null;

export function firestore(): Firestore {
  if (!db) {
    if (getApps().length === 0) {
      initializeApp({ credential: applicationDefault() });
    }
    db = getFirestore();
  }
  return db;
}

/** The subscription a single org wants: its boxes and (resolved) API key. */
export interface OrgAisConfig {
  orgId: string;
  enabled: boolean;
  boundingBoxes: number[][][]; // [[[swLat,swLon],[neLat,neLon]], ...] for aisstream
  keySet: boolean;
}

/** A stored box, as the app writes it. Firestore forbids an array directly
 *  inside an array, so the box is a map; aisstream wants the nested pair. */
interface StoredBox {
  swLat: number;
  swLon: number;
  neLat: number;
  neLon: number;
}

/** Map stored { swLat, swLon, neLat, neLon } boxes to aisstream's
 *  [[swLat, swLon], [neLat, neLon]] pairs, dropping anything malformed. */
function toAisstreamBoxes(raw: unknown): number[][][] {
  if (!Array.isArray(raw)) return [];
  const boxes: number[][][] = [];
  for (const b of raw as StoredBox[]) {
    if (!b || [b.swLat, b.swLon, b.neLat, b.neLon].some((v) => typeof v !== "number")) continue;
    boxes.push([[b.swLat, b.swLon], [b.neLat, b.neLon]]);
  }
  return boxes;
}

/**
 * Watch every org's AIS settings. config/ais docs carry kind == "ais", which
 * the collection-group query keys on so it never trips over config/tugs or
 * config/formTemplate. Fires `onChange` with the full current set on any edit.
 * Returns an unsubscribe.
 *
 * A snapshot error (a missing index being built, a transient network blip)
 * otherwise kills the listener for the life of the instance — the feeds then
 * never start until a redeploy. So an error tears the listener down and
 * re-subscribes after a short backoff instead of dying.
 */
export function watchAisConfigs(onChange: (configs: OrgAisConfig[]) => void): () => void {
  let unsub: (() => void) | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;

  const subscribe = () => {
    if (stopped) return;
    unsub = firestore()
      .collectionGroup("config")
      .where("kind", "==", "ais")
      .onSnapshot(
        (snap) => {
          const configs = snap.docs.map((d) => {
            // .../orgs/{orgId}/config/ais
            const orgId = d.ref.parent.parent?.id ?? "";
            const data = d.data();
            return {
              orgId,
              enabled: data.enabled === true,
              boundingBoxes: toAisstreamBoxes(data.boundingBoxes),
              keySet: data.keySet === true,
            } satisfies OrgAisConfig;
          });
          onChange(configs.filter((c) => c.orgId));
        },
        (err) => {
          console.error("[ais] config watch error (retrying in 10s):", err);
          unsub?.();
          unsub = null;
          if (!stopped && !retry) retry = setTimeout(() => { retry = null; subscribe(); }, 10_000);
        },
      );
  };

  subscribe();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    unsub?.();
  };
}

/** Read an org's write-only aisstream key. Returns "" if none is set. */
export async function readApiKey(orgId: string): Promise<string> {
  const snap = await firestore().doc(`orgs/${orgId}/secrets/ais`).get();
  const key = snap.exists ? (snap.data()?.apiKey as string | undefined) : undefined;
  return (key ?? "").trim();
}

/** Upsert one target. Merges so a position report never wipes static data. */
export async function writeTarget(orgId: string, t: NormalisedTarget): Promise<void> {
  const { mmsi, ...rest } = t;
  // Drop undefined so a sparse position report doesn't overwrite a known name.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) clean[k] = v;
  }
  clean.updatedAt = FieldValue.serverTimestamp();
  await firestore()
    .doc(`orgs/${orgId}/aisTargets/${mmsi}`)
    .set(clean, { merge: true });
}

/** Delete targets in an org unheard for longer than staleMs. Returns the count. */
export async function pruneStale(orgId: string, staleMs: number): Promise<number> {
  const cutoff = Date.now() - staleMs;
  const snap = await firestore()
    .collection(`orgs/${orgId}/aisTargets`)
    .where("lastSeen", "<", cutoff)
    .get();
  if (snap.empty) return 0;
  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += 450) {
    // Batches cap at 500 writes.
    const batch = firestore().batch();
    for (const doc of snap.docs.slice(i, i + 450)) batch.delete(doc.ref);
    await batch.commit();
    deleted += Math.min(450, snap.docs.length - i);
  }
  return deleted;
}

/** The feed health the Admin AIS tab reads back. */
export interface AisStatus {
  state: "connecting" | "live" | "error" | "off";
  message?: string | null;
  vesselCount?: number;
  lastMessageAt?: number | null;
  capped?: boolean;
}

/**
 * Write an org's feed status to config/aisStatus — a member-readable doc the
 * app subscribes to, separate from config/ais so a status heartbeat never
 * races the admin's own edits to the settings form. No `kind`, so the config
 * watcher ignores it.
 */
export async function writeStatus(orgId: string, status: AisStatus): Promise<void> {
  await firestore()
    .doc(`orgs/${orgId}/config/aisStatus`)
    .set({ ...status, at: FieldValue.serverTimestamp() }, { merge: true });
}

// ---------- single-writer lease ----------
// A dead-simple lease in an Admin-only doc the rules never expose to a client.
// A transaction makes acquire/renew atomic across instances.

const LOCK_DOC = "gatewayControl/aisRelayLock";

/**
 * Take the lease if it is free, expired, or already ours, and stamp a fresh
 * expiry. Returns whether we hold it after the call.
 */
export async function acquireOrRenewLease(holder: string, ttlMs: number): Promise<boolean> {
  const ref = firestore().doc(LOCK_DOC);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data()! : null;
    const free = !data || data.holder === holder || (data.expiresAt ?? 0) < now;
    if (!free) return false;
    tx.set(ref, { holder, expiresAt: now + ttlMs, renewedAt: now });
    return true;
  });
}

/** Give up the lease if we still hold it (best-effort, on shutdown). */
export async function releaseLease(holder: string): Promise<void> {
  const ref = firestore().doc(LOCK_DOC);
  await firestore()
    .runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data()?.holder === holder) {
        tx.set(ref, { holder: null, expiresAt: 0, renewedAt: Date.now() });
      }
    })
    .catch(() => {});
}
