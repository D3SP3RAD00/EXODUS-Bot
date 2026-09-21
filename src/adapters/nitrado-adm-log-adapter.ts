import { AdminFacingError } from "../core/errors.js";
import type { AdmLogSnapshot, AdmLogSource } from "./adm-log-source.js";

export type NitradoAdmFile = { id: string; content: string; fetchedAt: string };

export interface NitradoClient {
  downloadLatestAdmLog(signal?: AbortSignal): Promise<NitradoAdmFile>;
}

export class NitradoAdmLogAdapter implements AdmLogSource {
  constructor(private readonly client: NitradoClient) {}

  async fetchLatest(signal?: AbortSignal): Promise<AdmLogSnapshot> {
    try {
      const file = await this.client.downloadLatestAdmLog(signal);
      return { sourceId: `nitrado:${file.id}`, content: file.content, observedAt: file.fetchedAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (typeof error === "object" && error !== null && "code" in error) throw error;
      throw new AdminFacingError(
        "NITRADO_ADM_FETCH_FAILED",
        "The latest ADM log could not be downloaded from Nitrado."
      );
    }
  }
}
