import type { ReservationState } from '../shared/types';

const LABELS: Record<ReservationState, string> = {
  PENDING_APPROVAL: 'Awaiting PayPal approval',
  RESERVED: 'Reserved',
  ABANDONED: 'Not completed',
  CHARGING: 'Charging',
  CHARGED: 'Charged',
  CHARGE_FAILED: 'Charge failed',
  CANCELLED: 'Cancelled',
  REVOKED: 'Revoked at PayPal',
  AT_RISK: 'At risk',
  REFUNDED: 'Refunded',
};

export function StateBadge({ state }: { state: ReservationState }) {
  return <span className={`badge s-${state.toLowerCase()}`}>{LABELS[state]}</span>;
}
