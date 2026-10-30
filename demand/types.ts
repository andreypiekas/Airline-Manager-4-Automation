import type { AircraftOperationalObservation } from '../optimization/observations';
import type { FareObservation } from '../pricing/ticket-pricing';
import type { FlightTimingObservation } from '../optimization/flight-timing';
import type { CurrentRouteFieldDiagnostic } from '../optimization/current-route-diagnostics';
import type { FlightHistoryEvidence } from '../optimization/flight-history';
export const CLASSES = ['Y', 'J', 'F'] as const;
export type Cabin = typeof CLASSES[number];
export type Cabins = Record<Cabin, number>;
export type AircraftState = 'ready' | 'inflight' | 'unavailable';
export interface AircraftSnapshot {
  aircraftId: string;
  registration: string;
  routeId: string;
  routeLabel: string;
  from: string;
  to: string;
  state: AircraftState;
  capacity: Cabins | null;
  /** Observed onboard passengers, never remaining demand. */
  onboard?: Cabins | null;
  remaining: Cabins | null;
  dailyTotal: Cabins | null;
  observedAt: string;
  issue?: string;
  fares?: FareObservation;
  operational?: AircraftOperationalObservation | null;
  timing?: FlightTimingObservation | null;
  /** Rendered reset/renewal notices in the inspected demand panel, not an inferred clock. */
  demandResetHints?: string[];
  /** Redacted handler structure only; never an execution authorization. */
  departureControlShape?: string | null;
  /** Passive current-route field inventory; diagnostics only, never an economic authorization. */
  currentRouteFieldDiagnostics?: CurrentRouteFieldDiagnostic[];
  /** Visible per-aircraft flight-history window; incomplete accounting evidence only. */
  flightHistory?: FlightHistoryEvidence;
}
export interface DemandConfig {
  enabled: boolean;
  dryRun: boolean;
  failSafe: true;
  minPercentage: number;
  mode: 'aggregate' | 'per-class';
  poolScope: 'airport-pair' | 'directional';
  maxAgeSeconds: number;
}
export type Decision = 'would_depart' | 'hold_insufficient' | 'hold_unavailable' | 'not_ready';
export interface DemandDecision extends AircraftSnapshot {
  decision: Decision;
  reason: string;
  poolKey: string;
  availableBefore: Cabins | null;
  possiblePassengers: Cabins | null;
  occupancyPercentage: number | null;
  classOccupancy: Record<Cabin, number | null> | null;
  requiredPassengers: number | null;
  requiredByClass: Cabins | null;
  thresholdPercentage: number;
  thresholdSource: 'configured-floor' | 'verified-departure-history';
  // A simulation decision is never an execution authorization.
  departureAuthorized: false;
}
export interface CollectionResult {
  /** A native individual window is never a complete global Fleet inventory. */
  observationScope?: 'native-individual-first-page';
  /** The number of individually verified ready candidates on that window. */
  windowReadyCandidates?: number;
  /** Stable complete CURRENT page with zero ready cards; not a global observation. */
  windowNoReadyVerified?: boolean;
  aircraft: AircraftSnapshot[];
  complete: boolean;
  expectedRoutes: number | null;
  warnings: string[];
}
export interface DemandReport {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: true;
  config: DemandConfig;
  collectionComplete: boolean;
  warnings: string[];
  summary: {
    fleetSeen: number;
    evaluated: number;
    sufficient: number;
    insufficient: number;
    unavailable: number;
    notReady: number;
  };
  decisions: DemandDecision[];
}
