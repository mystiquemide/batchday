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
  constraintType: ConstraintType | null;
  constraintDate: string | null; // YYYY-MM-DD
}

/** Bryntum task constraints the plan may carry. Set by Bryntum when a task is dragged or date-edited. */
export const CONSTRAINT_TYPES = [
  'startnoearlierthan',
  'startnolaterthan',
  'finishnoearlierthan',
  'finishnolaterthan',
  'muststarton',
  'mustfinishon',
] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

/** One task's schedule as sent by the console after Bryntum reschedules. */
export interface TaskScheduleInput {
  id: number;
  startDate: string;
  duration: number;
  constraintType: ConstraintType | null;
  constraintDate: string | null;
}

export type ChargeOutcome = 'PENDING' | 'COMPLETED' | 'DECLINED' | 'FAILED' | 'REVOKED' | 'UNKNOWN' | 'SKIPPED';

export interface ChargeLogRow {
  id: number;
  buyerEmail: string | null;
  batchNumber: number | null;
  attemptNo: number;
  amount: string;
  shipDate: string;
  outcome: ChargeOutcome;
  httpStatus: number | null;
  paypalDebugId: string | null;
  orderId: string | null;
  captureId: string | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Capture status PayPal later reported by a verified webhook (COMPLETED, DENIED, REVERSED...). */
  webhookStatus: string | null;
  webhookAt: string | null;
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
  /** Seller views only, for refund actions. */
  id?: string;
  publicToken?: string;
  state: ReservationState;
  batchNumber: number | null;
  buyerEmail: string | null;
  buyerName: string | null;
  createdAt: string;
  chargedAt: string | null;
  captureId: string | null;
  message: string | null;
  /** Why a reserved buyer has not been charged yet (FR-011). Null once charging is possible or over. */
  refusal: Refusal | null;
  canCancel: boolean;
  refundId: string | null;
  refundStatus: string | null;
  refundedAt: string | null;
  canRefund: boolean;
}

export interface Refusal {
  code: 'NOT_YET_ELIGIBLE';
  shipDate: string;
  windowOpenDate: string;
  daysToShip: number;
  reason: string;
}

export interface CampaignView {
  workspaceId: string;
  productName: string;
  unitPrice: string;
  currency: 'USD';
  isTemplate: boolean;
}

export type SupplierUpdateState = 'RECEIVED' | 'PROPOSED' | 'APPLIED' | 'DISCARDED' | 'REJECTED_INVALID';

export interface ProposedChange {
  taskId: number;
  taskName: string;
  changeType: 'delay_days' | 'new_start_date' | 'new_end_date' | 'completed';
  quote: string;
  summary: string;
  before: { startDate: string; duration: number };
  after: { startDate: string; duration: number };
}

export interface DroppedChange {
  taskId: number | null;
  quote: string;
  reason: string;
}

export interface SupplierUpdateView {
  id: string;
  rawText: string;
  state: SupplierUpdateState;
  proposals: ProposedChange[];
  dropped: DroppedChange[];
  noChangeReason: string | null;
  error: string | null;
  modelId: string | null;
  createdAt: string;
}

export interface BatchImpact {
  number: number;
  shipBefore: string;
  shipAfter: string;
  windowOpenAfter: string;
  inWindowBefore: boolean;
  inWindowAfter: boolean;
  reserved: number;
}

export interface NoticeDraft {
  key: string;
  batchNumber: number;
  kind: 'ship_date_changed' | 'at_risk';
  recipients: string[];
  facts: Record<string, string>;
  subject: string;
  body: string;
  source: 'ai' | 'template';
  sourceNote: string | null;
}
