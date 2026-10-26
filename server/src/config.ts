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
  storeName: string;
  geminiApiKey: string | null;
  geminiModel: string;
  seedDemo: boolean;
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
    storeName: get('STORE_NAME') || 'Indian Store Marseille',
    geminiApiKey: get('GEMINI_API_KEY') || null,
    geminiModel: get('GEMINI_MODEL') || 'gemini-2.5-flash-lite',
    seedDemo: get('SEED_DEMO').toLowerCase() !== 'false',
    graphBaseUrl: 'https://graph.facebook.com/v23.0',
  };
}
