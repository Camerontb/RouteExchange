// Run: npm test  (node --test with --experimental-strip-types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMessage, validMmsi, hasPosition } from "./decode.ts";

const posEnv = (over: any = {}) => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: 503123456, ShipName: "MV TEST@@@@", ...over.meta },
  Message: {
    PositionReport: {
      Latitude: -16.92,
      Longitude: 145.78,
      Cog: 180.5,
      Sog: 12.3,
      TrueHeading: 182,
      RateOfTurn: 0,
      NavigationalStatus: 0,
      ...over.pos,
    },
  },
});

test("validMmsi accepts nine digits, rejects everything else", () => {
  assert.equal(validMmsi(503123456), "503123456");
  assert.equal(validMmsi("503123456"), "503123456");
  assert.equal(validMmsi(0), null);
  assert.equal(validMmsi(12345), null); // too short
  assert.equal(validMmsi(1234567890), null); // too long
  assert.equal(validMmsi("5031/3456"), null);
  assert.equal(validMmsi(undefined), null);
});

test("decodes a position report and trims @-padding from the name", () => {
  const t = decodeMessage(posEnv())!;
  assert.equal(t.mmsi, "503123456");
  assert.equal(t.name, "MV TEST");
  assert.equal(t.lat, -16.92);
  assert.equal(t.lng, 145.78);
  assert.equal(t.cog, 180.5);
  assert.equal(t.sog, 12.3);
  assert.equal(t.heading, 182);
  assert.ok(hasPosition(t));
});

test("drops a position report with the 91/181 'not available' sentinels", () => {
  assert.equal(decodeMessage(posEnv({ pos: { Latitude: 91, Longitude: 181 } })), null);
});

test("blanks course/heading sentinels rather than drawing them", () => {
  const t = decodeMessage(posEnv({ pos: { Cog: 360, Sog: 102.3, TrueHeading: 511 } }))!;
  assert.equal(t.cog, undefined);
  assert.equal(t.sog, undefined);
  assert.equal(t.heading, undefined);
});

test("drops a message with no / malformed MMSI", () => {
  assert.equal(decodeMessage({ MessageType: "PositionReport", MetaData: {}, Message: {} }), null);
  assert.equal(decodeMessage(null), null);
});

test("decodes static data: name, dimensions, imo sentinel blanked", () => {
  const t = decodeMessage({
    MessageType: "ShipStaticData",
    MetaData: { MMSI: 503123456 },
    Message: {
      ShipStaticData: {
        Name: "MV TEST",
        CallSign: "VJ1234",
        ImoNumber: 0, // sentinel → blanked
        Type: 70,
        MaximumStaticDraught: 7.2,
        Destination: "CAIRNS",
        Dimension: { A: 100, B: 50, C: 10, D: 12 },
      },
    },
  })!;
  assert.equal(t.imo, undefined);
  assert.equal(t.length, 150);
  assert.equal(t.beam, 22);
  assert.equal(t.callSign, "VJ1234");
  assert.equal(hasPosition(t), false);
});

test("drops an empty static report and unknown message types", () => {
  assert.equal(
    decodeMessage({ MessageType: "ShipStaticData", MetaData: { MMSI: 503123456 }, Message: { ShipStaticData: {} } }),
    null,
  );
  assert.equal(
    decodeMessage({ MessageType: "AidsToNavigationReport", MetaData: { MMSI: 503123456 }, Message: {} }),
    null,
  );
});
