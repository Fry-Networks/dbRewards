export const LOG_DIVIDER = '******************';

export function logSection(...lines: string[]): void {
  console.log(LOG_DIVIDER);
  for (const line of lines) {
    console.log(line);
  }
}
