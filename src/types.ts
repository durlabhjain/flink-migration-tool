// ============================================================================
// Shared Type Definitions
// ============================================================================

export interface ColumnInfo {
  name: string;
  sqlServerType: string;
  isNullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isComputed?: boolean;
  computedFormula?: string;
}

export interface DatabaseConfig {
  server: string;              // IP address or hostname for I/O analysis
  serverHostname?: string;     // Hostname for Flink CDC (optional)
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
}

export interface StarRocksConfig {
  feHost: string;           // Frontend host (e.g., 'starrocks.example.com' or '${STARROCKS_FE_HOST}')
  database: string;          // Target database name (e.g., 'analytics' or '${STARROCKS_DATABASE}')
  username: string;          // StarRocks username (e.g., 'root' or '${STARROCKS_USERNAME}')
  password: string;          // StarRocks password (e.g., 'password' or '${STARROCKS_PASSWORD}')
  jdbcPort?: number;         // JDBC port (default: 9030)
  loadPort?: number;         // HTTP port for Stream Load (default: 8030)
}

export interface TypeMapping {
  sqlServer: string;
  flink: string;
  starRocks: string;
  pattern?: string;
}

export interface PatternConfig {
  include?: string[];  // Regex patterns to include
  exclude?: string[];  // Regex patterns to exclude
}

export interface GlobalConfig {
  tables?: PatternConfig;
  columns?: PatternConfig;
}

export interface TableOverride {
  table: string;
  primaryKey?: string[];
  excludeColumns?: string[];
  includeColumns?: string[];
  customMappings?: Record<string, { flink?: string; starRocks?: string }>;
}


export interface FlinkConfig {
  checkpointDir: string;  // Base checkpoint directory
  savepointDir: string;   // Base savepoint directory
}

export interface IOAnalysisConfig {
  thresholds?: {
    high?: number;
    low?: number;
  };
}


export interface SchemaConfig {
  database: DatabaseConfig;
  starRocks?: StarRocksConfig;  // Optional StarRocks connection config
  schema: string;  // Schema name for this config file
  environment?: string;  // Environment name for folder organization (dev, prod, test, etc.)
  global?: GlobalConfig;  // Global include/exclude patterns
  tableOverrides?: TableOverride[];  // Per-table overrides
  typeMappings?: TypeMapping[];
  output: {
    flinkPath: string;
    starRocksPath: string;
    checksumPath: string;
  };
  jobName?: string;  // Optional job name for multi-job organization
  flink?: FlinkConfig;  // Optional Flink checkpoint/savepoint configuration
  ioAnalysis?: IOAnalysisConfig; // Optional I/O analysis configuration
}

export interface TableSchema {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  checksum: string;
  timestamp: string;
}

export interface TableMetadata {
  schema: string;
  table: string;
}
