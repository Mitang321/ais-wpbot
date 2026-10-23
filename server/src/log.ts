/** Tiny logger. Never pass tokens/secrets here; mask phone numbers with maskPhone(). */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const line = (level: string, msg: string) => `${new Date().toISOString()} ${level} ${msg}`;

export const consoleLogger: Logger = {
  info: (m) => console.log(line('INFO', m)),
  warn: (m) => console.warn(line('WARN', m)),
  error: (m) => console.error(line('ERROR', m)),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** "919812345678" -> "91******5678" */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return '*'.repeat(phone.length);
  return phone.slice(0, 2) + '*'.repeat(phone.length - 6) + phone.slice(-4);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
