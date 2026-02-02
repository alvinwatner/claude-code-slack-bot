import dotenv from 'dotenv';

dotenv.config();

export type PermissionMode = 'plan' | 'auto' | 'ask';

// Map user-friendly mode names to SDK permission modes
// Valid SDK modes: acceptEdits, bypassPermissions, default, plan
export const permissionModeMap: Record<PermissionMode, string> = {
  plan: 'plan',
  auto: 'acceptEdits',
  ask: 'default',
};

function getDefaultPermissionMode(): PermissionMode {
  const envMode = process.env.PERMISSION_MODE?.toLowerCase();
  if (envMode === 'plan' || envMode === 'auto' || envMode === 'ask') {
    return envMode;
  }
  return 'auto'; // Default to auto-approve
}

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  defaultWorkingDirectory: process.env.DEFAULT_WORKING_DIRECTORY || '/root/projects',
  defaultPermissionMode: getDefaultPermissionMode(),
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}