import type { NoticeDraft, BatchImpact, SupplierUpdateView, BatchSummary, CampaignView, ChargeLogRow, PlanDependency, PlanTask, ReservationView, TaskScheduleInput } from '../shared/types';

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly debugId: string | null, readonly problems: string[] = []) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFailure(data.error ?? `Request failed (${res.status})`, res.status, data.debugId ?? null, data.problems ?? []);
  return data as T;
}

export interface EngineSummary {
  charged: number;
  failed: number;
  revoked: number;
  unknown: number;
  skipped: number;
  outsideWindow: number;
  atRisk: number;
  recovered: number;
}

export type UpdateWithImpact = SupplierUpdateView & { impact?: BatchImpact[] | null };

export interface WorkspaceData {
  campaign: CampaignView;
  updates: UpdateWithImpact[];
  planVersion: number;
  charges: ChargeLogRow[];
  engine?: EngineSummary;
  plan: { tasks: PlanTask[]; dependencies: PlanDependency[] };
  batches: BatchSummary[];
  reservations: ReservationView[];
  windowDays: number;
}

export interface PublicCampaign {
  campaign: CampaignView;
  nextBatch: BatchSummary | null;
  soldOut: boolean;
  windowDays: number;
}

export interface PublicReservation {
  campaign: CampaignView;
  reservation: ReservationView;
  batch: BatchSummary | null;
  windowDays: number;
}

export const api = {
  getWorkspace: () => request<WorkspaceData>('GET', '/api/workspace'),
  startWorkspace: () => request<{ workspaceId: string }>('POST', '/api/workspace'),
  savePlan: (planVersion: number, tasks: TaskScheduleInput[]) => request<WorkspaceData>('PUT', '/api/workspace/plan', { planVersion, tasks }),
  submitUpdate: (text: string) => request<{ update: UpdateWithImpact }>('POST', '/api/workspace/updates', { text }),
  applyUpdate: (id: string) => request<{ update: SupplierUpdateView }>('POST', `/api/workspace/updates/${id}/apply`, {}),
  discardUpdate: (id: string) => request<{ update: SupplierUpdateView }>('POST', `/api/workspace/updates/${id}/discard`, {}),
  refund: (reservationId: string) => request<WorkspaceData>('POST', `/api/workspace/reservations/${reservationId}/refund`, {}),
  draftNotices: () => request<{ drafts: NoticeDraft[] }>('POST', '/api/workspace/notices/draft', {}),
  markNotified: (batchNumber: number) => request<{ updated: number }>('POST', '/api/workspace/notices/mark-notified', { batchNumber }),
  getCampaign: (id: string) => request<PublicCampaign>('GET', `/api/public/campaign/${id}`),
  reserve: (id: string) => request<{ approveUrl: string; statusPath: string }>('POST', `/api/public/campaign/${id}/reserve`),
  getReservation: (token: string) => request<PublicReservation>('GET', `/api/public/reservation/${token}`),
  cancel: (token: string) => request<PublicReservation>('POST', `/api/public/reservation/${token}/cancel`),
};

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
