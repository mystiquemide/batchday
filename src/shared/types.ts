export const RESERVATION_STATES = [
  'PENDING_APPROVAL',
  'RESERVED',
  'ABANDONED',
  'CHARGING',
  'CHARGED',
  'CHARGE_FAILED',
  'CANCELLED',
  'REVOKED',
  'AT_RISK',
  'REFUNDED',
] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** States that hold a unit of batch capacity. */
export const CAPACITY_STATES: ReservationState[] = ['RESERVED', 'CHARGING', 'CHARGED', 'CHARGE_FAILED', 'AT_RISK'];

export const WINDOW_DAYS = 20;

export interface PlanTask {
  id: number;
  name: string;
  startDate: string; // YYYY-MM-DD, UTC
  duration: number; // days, 0 for milestones
  kind: 'work' | 'ship_batch';
  batchNumber: number | null;
}

export interface PlanDependency {
  id: number;
  fromTask: number;
  toTask: number;
}

export interface BatchSummary {
  number: number;
  capacity: number;
  reserved: number;
  shipDate: string;
  windowOpenDate: string;
  daysToShip: number;
  inWindow: boolean;
}

export interface ReservationView {
  publicToken?: string;
  state: ReservationState;
  batchNumber: number | null;
  buyerEmail: string | null;
  buyerName: string | null;
  createdAt: string;
  chargedAt: string | null;
  captureId: string | null;
  message: string | null;
}

export interface CampaignView {
  workspaceId: string;
  productName: string;
  unitPrice: string;
  currency: 'USD';
  isTemplate: boolean;
}
