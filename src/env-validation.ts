import "dotenv/config";

interface RequiredEnvVars {
  [key: string]: {
    required: boolean;
    description: string;
    example?: string;
    validValues?: string[];
  };
}

const envConfig: RequiredEnvVars = {
  // Database
  MONGO_URI: {
    required: true,
    description: "MongoDB connection string",
    example: "mongodb+srv://user:pass@cluster.mongodb.net/main"
  },
  CREDS_MONGO_URI: {
    required: false,
    description: "Override connection string for credentials database",
    example: "mongodb+srv://user:pass@cluster.mongodb.net/creds"
  },
  CREDS_DB_NAME: {
    required: false,
    description: "Database name holding hardware credentials",
    example: "creds"
  },
  CREDS_HARDWARE_COLLECTION: {
    required: false,
    description: "Collection name for hardware credential documents",
    example: "hardware"
  },
  
  // Hardware Validation Controls
  VALIDATE_HARDWARE_AEM: {
    required: false,
    description: "Enable credential/MAC validation for AI Edge Miners (AEM)",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_HARDWARE_NODES: {
    required: false,
    description: "Enable credential/MAC validation for Decentralization Nodes (CN, SDN, RDN, SVN)",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_HARDWARE_MINERS: {
    required: false,
    description: "Enable credential/MAC validation for Hardware Miners (BM, ISM, OSM, IDM, ODM)",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_CREDENTIALS_RADIATION: {
    required: false,
    description: "Enable credential validation for Radiation Monitors (IRM) - API keys/tokens",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_CREDENTIALS_ENERGY: {
    required: false,
    description: "Enable credential validation for Energy Monitors (EM) - API keys/tokens",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_CREDENTIALS_AIR: {
    required: false,
    description: "Enable credential validation for Air Quality Monitors (IHAQM, ILAQM, OMAQM, IMAQM, OHAQM) - API keys/tokens",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_CREDENTIALS_WEATHER: {
    required: false,
    description: "Enable credential validation for Weather Monitors (HWM, LWM) - API keys/tokens",
    example: "true",
    validValues: ["true", "false"]
  },
  VALIDATE_CREDENTIALS_WATER: {
    required: false,
    description: "Enable credential validation for Water Quality Monitors (OLWQM, OHWQM) - API keys/tokens",
    example: "true",
    validValues: ["true", "false"]
  },

  // PoC Slot-Based Rewards (fail-closed, no grace period)
  POC_DB_NAME: {
    required: false,
    description: "Database name for PoC slot data",
    example: "PoC"
  },
  POC_HARDWARE_COLLECTION: {
    required: false,
    description: "Collection name for PoC hardware slot data",
    example: "hardware"
  },
  POC_REWARD_INSTALLER: {
    required: false,
    description: "Enable slot-based PoC rewards for INSTALLER devices (AEM, BM, IDM, ODM, ISM, OSM, IRM, EM, HWM, LWM, RDN, SDN, SVN, CN). 5 gates: data + online + mac_match + pol + poi. Defaults to ENABLED — set to 'false' to disable.",
    example: "true",
    validValues: ["true", "false"]
  },
  POC_REWARD_NON_INSTALLER: {
    required: false,
    description: "Enable slot-based PoC rewards for NON_INSTALLER devices (cameras, weather, air/water quality monitors). 4 gates: data + online + pol + poi. Defaults to ENABLED — set to 'false' to disable.",
    example: "true",
    validValues: ["true", "false"]
  },
  
  REWARD_REPORT_DIR: {
    required: false,
    description: "Filesystem directory for hourly reward CSV exports",
    example: "./reward-reports"
  },
  
  // Weekly Rewards System
  WEEKLY_REWARDS_ENABLED: {
    required: false,
    description: "Enable weekly epochs system (backend)",
    example: "true",
    validValues: ["true", "false"]
  },
  INLINE_WEEKLY_JOBS: {
    required: false,
    description: "Allow main runtime to schedule weekly roll-up/maturation jobs",
    example: "false",
    validValues: ["true", "false"]
  },
  
  // Accelerated Time / Clock Control
  SIMULATION_ENABLED: {
    required: false,
    description: "Enable accelerated-time mode (fast-forward clock, e.g., 7d in 7h)",
    example: "true",
    validValues: ["true", "false"]
  },
  TIME_ACCEL: {
    required: false,
    description: "Acceleration factor (e.g., 24 => 1h real ≈ 1 accelerated day)",
    example: "24"
  },
  SIM_START_AT: {
    required: false,
    description: "Optional ISO timestamp to anchor accelerated clock start",
    example: "2025-01-03T00:00:00Z"
  },
  
  NEXT_PUBLIC_WEEKLY_REWARDS_ENABLED: {
    required: false,
    description: "Enable weekly epochs in dashboard",
    example: "true", 
    validValues: ["true", "false"]
  },
  
  MATURATION_ENABLED: {
    required: false,
    description: "Enable 30-day maturation jobs (set false to freeze during accelerated runs)",
    example: "false",
    validValues: ["true", "false"]
  },
  DAILY_MATURATION_ENABLED: {
    required: false,
    description: "Override for daily pending→claimable maturation (defaults to MATURATION_ENABLED)",
    example: "false",
    validValues: ["true", "false"]
  },
  WEEKLY_MATURATION_ENABLED: {
    required: false,
    description: "Override for weekly pending→claimable maturation (defaults to MATURATION_ENABLED)",
    example: "true",
    validValues: ["true", "false"]
  },
  RUN_DAILY_MATURATION_ONCE: {
    required: false,
    description: "Run one-time daily pending→claimable maturation on startup",
    example: "true",
    validValues: ["true", "false"]
  },
  DAILY_MATURATION_ONCE_TIMEBASE: {
    required: false,
    description: "Timebase for one-time daily maturation: 'real' or 'sim' (accelerated)",
    example: "real",
    validValues: ["real", "sim"]
  },
  
  WEEKLY_CUTOFF_UTC: {
    required: false,
    description: "Cutoff date for weekly/daily hybrid display",
    example: "2025-09-12T00:00:00.000Z"
  },
  
  // Admin Security
  ADMIN_TOKEN: {
    required: false,
    description: "Secret token for admin endpoints (REQUIRED in production)",
    example: "admin_secure_token_12345"
  },
  
  ADMIN_ALLOWED_IPS: {
    required: false,
    description: "Comma-separated list of allowed IP addresses for admin access",
    example: "192.168.1.100,203.0.113.42,::1"
  },
  
  ADMIN_ENDPOINTS_ENABLED: {
    required: false,
    description: "Enable admin endpoints in production",
    example: "true",
    validValues: ["true", "false"]
  },
  
  // Environment
  NODE_ENV: {
    required: false,
    description: "Application environment",
    example: "production",
    validValues: ["development", "production", "test"]
  },
  
  TEST_MODE: {
    required: false,
    description: "Use test collections and data",
    example: "false",
    validValues: ["true", "false"]
  },
  
  // Dashboard
  DASHBOARD_PORT: {
    required: false,
    description: "Port for web dashboard",
    example: "3001"
  },
  
  // Alerting
  DISCORD_WEBHOOK_URL: {
    required: false,
    description: "Discord webhook for system alerts",
    example: "https://discord.com/api/webhooks/..."
  }
};

export function validateEnvironment(): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check required variables
  for (const [key, config] of Object.entries(envConfig)) {
    const value = process.env[key];
    
    if (config.required && !value) {
      errors.push(`Missing required environment variable: ${key} - ${config.description}`);
      continue;
    }
    
    if (value && config.validValues && !config.validValues.includes(value)) {
      errors.push(`Invalid value for ${key}: "${value}". Valid values: ${config.validValues.join(", ")}`);
    }
  }
  
  // Production-specific checks
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ADMIN_ENDPOINTS_ENABLED === 'true' && !process.env.ADMIN_TOKEN) {
      errors.push('ADMIN_TOKEN is required when admin endpoints are enabled in production');
    }
    
    if (process.env.ADMIN_ENDPOINTS_ENABLED === 'true' && !process.env.ADMIN_ALLOWED_IPS) {
      warnings.push('Consider setting ADMIN_ALLOWED_IPS for additional security in production');
    }
    
    if (!process.env.DISCORD_WEBHOOK_URL) {
      warnings.push('DISCORD_WEBHOOK_URL not set - system alerts will not be sent');
    }
  }
  
  // Weekly rewards consistency check
  if (process.env.WEEKLY_REWARDS_ENABLED === 'true' && process.env.NEXT_PUBLIC_WEEKLY_REWARDS_ENABLED !== 'true') {
    warnings.push('Backend weekly rewards enabled but frontend flag is not set');
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function printEnvironmentStatus(): void {
  const validation = validateEnvironment();
  
  console.log('\n🔧 Environment Configuration Status:');
  console.log('=====================================');
  
  if (validation.valid) {
    console.log('✅ Environment validation passed');
  } else {
    console.log('❌ Environment validation failed');
  }
  
  if (validation.errors.length > 0) {
    console.log('\n🚨 ERRORS:');
    validation.errors.forEach(error => console.log(`  - ${error}`));
  }
  
  if (validation.warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    validation.warnings.forEach(warning => console.log(`  - ${warning}`));
  }
  
  // Show current important settings
  console.log('\n📋 Current Configuration:');
  console.log(`  - Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  - Weekly Rewards: ${process.env.WEEKLY_REWARDS_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
  const matGlobal = process.env.MATURATION_ENABLED === 'false' ? 'DISABLED' : 'ENABLED';
  const matDaily = process.env.DAILY_MATURATION_ENABLED ?? '(inherit)';
  const matWeekly = process.env.WEEKLY_MATURATION_ENABLED ?? '(inherit)';
  console.log(`  - Maturation (global): ${matGlobal}`);
  console.log(`  - Maturation (daily): ${matDaily}`);
  console.log(`  - Maturation (weekly): ${matWeekly}`);
  if (process.env.RUN_DAILY_MATURATION_ONCE === 'true') {
    console.log(`  - One-time daily maturation: ENABLED (timebase: ${process.env.DAILY_MATURATION_ONCE_TIMEBASE || 'real'})`);
  }
  console.log(`  - Accelerated clock: ${process.env.SIMULATION_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
  if (process.env.SIMULATION_ENABLED === 'true') {
    console.log(`    • TIME_ACCEL: ${process.env.TIME_ACCEL || '1'}x`);
    console.log(`    • ACCEL_START_AT: ${process.env.SIM_START_AT || 'process start'}`);
  }
  console.log(`  - Admin Endpoints: ${process.env.ADMIN_ENDPOINTS_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  - IP Whitelist: ${process.env.ADMIN_ALLOWED_IPS ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`  - Dashboard Port: ${process.env.DASHBOARD_PORT || '3001'}`);
  // Use case-insensitive matching consistent with reward.ts env reads.
  const installerEnabled = process.env.POC_REWARD_INSTALLER?.toLowerCase() !== 'false';
  const nonInstallerEnabled = process.env.POC_REWARD_NON_INSTALLER?.toLowerCase() !== 'false';
  console.log('\n📡 PoC Slot-Based Rewards (fail-closed, no grace period):');
  console.log(`  - INSTALLER (5 gates: data+online+mac+pol+poi): ${installerEnabled ? 'ENABLED (default)' : 'DISABLED'}`);
  console.log(`  - NON_INSTALLER (4 gates: data+online+pol+poi): ${nonInstallerEnabled ? 'ENABLED (default)' : 'DISABLED'}`);
  
  if (!validation.valid) {
    console.log('\n💡 Fix the errors above before starting the application.');
    process.exit(1);
  }
  
  console.log(''); // Empty line for spacing
}

// Export configuration for documentation
export function getEnvConfigDocs(): RequiredEnvVars {
  return envConfig;
}
