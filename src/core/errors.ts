export class AdminFacingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AdminFacingError";
  }
}

export function adminErrorMessage(error: unknown): string {
  if (error instanceof AdminFacingError) {
    return `Error ${error.code}: ${error.message}`;
  }
  return "Error EXODUS_INTERNAL: The bot could not complete that request. Check the structured logs.";
}
