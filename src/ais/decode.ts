// src/ais/decode.ts — aisstream envelope → our target shape. Pure, no I/O, no
// deps, so it can be unit-tested on its own (decode.test.ts). The relay owns
// the socket and the writes; this owns only the "what did that message mean".

/** What we store per vessel. Undefined fields are left untouched on merge. */
export interface NormalisedTarget {
  mmsi: string;
  name?: string;
  lat?: number;
  lng?: number;
  cog?: number;
  sog?: number;
  heading?: number;
  rot?: number;
  navStatus?: number;
  shipType?: number;
  imo?: number;
  callSign?: string;
  length?: number;
  beam?: number;
  draught?: number;
  destination?: string;
  lastSeen: number; // epoch ms
}

const num = (v: unknown): number | undefined => {
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};
const str = (v: unknown): string | undefined => {
  // AIS pads text fields with '@'; strip them and surrounding space.
  const s = typeof v === "string" ? v.replace(/@+/g, " ").trim() : "";
  return s ? s : undefined;
};
// aisstream encodes "unavailable" as sentinels; keep the chart from drawing them.
const sane = (v: number | undefined, bad: number): number | undefined =>
  v === undefined || v === bad ? undefined : v;

/**
 * A well-formed MMSI: nine digits. Guards the Firestore doc id — anything else
 * (missing, 0, a string with a slash) would make a junk path or collide, so we
 * drop the message rather than write it.
 */
export function validMmsi(v: unknown): string | null {
  const n = num(v);
  if (n === undefined || !Number.isInteger(n)) return null;
  const s = String(n);
  return /^[1-9][0-9]{8}$/.test(s) ? s : null;
}

/** aisstream envelope → our target, or null if it carries nothing usable. */
export function decodeMessage(env: any): NormalisedTarget | null {
  const meta = env?.MetaData ?? {};
  const mmsi = validMmsi(meta.MMSI);
  if (!mmsi) return null;

  const t: NormalisedTarget = { mmsi, lastSeen: Date.now() };
  t.name = str(meta.ShipName);

  if (env.MessageType === "PositionReport") {
    const p = env.Message?.PositionReport ?? {};
    const lat = num(p.Latitude);
    const lng = num(p.Longitude);
    // Position sentinels: 91/181 mean "not available". Without a real fix the
    // target is useless to the chart, so drop the message.
    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return null;
    }
    t.lat = lat;
    t.lng = lng;
    t.cog = sane(num(p.Cog), 360);
    t.sog = sane(num(p.Sog), 102.3);
    t.heading = sane(num(p.TrueHeading), 511);
    t.rot = num(p.RateOfTurn);
    t.navStatus = num(p.NavigationalStatus);
  } else if (env.MessageType === "ShipStaticData") {
    const s = env.Message?.ShipStaticData ?? {};
    t.name = str(s.Name) ?? t.name;
    t.imo = sane(num(s.ImoNumber), 0);
    t.callSign = str(s.CallSign);
    t.shipType = num(s.Type);
    t.destination = str(s.Destination);
    t.draught = sane(num(s.MaximumStaticDraught), 0);
    const d = s.Dimension ?? {};
    const a = num(d.A), b = num(d.B), c = num(d.C), dd = num(d.D);
    if (a !== undefined && b !== undefined) t.length = a + b;
    if (c !== undefined && dd !== undefined) t.beam = c + dd;
    // A static report with no name and no dimensions tells the chart nothing.
    if (t.name === undefined && t.length === undefined && t.callSign === undefined) {
      return null;
    }
  } else {
    return null;
  }
  return t;
}

/** True when a decoded target carries a fix (vs. a static-only update). */
export function hasPosition(t: NormalisedTarget): boolean {
  return t.lat !== undefined && t.lng !== undefined;
}
