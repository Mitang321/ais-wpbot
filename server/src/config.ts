/** Environment configuration. Required vars fail fast at boot. */

export interface Config {
  port: number;
  dataDir: string;
  waToken: string;
  waPhoneNumberId: string;
  waAppSecret: string;
  waVerifyToken: string;
  dashboardPassword: string;
  sessionSecret: string;
  dashboardOrigins: string[];
  workerUrl: string | null;
  botSharedSecret: string | null;
  appBaseUrl: string;
  graphBaseUrl: string;
}

const REQUIRED = [
  'WA_TOKEN',
  'WA_PHONE_NUMBER_ID',
  'WA_APP_SECRET',
  'WA_VERIFY_TOKEN',
  'DASHBOARD_PASSWORD',
  'SESSION_SECRET',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
  const get = (k: string) => env[k]?.trim() || '';
  const port = Number(get('PORT') || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number');

  const workerUrl = get('WORKER_URL') || null;
  const botSharedSecret = get('BOT_SHARED_SECRET') || null;
  if (workerUrl && !botSharedSecret) {
    throw new Error('BOT_SHARED_SECRET is required when WORKER_URL is set');
  }

  return {
    port,
    dataDir: get('DATA_DIR') || './data',
    waToken: get('WA_TOKEN'),
    waPhoneNumberId: get('WA_PHONE_NUMBER_ID'),
    waAppSecret: get('WA_APP_SECRET'),
    waVerifyToken: get('WA_VERIFY_TOKEN'),
    dashboardPassword: get('DASHBOARD_PASSWORD'),
    sessionSecret: get('SESSION_SECRET'),
    dashboardOrigins: get('DASHBOARD_ORIGIN')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    workerUrl,
    botSharedSecret,
    appBaseUrl: (get('APP_BASE_URL') || 'https://ais.mitangs.tech').replace(/\/+$/, ''),
    graphBaseUrl: 'https://graph.facebook.com/v23.0',
  };
}
