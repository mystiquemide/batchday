import type { BatchSummary, CampaignView, PlanDependency, PlanTask, ReservationView } from '../shared/types';

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly debugId: string | null) {
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
  if (!res.ok) throw new ApiFailure(data.error ?? `Request failed (${res.status})`, res.status, data.debugId ?? null);
  return data as T;
}

export interface WorkspaceData {
  campaign: CampaignView;
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
  getCampaign: (id: string) => request<PublicCampaign>('GET', `/api/public/campaign/${id}`),
  reserve: (id: string) => request<{ approveUrl: string; statusPath: string }>('POST', `/api/public/campaign/${id}/reserve`),
  getReservation: (token: string) => request<PublicReservation>('GET', `/api/public/reservation/${token}`),
};

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
