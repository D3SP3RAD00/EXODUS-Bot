export type AdmLogSnapshot = { sourceId: string; content: string; observedAt: string };

export interface AdmLogSource {
  fetchLatest(signal?: AbortSignal): Promise<AdmLogSnapshot>;
}
