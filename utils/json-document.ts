/** Serialize operational JSON as one parseable document with a real newline. */
export function serializeJsonDocument(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) + '\n';
}
