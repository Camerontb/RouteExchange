/**
 * S-124 (Navigational Warnings) → GeoJSON.
 *
 * S-124 payloads are GML. The job here is to turn a verified SECOM payload into a
 * GeoJSON FeatureCollection that EMPX can drop straight onto the chart.
 *
 * STUB — M0 fills this in once we see a real S-124 sample from Fintraffic's test
 * service. Kept behind a stable function signature so the server + EMPX contract
 * is settled first.
 */

export interface WarningProperties {
  id: string;
  title?: string;
  // S-124 carries a lot more (category, issuing authority, validity period, etc.);
  // add fields as the real payload is understood.
  [key: string]: unknown;
}

/** Minimal GeoJSON geometry shape (avoids an @types/geojson dependency). */
export interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

export type WarningFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: GeoJSONGeometry | null;
    properties: WarningProperties;
  }>;
};

export function s124ToGeoJSON(_secomPayload: unknown): WarningFeatureCollection {
  // TODO(M0): parse S-124 GML (decode base64 from the SECOM envelope, read the
  // GML geometry + attributes) and map each warning to a Feature.
  return { type: "FeatureCollection", features: [] };
}
