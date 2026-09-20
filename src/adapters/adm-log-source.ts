export type AdmLogSnapshot = { sourceId: string; content: string; observedAt: string };

export interface AdmLogSource {
  fetchLatest(): Promise<AdmLogSnapshot>;
}
