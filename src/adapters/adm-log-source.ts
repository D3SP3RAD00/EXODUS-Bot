export type AdmDiscoveryCounts = {
  discovered: number;
  evaluated: number;
  valid: number;
  rejected: number;
};

export type AdmLogSnapshot = {
  sourceId: string;
  content: string;
  observedAt: string;
  discovery?: AdmDiscoveryCounts;
};

export interface AdmLogSource {
  fetchLatest(signal?: AbortSignal): Promise<AdmLogSnapshot>;
}
