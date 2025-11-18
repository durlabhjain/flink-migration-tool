// package.json dependencies needed:
// "mssql", "js-yaml", "commander", "crypto", "glob"

import * as sql from 'mssql';
import { config as MSSQLConfig } from 'mssql';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Command } from 'commander';
import { glob } from 'glob';
import { IOAnalyzer } from './io-analyzer';
import { ConfigGenerator } from './config-generator';

// ============================================================================
// Configuration Types
// ============================================================================

interface DatabaseConfig {
  server: string;              // IP address or hostname for I/O analysis
  serverHostname?: string;     // Hostname for Flink CDC (optional)
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
}

interface StarRocksConfig {
  feHost: string;           // Frontend host (e.g., 'starrocks.example.com' or '${STARROCKS_FE_HOST}')
  database: string;          // Target database name (e.g., 'analytics' or '${STARROCKS_DATABASE}')
  username: string;          // StarRocks username (e.g., 'root' or '${STARROCKS_USERNAME}')
  password: string;          // StarRocks password (e.g., 'password' or '${STARROCKS_PASSWORD}')
  jdbcPort?: number;         // JDBC port (default: 9030)
  loadPort?: number;         // HTTP port for Stream Load (default: 8030)
}

interface TypeMapping {
  sqlServer: string;
  flink: string;
  starRocks: string;
  pattern?: string;
}

interface PatternConfig {
  include?: string[];  // Regex patterns to include
  exclude?: string[];  // Regex patterns to exclude
}

interface GlobalConfig {
  tables?: PatternConfig;
  columns?: PatternConfig;
}

interface TableOverride {
  table: string;
  primaryKey?: string[];
  excludeColumns?: string[];
  includeColumns?: string[];
  customMappings?: Record<string, { flink?: string; starRocks?: string }>;
}

interface FlinkConfig {
  checkpointDir: string;  // Base checkpoint directory
  savepointDir: string;   // Base savepoint directory
}

interface SchemaConfig {
  database: DatabaseConfig;
  starRocks?: StarRocksConfig;  // Optional StarRocks connection config
  schema: string;  // Schema name for this config file
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
}

interface ColumnInfo {
  name: string;
  sqlServerType: string;
  isNullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isComputed?: boolean;
  computedFormula?: string;
}

interface TableSchema {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  checksum: string;
  timestamp: string;
}

interface TableMetadata {
  schema: string;
  table: string;
}

// ============================================================================
// Default Type Mappings
// ============================================================================

const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
  // Integer types
  { sqlServer: 'tinyint', flink: 'SMALLINT', starRocks: 'SMALLINT' },
  { sqlServer: 'smallint', flink: 'SMALLINT', starRocks: 'SMALLINT' },
  { sqlServer: 'int', flink: 'INT', starRocks: 'INT' },
  { sqlServer: 'bigint', flink: 'BIGINT', starRocks: 'BIGINT' },
  
  // Decimal types
  { sqlServer: 'decimal', flink: 'DECIMAL({precision},{scale})', starRocks: 'DECIMAL({precision},{scale})' },
  { sqlServer: 'numeric', flink: 'DECIMAL({precision},{scale})', starRocks: 'DECIMAL({precision},{scale})' },
  { sqlServer: 'money', flink: 'DECIMAL(19,4)', starRocks: 'DECIMAL(19,4)' },
  { sqlServer: 'smallmoney', flink: 'DECIMAL(10,4)', starRocks: 'DECIMAL(10,4)' },
  
  // Floating point
  { sqlServer: 'float', flink: 'DOUBLE', starRocks: 'DOUBLE' },
  { sqlServer: 'real', flink: 'FLOAT', starRocks: 'FLOAT' },
  
  // String types
  { sqlServer: 'char', flink: 'CHAR({maxLength})', starRocks: 'CHAR({maxLength})' },
  { sqlServer: 'varchar', flink: 'VARCHAR({maxLength})', starRocks: 'VARCHAR({maxLength})' },
  { sqlServer: 'nchar', flink: 'CHAR({maxLength})', starRocks: 'CHAR({maxLength})' },
  { sqlServer: 'nvarchar', flink: 'VARCHAR({maxLength})', starRocks: 'VARCHAR({maxLength})' },
  { sqlServer: 'text', flink: 'STRING', starRocks: 'STRING' },
  { sqlServer: 'ntext', flink: 'STRING', starRocks: 'STRING' },
  
  // Date/Time types
  { sqlServer: 'date', flink: 'DATE', starRocks: 'DATE' },
  { sqlServer: 'datetime', flink: 'TIMESTAMP(3)', starRocks: 'DATETIME' },
  { sqlServer: 'datetime2', flink: 'TIMESTAMP({scale})', starRocks: 'DATETIME' },
  { sqlServer: 'smalldatetime', flink: 'TIMESTAMP(0)', starRocks: 'DATETIME' },
  { sqlServer: 'time', flink: 'TIME({scale})', starRocks: 'TIME' },
  { sqlServer: 'datetimeoffset', flink: 'TIMESTAMP_LTZ({scale})', starRocks: 'DATETIME' },
  
  // Boolean
  { sqlServer: 'bit', flink: 'BOOLEAN', starRocks: 'BOOLEAN' },
  
  // Binary types
  { sqlServer: 'binary', flink: 'BINARY({maxLength})', starRocks: 'BINARY' },
  { sqlServer: 'varbinary', flink: 'VARBINARY({maxLength})', starRocks: 'VARBINARY' },
  { sqlServer: 'image', flink: 'BYTES', starRocks: 'VARBINARY' },
  
  // Other types
  { sqlServer: 'uniqueidentifier', flink: 'VARCHAR(36)', starRocks: 'VARCHAR(36)' },
  { sqlServer: 'xml', flink: 'STRING', starRocks: 'STRING' },
  { sqlServer: 'json', flink: 'STRING', starRocks: 'JSON' },
];

const VARCHAR_MAX_LENGTH = 65535;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resolves environment variable placeholders in config values
 * Supports ${VAR_NAME} syntax
 * Example: "${STARROCKS_HOST}" -> "starrocks.example.com"
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    if (envValue === undefined) {
      console.warn(`⚠️  Environment variable ${envVar} is not set, using placeholder: ${match}`);
      return match;
    }
    return envValue;
  });
}

// ============================================================================
// Pattern Matcher
// ============================================================================

class PatternMatcher {
  static matches(value: string, patterns?: string[]): boolean {
    if (!patterns || patterns.length === 0) return true;
    
    return patterns.some(pattern => {
      // Exact match - if pattern has no wildcards, require exact match
      if (!pattern.includes('*') && !pattern.includes('?')) {
        return value.toLowerCase() === pattern.toLowerCase();
      }
      
      try {
        // Convert glob pattern to regex
        const regexPattern = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
          .replace(/\*/g, '.*')  // * matches any characters
          .replace(/\?/g, '.');  // ? matches single character
        
        const regex = new RegExp(`^${regexPattern}$`, 'i');
        return regex.test(value);
      } catch (error) {
        console.warn(`Invalid regex pattern: ${pattern}`);
        return false;
      }
    });
  }

  static shouldInclude(
    value: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): boolean {
    // If exclude patterns exist and match, exclude
    if (excludePatterns && excludePatterns.length > 0) {
      if (this.matches(value, excludePatterns)) {
        return false;
      }
    }

    // If include patterns exist, must match at least one
    if (includePatterns && includePatterns.length > 0) {
      return this.matches(value, includePatterns);
    }

    // No include patterns specified, include by default (unless excluded above)
    return true;
  }
}

// ============================================================================
// Schema Extractor
// ============================================================================

class SchemaExtractor {
  private connection: sql.ConnectionPool | null = null;

  constructor(private config: DatabaseConfig) {}

  async connect(): Promise<void> {
    const sqlConfig: MSSQLConfig = {
      server: this.config.server,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      port: this.config.port || 1433,
      options: {
        encrypt: this.config.encrypt ?? true,
        trustServerCertificate: true,
      },
    };

    this.connection = new sql.ConnectionPool(sqlConfig);
    await this.connection.connect();
  }

  async disconnect(): Promise<void> {
    await this.connection?.close();
  }

  async discoverTables(schema: string, patterns?: PatternConfig): Promise<TableMetadata[]> {
    if (!this.connection) throw new Error('Not connected to database');

    const query = `
      SELECT 
        TABLE_SCHEMA as [schema],
        TABLE_NAME as tableName
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = @schema
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `;

    const result = await this.connection.request()
      .input('schema', schema)
      .query(query);

    const allTables: TableMetadata[] = result.recordset.map((row: any) => ({
      schema: row.schema,
      table: row.tableName,
    }));

    // Apply patterns
    return allTables.filter(table =>
      PatternMatcher.shouldInclude(
        table.table,
        patterns?.include,
        patterns?.exclude
      )
    );
  }

  async extractTableSchema(
    schema: string,
    table: string,
    columnPatterns?: PatternConfig
  ): Promise<TableSchema> {
    if (!this.connection) throw new Error('Not connected to database');

    const query = `
      SELECT
        c.COLUMN_NAME AS name,
        c.DATA_TYPE AS dataType,
        c.IS_NULLABLE AS isNullable,
        c.CHARACTER_MAXIMUM_LENGTH AS maxLength,
        c.NUMERIC_PRECISION AS precision,
        c.NUMERIC_SCALE AS scale,
        sc.is_computed AS isComputed,
        cc.definition AS computedFormula
      FROM INFORMATION_SCHEMA.COLUMNS c
      JOIN sys.columns sc
        ON sc.object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
        AND sc.name = c.COLUMN_NAME
      LEFT JOIN sys.computed_columns cc
        ON cc.object_id = sc.object_id
        AND cc.column_id = sc.column_id
      WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
      ORDER BY c.ORDINAL_POSITION
    `;

    const result = await this.connection.request()
      .input('schema', schema)
      .input('table', table)
      .query(query);

    let columns: ColumnInfo[] = result.recordset.map((row: any) => ({
      name: row.name,
      sqlServerType: row.dataType.toLowerCase(),
      isNullable: row.isNullable === 'YES',
      maxLength: row.maxLength == -1 ? VARCHAR_MAX_LENGTH : row.maxLength,
      precision: row.precision,
      scale: row.scale,
      isComputed: row.isComputed === true || row.isComputed === 1,
      computedFormula: row.computedFormula,
    }));

    // Apply column patterns
    columns = columns.filter(col =>
      PatternMatcher.shouldInclude(
        col.name,
        columnPatterns?.include,
        columnPatterns?.exclude
      )
    );

    // Get primary key so removed the ORDER BY c.ORDINAL_POSITION
    const pkQuery = `
      SELECT c.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE c 
        ON tc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = @schema 
        AND tc.TABLE_NAME = @table 
        AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
    `;

    const pkResult = await this.connection.request()
      .input('schema', schema)
      .input('table', table)
      .query(pkQuery);

    const primaryKey = pkResult.recordset.map((row: any) => row.COLUMN_NAME);

    // Calculate checksum
    const checksumData = JSON.stringify({ schema, table, columns, primaryKey });
    const checksum = crypto.createHash('sha256').update(checksumData).digest('hex');

    return {
      schema,
      table,
      columns,
      primaryKey,
      checksum,
      timestamp: new Date().toISOString(),
    };
  }
}

// ============================================================================
// Type Mapper
// ============================================================================

class TypeMapper {
  private mappings: TypeMapping[];

  constructor(customMappings?: TypeMapping[]) {
    this.mappings = [...DEFAULT_TYPE_MAPPINGS, ...(customMappings || [])];
  }

  mapType(
    column: ColumnInfo,
    target: 'flink' | 'starRocks',
    customMapping?: string
  ): string {
    if (customMapping) return customMapping;

    const mapping = this.mappings.find(m => m.sqlServer === column.sqlServerType);
    if (!mapping) {
      console.warn(`No mapping found for type: ${column.sqlServerType}, using STRING`);
      return 'STRING';
    }

    let targetType = target === 'flink' ? mapping.flink : mapping.starRocks;

    // Replace placeholders
    targetType = targetType
      .replace('{maxLength}', column.maxLength?.toString() || '255')
      .replace('{precision}', column.precision?.toString() || '10')
      .replace('{scale}', column.scale?.toString() || '0');

    return targetType;
  }
}

// ============================================================================
// Script Generators
// ============================================================================

class FlinkScriptGenerator {
  constructor(
    private typeMapper: TypeMapper,
    private databaseConfig: DatabaseConfig,
    private starRocksConfig?: StarRocksConfig,
    private flinkConfig?: FlinkConfig
  ) {}

  generate(tableSchema: TableSchema, override?: TableOverride): string {
    let columns = [...tableSchema.columns];

    // Exclude computed columns from Flink CDC source (CDC cannot capture computed columns)
    columns = columns.filter(col => !col.isComputed);

    // Apply column filters from override
    if (override) {
      if (override.excludeColumns && override.excludeColumns.length > 0) {
        columns = columns.filter(col => !override.excludeColumns!.includes(col.name));
      }
      if (override.includeColumns && override.includeColumns.length > 0) {
        columns = columns.filter(col => override.includeColumns!.includes(col.name));
      }
    }

    const columnDefs = columns.map(col => {
      const customMapping = override?.customMappings?.[col.name]?.flink;
      const flinkType = this.typeMapper.mapType(col, 'flink', customMapping);
      const nullable = col.isNullable ? '' : ' NOT NULL';
      return `  \`${col.name}\` ${flinkType}${nullable}`;
    });

    const primaryKey = override?.primaryKey || tableSchema.primaryKey;
    const pk = primaryKey.length > 0
      ? `,\n  PRIMARY KEY (${primaryKey.map(k => `\`${k}\``).join(', ')}) NOT ENFORCED`
      : '';

    // Resolve SQL Server connection details from config
    // Use serverHostname for Flink CDC if available, otherwise fall back to server
    const hostname = this.databaseConfig.serverHostname
      ? resolveEnvVars(this.databaseConfig.serverHostname)
      : resolveEnvVars(this.databaseConfig.server);
    const port = this.databaseConfig.port || 1433;
    const username = resolveEnvVars(this.databaseConfig.user);
    const password = resolveEnvVars(this.databaseConfig.password);
    const database = resolveEnvVars(this.databaseConfig.database);

    // Full table name: dbo.tablename_mssql
    const fullTableName = `${tableSchema.schema}.${tableSchema.table}_mssql`;

    return `-- ============================================================================
-- Flink CDC Source Table for ${tableSchema.schema}.${tableSchema.table}
-- ============================================================================
-- IMPORTANT: This script should be executed in Apache Flink SQL Client
-- DO NOT run this script in StarRocks - it uses Flink-specific types and connectors
--
-- Generated: ${tableSchema.timestamp}
-- Checksum: ${tableSchema.checksum}
-- ============================================================================

CREATE TABLE IF NOT EXISTS \`default_catalog\`.\`${database}\`.\`${fullTableName}\` (
${columnDefs.join(',\n')}${pk}
) WITH (
  'connector' = 'sqlserver-cdc',
  'hostname' = '${hostname}',
  'port' = '${port}',
  'username' = '${username}',
  'password' = '${password}',
  'database-name' = '${database}',
  'table-name' = 'dbo.${tableSchema.table}',

  -- CDC Configuration
  'scan.incremental.snapshot.enabled' = 'true',
  'scan.incremental.snapshot.chunk.size' = '8096',
  'scan.snapshot.fetch.size' = '1024',
  'connect.timeout' = '30s',
  'connect.max-retries' = '3',
  'connection.pool.size' = '20',
  'scan.startup.mode' = 'initial',

  -- Debezium Configuration for Exactly-Once Semantics
  'debezium.snapshot.mode' = 'initial',
  'debezium.snapshot.locking.mode' = 'none',
  'debezium.database.history.store.only.captured.tables.ddl' = 'true'
);
`;
  }

  generateStarRocksSink(tableSchema: TableSchema, override?: TableOverride): string {
    let columns = [...tableSchema.columns];

    // Exclude computed columns from Flink sink (to match CDC source)
    columns = columns.filter(col => !col.isComputed);

    // Apply column filters from override
    if (override) {
      if (override.excludeColumns && override.excludeColumns.length > 0) {
        columns = columns.filter(col => !override.excludeColumns!.includes(col.name));
      }
      if (override.includeColumns && override.includeColumns.length > 0) {
        columns = columns.filter(col => override.includeColumns!.includes(col.name));
      }
    }

    const columnDefs = columns.map(col => {
      const customMapping = override?.customMappings?.[col.name]?.flink;
      const flinkType = this.typeMapper.mapType(col, 'flink', customMapping);
      const nullable = col.isNullable ? '' : ' NOT NULL';
      return `  \`${col.name}\` ${flinkType}${nullable}`;
    });

    const primaryKey = override?.primaryKey || tableSchema.primaryKey;
    const pk = primaryKey.length > 0
      ? `,\n  PRIMARY KEY (${primaryKey.map(k => `\`${k}\``).join(', ')}) NOT ENFORCED`
      : '';

    // Full sink table name: dbo.tablename_sink
    const sinkTableName = `${tableSchema.schema}.${tableSchema.table}_sink`;
    // StarRocks table name without schema prefix
    const starRocksTableName = tableSchema.table;
    // Flink database name (from config)
    const flinkDbName = resolveEnvVars(this.databaseConfig.database);

    // Resolve StarRocks connection details from config or use placeholders
    let feHost: string;
    let jdbcPort: number;
    let loadPort: number;
    let database: string;
    let username: string;
    let password: string;

    if (this.starRocksConfig) {
      feHost = resolveEnvVars(this.starRocksConfig.feHost);
      jdbcPort = this.starRocksConfig.jdbcPort || 9030;
      loadPort = this.starRocksConfig.loadPort || 8030;
      database = resolveEnvVars(this.starRocksConfig.database);
      username = resolveEnvVars(this.starRocksConfig.username);
      password = resolveEnvVars(this.starRocksConfig.password);
    } else {
      feHost = '<STARROCKS_FE_HOST>';
      jdbcPort = 9030;
      loadPort = 8030;
      database = '<STARROCKS_DATABASE>';
      username = '<STARROCKS_USERNAME>';
      password = '<STARROCKS_PASSWORD>';
    }

    return `-- ============================================================================
-- Flink StarRocks Sink Table for ${tableSchema.schema}.${tableSchema.table}
-- ============================================================================
-- This is a Flink connector table that writes to StarRocks
-- ============================================================================

CREATE TABLE IF NOT EXISTS \`default_catalog\`.\`${flinkDbName}\`.\`${sinkTableName}\` (
${columnDefs.join(',\n')}${pk}
) WITH (
  'connector' = 'starrocks',
  'jdbc-url' = 'jdbc:mysql://${feHost}:${jdbcPort}',
  'load-url' = '${feHost}:${loadPort}',
  'database-name' = '${database}',
  'table-name' = '${starRocksTableName}',
  'username' = '${username}',
  'password' = '${password}',

  -- Stream Load Configuration
  'sink.buffer-flush.max-rows' = '500000',
  'sink.buffer-flush.max-bytes' = '104857600',  -- 100MB
  'sink.buffer-flush.interval-ms' = '10000',    -- 10 seconds
  'sink.max-retries' = '3',
  'sink.parallelism' = '1',

  -- Stream Load Properties
  'sink.properties.format' = 'json',
  'sink.properties.strip_outer_array' = 'true'
);
`;
  }

  generateInsertStatement(tableSchema: TableSchema, override?: TableOverride): string {
    const database = resolveEnvVars(this.databaseConfig.database);
    const sourceTableName = `default_catalog.\`${database}\`.\`${tableSchema.schema}.${tableSchema.table}_mssql\``;
    const sinkTableName = `default_catalog.\`${database}\`.\`${tableSchema.schema}.${tableSchema.table}_sink\``;

    // Apply column filters from override (same logic as in generate() and generateStarRocksSink())
    let columns = [...tableSchema.columns];

    // Exclude computed columns (to match CDC source and sink tables)
    columns = columns.filter(col => !col.isComputed);

    if (override) {
      if (override.excludeColumns && override.excludeColumns.length > 0) {
        columns = columns.filter(col => !override.excludeColumns!.includes(col.name));
      }
      if (override.includeColumns && override.includeColumns.length > 0) {
        columns = columns.filter(col => override.includeColumns!.includes(col.name));
      }
    }

    // Build explicit column list
    const columnList = columns.map(col => `\`${col.name}\``).join(', ');

    return `  -- Sync: ${tableSchema.schema}.${tableSchema.table}
  INSERT INTO ${sinkTableName} (${columnList})
  SELECT ${columnList}
  FROM ${sourceTableName};
`;
  }

  generateJobConfig(jobName: string, databaseName: string): string {
    // Resolve checkpoint and savepoint directories from config
    let checkpointDir = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints';
    let savepointDir = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints';

    if (this.flinkConfig) {
      checkpointDir = resolveEnvVars(this.flinkConfig.checkpointDir);
      savepointDir = resolveEnvVars(this.flinkConfig.savepointDir);
    }

    // Append jobName_databaseName to the directory paths
    const fullCheckpointDir = `${checkpointDir}/${jobName}`;
    const fullSavepointDir = `${savepointDir}/${jobName}`;

    return `-- =============================================================================
-- Flink Job Configuration for ${jobName}
-- =============================================================================
--
-- NOTE: Your cluster already has checkpoint configuration in flink-conf.yaml:
--   - Checkpoint Interval: 30s
--   - Mode: EXACTLY_ONCE
--   - State Backend: RocksDB
--   - Storage: ${checkpointDir}/
--
-- The settings below are OPTIONAL job-specific overrides.
-- Comment out or remove settings you want to inherit from cluster config.
--
-- =============================================================================

-- ===== Job-Specific Storage Paths =====
-- Organize checkpoints and savepoints by job name
SET 'state.checkpoints.dir' = '${fullCheckpointDir}';
SET 'state.savepoints.dir' = '${fullSavepointDir}';

-- ===== OPTIONAL: Job-Specific Checkpoint Interval =====
-- Cluster default is 30s. Uncomment to override for this job:
-- SET 'execution.checkpointing.interval' = '60s';  -- Less frequent for low-volume jobs
-- SET 'execution.checkpointing.interval' = '15s';  -- More frequent for critical jobs

-- ===== OPTIONAL: Checkpoint Timeout =====
-- Uncomment if this job needs more time to complete checkpoints:
-- SET 'execution.checkpointing.timeout' = '10min';

-- ===== OPTIONAL: Min Pause Between Checkpoints =====
-- Uncomment to prevent checkpoint storms for this job:
-- SET 'execution.checkpointing.min-pause' = '30s';

-- ===== CDC Source Configuration =====
-- These settings are recommended for all CDC jobs
SET 'table.exec.source.idle-timeout' = '30s';

-- ===== OPTIONAL: RocksDB Tuning for This Job =====
-- Cluster default: managed memory, 256MB block cache
-- Uncomment to override for jobs with different state characteristics:
-- SET 'state.backend.rocksdb.block.cache-size' = '512mb';  -- Larger cache for read-heavy jobs
-- SET 'state.backend.rocksdb.writebuffer.size' = '128mb';  -- Tune write buffer

-- =============================================================================
-- Resume from Checkpoint/Savepoint
-- =============================================================================
--
-- Your cluster automatically resumes from latest checkpoint on restart.
-- Checkpoints are stored in: ${fullCheckpointDir}
--
-- To list checkpoints for this job:
--   az storage blob list --account-name coolr0flink0starrocks --container-name flink --prefix checkpoints/${jobName}
--
-- To create a savepoint manually:
--   flink savepoint <job-id>
--   # Savepoint will be stored in: ${fullSavepointDir}
--
-- To resume from a specific savepoint:
--   flink run -s ${fullSavepointDir}/savepoint-123456 -d your-job.jar
--
-- To list savepoints:
--   az storage blob list --account-name coolr0flink0starrocks --container-name flink --prefix savepoints/${jobName}
--
-- =============================================================================

`;
  }
}

class StarRocksScriptGenerator {
  constructor(private typeMapper: TypeMapper, private databaseName: string) {}

  /**
   * Fix column name casing in formulas to match actual column names
   * StarRocks is case-sensitive, but MSSQL formulas may have inconsistent casing
   */
  private fixColumnNameCasing(formula: string, columns: ColumnInfo[]): string {
    let result = formula;

    // For each column, find references to it (with backticks) and fix the casing
    for (const col of columns) {
      // Match `columnname` in any case and replace with correct case
      const regex = new RegExp(`\`${col.name}\``, 'gi');
      result = result.replace(regex, `\`${col.name}\``);
    }

    return result;
  }

  /**
   * Convert + operators to CONCAT() for string concatenation
   * This properly handles nested expressions and avoids breaking CASE statements
   */
  private convertPlusToConcat(str: string): string {
    let result = str;
    let changed = true;
    let iterations = 0;

    while (changed && iterations < 25) {
      const before = result;

      // Match common function patterns and literals
      const funcPattern = '(?:nullif|ifnull|coalesce|trim|concat)\\s*\\([^)]+\\)';
      const casePattern = 'case\\s+when[\\s\\S]+?end';
      const literalPattern = '(?:`[^`]+`|\'[^\']+\')';

      // Build expression pattern - match functions, case, literals, or column names
      const exprPattern = `(?:${funcPattern}|${casePattern}|${literalPattern})`;

      // Pattern 1: function/case/literal + function/case/literal
      const regex1 = new RegExp(`(${exprPattern})\\s*\\+\\s*(${exprPattern})`, 'gi');
      result = result.replace(regex1, (_match, left, right) => `CONCAT(${left}, ${right})`);

      // Pattern 2: CONCAT(...) + expr (including simple column names with backticks)
      result = result.replace(
        /CONCAT\(([^)]+)\)\s*\+\s*(`[^`]+`|'[^']+'|[a-zA-Z_][a-zA-Z0-9_]*)/gi,
        (_match, args, right) => `CONCAT(${args}, ${right})`
      );

      // Pattern 3: expr + CONCAT(...)
      const regex3 = new RegExp(`(${exprPattern})\\s*\\+\\s*CONCAT\\(([^)]+)\\)`, 'gi');
      result = result.replace(regex3, (_match, left, args) => `CONCAT(${left}, ${args})`);

      // Pattern 4: Match )) + function where we're clearly inside nested parens
      // Only safe to replace if we see the pattern with extra closing parens before
      // Don't do blanket ) + replacement as it can create syntax errors

      // Pattern 5: Catch any remaining CONCAT(...) patterns followed by + column
      // This needs to extend the CONCAT, not just add a comma
      result = result.replace(
        /CONCAT\(([^)]+)\)\s*\)\s*\+\s*`([^`]+)`/g,
        (_match, args, colName) => `CONCAT(${args}, \`${colName}\`))`
      );

      changed = (before !== result);
      iterations++;
    }

    // Final cleanup: If there are still any + operators remaining, it's an error
    // Log a warning or throw
    if (result.includes('+') && !result.toLowerCase().includes('interval')) {
      // Last resort: Try to fix simple cases of CONCAT...)) + expr
      result = result.replace(
        /CONCAT\(([^)]+(?:\([^)]*\)[^)]*)*)\)\s*\)\s*\+\s*([^)]+)\)/g,
        'CONCAT($1, $2))'
      );
    }

    // Remove one layer of excessive wrapping parentheses around entire expression
    // MSSQL often adds extra wrapping: (((expr))) -> ((expr))
    // But only if the pattern looks like it's wrapping the whole thing
    result = result.replace(/^\({3,}(CONCAT\(.+\))\){3,}$/g, '(($1))');

    // Simpler fix: just reduce )))) to )))
    result = result.replace(/\){4}/g, ')))');

    return result;
  }

  /**
   * Converts MSSQL computed column formula to MySQL/StarRocks compatible syntax
   */
  private convertMSSQLFormulaToMySQL(formula: string): string {
    if (!formula) return '';

    let converted = formula;

    // STEP 1: Remove MSSQL brackets around column names: [ColumnName] -> `ColumnName`
    // Also handles schema prefixes like [dbo].[FunctionName]
    converted = converted.replace(/\[([^\]]+)\]/g, '`$1`');

    // STEP 2: Convert simple date/time functions FIRST (before complex ones)
    // Convert GETDATE() to NOW()
    converted = converted.replace(/\bgetdate\s*\(\s*\)/gi, 'NOW()');

    // Convert GETUTCDATE() to UTC_TIMESTAMP()
    converted = converted.replace(/\bgetutcdate\s*\(\s*\)/gi, 'UTC_TIMESTAMP()');

    // STEP 3 & 4: Convert DATEADD and DATEDIFF with proper parentheses matching
    // Run multiple passes to handle nested function calls
    // MSSQL: DATEADD(minute, value, date) -> MySQL: DATE_ADD(date, INTERVAL value MINUTE)
    // MSSQL: DATEDIFF(minute, start, end) -> MySQL: TIMESTAMPDIFF(MINUTE, start, end)
    let prevDateConverted = '';
    let dateIterations = 0;
    const maxDateIterations = 5;

    while (prevDateConverted !== converted && dateIterations < maxDateIterations) {
      prevDateConverted = converted;
      converted = this.replaceDateAdd(converted);
      converted = this.replaceDateDiff(converted);
      dateIterations++;
    }

    // STEP 5: Convert other NULL and string functions
    // Convert ISNULL(a, b) to IFNULL(a, b)
    converted = converted.replace(/\bisnull\s*\(/gi, 'IFNULL(');

    // Convert LEN() to CHAR_LENGTH()
    converted = converted.replace(/\blen\s*\(/gi, 'CHAR_LENGTH(');

    // Convert RTRIM() to TRIM()
    converted = converted.replace(/\brtrim\s*\(/gi, 'TRIM(');

    // Convert LTRIM() to TRIM()
    converted = converted.replace(/\bltrim\s*\(/gi, 'TRIM(');

    // ISJSON() - StarRocks doesn't have a direct equivalent that works on VARCHAR
    // JSON_VALID() only works on JSON type columns, not VARCHAR
    // As a workaround, we'll check if the string starts with '{' or '['
    // ISJSON(column) -> IF(column REGEXP '^[\\{\\[]', 1, 0)
    converted = converted.replace(/\bisjson\s*\(([^)]+)\)/gi, (_match, arg) => {
      return `IF(${arg.trim()} REGEXP '^[\\\\{\\\\[]', 1, 0)`;
    });

    // STEP 6: Convert CONVERT for type conversions (using proper matching)
    converted = this.replaceConvert(converted);

    // STEP 7: Convert CHECKSUM() - StarRocks doesn't have direct equivalent
    // Use CRC32() or MD5() as approximation
    // CHECKSUM(col1, col2, ...) -> CRC32(CONCAT(col1, col2, ...))
    converted = converted.replace(
      /\bchecksum\s*\(([^)]+)\)/gi,
      (_match, args) => {
        return `CRC32(CONCAT_WS(',', ${args}))`;
      }
    );

    // STEP 8: Convert string concatenation + to CONCAT()
    // StarRocks does NOT support + for string concatenation
    // Use a helper function to properly parse and convert
    converted = this.convertPlusToConcat(converted);

    // Handle user-defined functions (UDF) - these need to be replaced or removed
    // Common pattern: [dbo].[FunctionName](args) or dbo.FunctionName(args)
    // Add a comment indicating manual review needed
    if (converted.match(/`dbo`\.`\w+`\s*\(/i)) {
      console.warn('Warning: User-defined functions detected in computed columns. Manual review may be required.');
    }

    return converted;
  }

  /**
   * Helper function to match and extract content within balanced parentheses
   * startIdx should point to the position RIGHT AFTER the opening parenthesis
   */
  private findMatchingParen(str: string, startIdx: number): number {
    let depth = 1;  // We've already passed one opening parenthesis
    for (let i = startIdx; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Replace DATEADD with proper handling of nested parentheses
   */
  private replaceDateAdd(str: string): string {
    const regex = /\bdateadd\s*\(/gi;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(str)) !== null) {
      const startIdx = match.index + match[0].length;
      const endIdx = this.findMatchingParen(str, startIdx);

      if (endIdx !== -1) {
        const args = str.substring(startIdx, endIdx);
        const parts = this.splitByComma(args);

        if (parts.length === 3) {
          const unit = parts[0].trim().toUpperCase();
          let value = parts[1].trim();
          const date = parts[2].trim();

          // Remove outer parentheses from value if present (e.g., "(-30)" -> "-30")
          value = value.replace(/^\(([^()]+)\)$/, '$1');

          result += str.substring(lastIndex, match.index);
          result += `DATE_ADD(${date}, INTERVAL ${value} ${unit})`;
          lastIndex = endIdx + 1;
        }
      }
    }

    result += str.substring(lastIndex);
    return result;
  }

  /**
   * Replace DATEDIFF with proper handling of nested parentheses
   */
  private replaceDateDiff(str: string): string {
    const regex = /\bdatediff\s*\(/gi;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(str)) !== null) {
      const startIdx = match.index + match[0].length;
      const endIdx = this.findMatchingParen(str, startIdx);

      if (endIdx !== -1) {
        const args = str.substring(startIdx, endIdx);
        const parts = this.splitByComma(args);

        if (parts.length === 3) {
          const unit = parts[0].trim().toUpperCase();
          const start = parts[1].trim();
          const end = parts[2].trim();

          result += str.substring(lastIndex, match.index);
          result += `TIMESTAMPDIFF(${unit}, ${start}, ${end})`;
          lastIndex = endIdx + 1;
        }
      }
    }

    result += str.substring(lastIndex);
    return result;
  }

  /**
   * Replace CONVERT with proper handling of nested parentheses
   */
  private replaceConvert(str: string): string {
    const regex = /\bconvert\s*\(/gi;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(str)) !== null) {
      const startIdx = match.index + match[0].length;
      const endIdx = this.findMatchingParen(str, startIdx);

      if (endIdx !== -1) {
        const args = str.substring(startIdx, endIdx);
        const parts = this.splitByComma(args);

        if (parts.length >= 2) {
          const typeStr = parts[0].trim().replace(/`/g, '');
          const value = parts[1].trim();

          // Parse type (e.g., "varchar(10)" or "decimal(18,2)")
          const typeMatch = typeStr.match(/^(\w+)(?:\(([^)]+)\))?/);
          if (typeMatch) {
            const lowerType = typeMatch[1].toLowerCase();
            const typeParams = typeMatch[2];
            let mysqlType = lowerType;

            if (lowerType === 'varchar') {
              mysqlType = typeParams ? `CHAR(${typeParams})` : 'CHAR';
            } else if (lowerType === 'bit') {
              // MSSQL bit (0/1) -> StarRocks TINYINT
              mysqlType = 'TINYINT';
            } else if (lowerType === 'decimal' || lowerType === 'numeric') {
              mysqlType = typeParams ? `DECIMAL(${typeParams})` : 'DECIMAL';
            } else if (lowerType === 'date') {
              mysqlType = 'DATE';
            } else if (lowerType === 'datetime') {
              mysqlType = 'DATETIME';
            } else if (lowerType === 'int') {
              mysqlType = 'SIGNED';
            } else if (lowerType === 'bigint') {
              mysqlType = 'SIGNED';
            } else if (lowerType === 'varbinary') {
              mysqlType = 'BINARY';
            }

            result += str.substring(lastIndex, match.index);
            result += `CAST(${value} AS ${mysqlType})`;
            lastIndex = endIdx + 1;
          }
        }
      }
    }

    result += str.substring(lastIndex);
    return result;
  }

  /**
   * Split string by comma, but respect nested parentheses
   */
  private splitByComma(str: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '(') {
        depth++;
        current += char;
      } else if (char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }

  /**
   * Infer the StarRocks data type for a computed column based on its formula and original MSSQL type
   */
  private inferComputedColumnType(col: ColumnInfo, formula: string): string {
    // For computed columns, analyze the formula FIRST because StarRocks computes the actual type
    // and may be stricter than MSSQL about type matching
    const lowerFormula = formula.toLowerCase();

    // Check for CASE expressions - the result type is determined by the THEN/ELSE values, not the condition
    if (lowerFormula.includes('case when')) {
      // If ALL THEN/ELSE return values are literal 0 or 1, the result is TINYINT
      // This is true even if TIMESTAMPDIFF is used in the WHEN condition
      const thenMatches = formula.match(/then\s*\(?\s*([01])\s*\)?/gi);
      const elseMatches = formula.match(/else\s*\(?\s*([01])\s*\)?/gi);

      if (thenMatches && elseMatches) {
        // Both then and else return literal 0 or 1 → TINYINT
        return 'TINYINT';
      }
    }

    // Check for TIMESTAMPDIFF outside of CASE expressions - it returns BIGINT
    if (lowerFormula.includes('timestampdiff') || lowerFormula.includes('datediff')) {
      // TIMESTAMPDIFF used directly (not in CASE returning literals)
      return 'BIGINT';
    }

    // Then try to infer from the MSSQL type if available (as a fallback)
    if (col.sqlServerType) {
      const lowerType = col.sqlServerType.toLowerCase();

      // Map common MSSQL types to StarRocks types
      if (lowerType.includes('bit')) return 'BOOLEAN';
      if (lowerType.includes('tinyint')) return 'TINYINT';
      if (lowerType.includes('smallint')) return 'SMALLINT';
      if (lowerType.includes('int')) return 'INT';
      if (lowerType.includes('bigint')) return 'BIGINT';
      if (lowerType.includes('decimal') || lowerType.includes('numeric')) {
        if (col.precision && col.scale !== undefined) {
          return `DECIMAL(${col.precision},${col.scale})`;
        }
        return 'DECIMAL(18,2)';
      }
      if (lowerType.includes('float')) return 'DOUBLE';
      if (lowerType.includes('real')) return 'FLOAT';
      if (lowerType.includes('date') && !lowerType.includes('time')) return 'DATE';
      if (lowerType.includes('datetime') || lowerType.includes('datetime2')) return 'DATETIME';
      if (lowerType.includes('varchar') || lowerType.includes('nvarchar')) {
        if (col.maxLength && col.maxLength > 0 && col.maxLength < 65535) {
          return `VARCHAR(${col.maxLength})`;
        }
        return 'VARCHAR(65535)';
      }
      if (lowerType.includes('char')) return 'VARCHAR(255)';
      if (lowerType.includes('text')) return 'VARCHAR(65535)';
    }

    // If no type info, infer from the formula pattern
    // (lowerFormula already declared at the top of the function)

    // Check for date/time functions
    if (lowerFormula.includes('timestampdiff') || lowerFormula.includes('datediff')) {
      return 'BIGINT'; // TIMESTAMPDIFF returns BIGINT
    }
    if (lowerFormula.includes('date_add') || lowerFormula.includes('dateadd')) {
      return 'DATETIME';
    }
    if (lowerFormula.includes('now()') || lowerFormula.includes('utc_timestamp()')) {
      return 'DATETIME';
    }
    if (lowerFormula.includes('cast') && lowerFormula.includes('as date')) {
      return 'DATE';
    }
    if (lowerFormula.includes('cast') && lowerFormula.includes('as datetime')) {
      return 'DATETIME';
    }

    // Check for string functions
    if (lowerFormula.includes('concat') || lowerFormula.includes('trim') ||
        lowerFormula.includes('replace') || lowerFormula.includes('substring')) {
      return 'VARCHAR(65535)';
    }

    // Check for numeric operations
    if (lowerFormula.includes('cast') && lowerFormula.includes('as decimal')) {
      const match = lowerFormula.match(/decimal\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
      if (match) {
        return `DECIMAL(${match[1]},${match[2]})`;
      }
      return 'DECIMAL(18,2)';
    }
    if (lowerFormula.includes('cast') && lowerFormula.includes('as signed')) {
      return 'BIGINT';
    }
    if (lowerFormula.includes('cast') && lowerFormula.includes('as unsigned')) {
      return 'BIGINT';
    }

    // Check for CASE expressions - try to infer from common patterns
    if (lowerFormula.includes('case when')) {
      // If returns 0 or 1, it's likely a boolean/tinyint
      if (lowerFormula.match(/then\s*\(?\s*[01]\s*\)?/)) {
        return 'TINYINT';
      }
      // If returns numeric values
      if (lowerFormula.match(/then\s*\(?\s*-?\d+\s*\)?/)) {
        return 'INT';
      }
      // If returns strings
      if (lowerFormula.match(/then\s*['"`]/)) {
        return 'VARCHAR(255)';
      }
    }

    // Check for CRC32, checksum functions
    if (lowerFormula.includes('crc32')) {
      return 'BIGINT';
    }

    // Check for IF function with REGEXP (converted from ISJSON)
    // IF(column REGEXP ..., 1, 0) returns TINYINT
    if (lowerFormula.includes('if(') && lowerFormula.includes('regexp')) {
      return 'TINYINT';
    }

    // Default fallback based on common patterns
    if (lowerFormula.match(/^\s*\(?\s*\d+\s*\)?/)) {
      return 'INT'; // Starts with a number
    }

    // Default to VARCHAR for string-like expressions
    return 'VARCHAR(255)';
  }

  generate(tableSchema: TableSchema, override?: TableOverride): string {
    let columns = [...tableSchema.columns];

    // Apply column filters from override
    if (override) {
      if (override.excludeColumns && override.excludeColumns.length > 0) {
        columns = columns.filter(col => !override.excludeColumns!.includes(col.name));
      }
      if (override.includeColumns && override.includeColumns.length > 0) {
        columns = columns.filter(col => override.includeColumns!.includes(col.name));
      }
    }

    // Separate computed and regular columns
    const regularColumns = columns.filter(col => !col.isComputed);
    const computedColumns = columns.filter(col => col.isComputed);

    // Map regular columns
    const regularColumnDefs = regularColumns.map(col => {
      const customMapping = override?.customMappings?.[col.name]?.starRocks;
      const starRocksType = this.typeMapper.mapType(col, 'starRocks', customMapping);
      const nullable = col.isNullable ? 'NULL' : 'NOT NULL';
      return `  \`${col.name}\` ${starRocksType} ${nullable}`;
    });

    // Map computed columns as generated columns with their formulas
    // Convert MSSQL formula syntax to MySQL/StarRocks compatible syntax
    // StarRocks requires explicit type definitions for computed columns
    const computedColumnDefs = computedColumns.map(col => {
      const formula = col.computedFormula || '';
      let convertedFormula = this.convertMSSQLFormulaToMySQL(formula);

      // Fix column name casing - StarRocks is case-sensitive
      // Replace column references with the correct case from the actual column names
      convertedFormula = this.fixColumnNameCasing(convertedFormula, columns);

      // Remove excessive outer wrapping parentheses from MSSQL formulas
      // MSSQL often wraps formulas in ((...)), we only need one layer since we add () in template
      while (convertedFormula.startsWith('((') && convertedFormula.endsWith('))')) {
        const inner = convertedFormula.substring(1, convertedFormula.length - 1);
        // Make sure we're not removing necessary parens by checking balance
        if (inner.startsWith('(') && inner.endsWith(')')) {
          convertedFormula = inner;
        } else {
          break;
        }
      }

      // Infer the type from the computed formula or use a default type
      const inferredType = this.inferComputedColumnType(col, convertedFormula);

      // StarRocks syntax: column_name type AS (expression)
      return `  \`${col.name}\` ${inferredType} AS (${convertedFormula})`;
    });

    // Combine regular and computed columns
    const allColumnDefs = [...regularColumnDefs, ...computedColumnDefs];

    // StarRocks requires PRIMARY KEY columns to appear in the same order as in the schema
    // So we need to sort the primary key columns by their position in the columns array
    let primaryKey = override?.primaryKey || tableSchema.primaryKey;
    if (primaryKey.length > 0) {
      // Sort primary key columns by their position in the schema
      const columnOrder = new Map(columns.map((col, idx) => [col.name, idx]));
      primaryKey = [...primaryKey].sort((a, b) => {
        const posA = columnOrder.get(a) ?? 999;
        const posB = columnOrder.get(b) ?? 999;
        return posA - posB;
      });
    }

    const pk = primaryKey.length > 0
      ? primaryKey.map(k => `\`${k}\``).join(', ')
      : regularColumns[0]?.name || 'id';

    // Table name without schema prefix (dbo_)
    const tableName = tableSchema.table;

    // Database name with hyphens replaced by underscores
    const dbName = this.databaseName.replace(/-/g, '_');

    return `-- ============================================================================
-- StarRocks Target Table for ${tableSchema.schema}.${tableSchema.table}
-- ============================================================================
-- IMPORTANT: This script should be executed in StarRocks SQL Client
-- DO NOT run this script in Flink - it uses StarRocks-specific types and syntax
--
-- Generated: ${tableSchema.timestamp}
-- Checksum: ${tableSchema.checksum}
-- ============================================================================

CREATE TABLE IF NOT EXISTS \`${dbName}\`.\`${tableName}\` (
${allColumnDefs.join(',\n')}
) ENGINE=olap
PRIMARY KEY(${pk})
COMMENT ""
DISTRIBUTED BY HASH(${pk}) BUCKETS 1
PROPERTIES (
  "replication_num" = "1"
);
`;
  }
}

// ============================================================================
// Change Detector
// ============================================================================

class SchemaChangeDetector {
  detectChanges(oldSchema: TableSchema, newSchema: TableSchema): string[] {
    const changes: string[] = [];

    if (oldSchema.checksum === newSchema.checksum) {
      return ['No schema changes detected'];
    }

    const oldCols = new Map(oldSchema.columns.map(c => [c.name, c]));
    const newCols = new Map(newSchema.columns.map(c => [c.name, c]));

    for (const [name, col] of newCols) {
      if (!oldCols.has(name)) {
        changes.push(`+ Added column: ${name} (${col.sqlServerType})`);
      }
    }

    for (const [name] of oldCols) {
      if (!newCols.has(name)) {
        changes.push(`- Removed column: ${name}`);
      }
    }

    for (const [name, newCol] of newCols) {
      const oldCol = oldCols.get(name);
      if (oldCol) {
        if (oldCol.sqlServerType !== newCol.sqlServerType) {
          changes.push(`~ Modified column: ${name} (${oldCol.sqlServerType} -> ${newCol.sqlServerType})`);
        }
        if (oldCol.isNullable !== newCol.isNullable) {
          changes.push(`~ Nullability changed: ${name} (${oldCol.isNullable ? 'NULL' : 'NOT NULL'} -> ${newCol.isNullable ? 'NULL' : 'NOT NULL'})`);
        }
      }
    }

    const oldPK = oldSchema.primaryKey.join(',');
    const newPK = newSchema.primaryKey.join(',');
    if (oldPK !== newPK) {
      changes.push(`~ Primary key changed: [${oldPK}] -> [${newPK}]`);
    }

    return changes;
  }
}

// ============================================================================
// Main Generator
// ============================================================================

class MigrationScriptGenerator {
  private extractor: SchemaExtractor;
  private typeMapper: TypeMapper;
  private flinkGenerator: FlinkScriptGenerator;
  private starRocksGenerator: StarRocksScriptGenerator;
  private changeDetector: SchemaChangeDetector;

  constructor(private config: SchemaConfig) {
    this.extractor = new SchemaExtractor(config.database);
    this.typeMapper = new TypeMapper(config.typeMappings);
    this.flinkGenerator = new FlinkScriptGenerator(this.typeMapper, config.database, config.starRocks, config.flink);
    this.starRocksGenerator = new StarRocksScriptGenerator(this.typeMapper, config.database.database);
    this.changeDetector = new SchemaChangeDetector();
  }

  async generate(detectChanges: boolean = false): Promise<void> {
    await this.extractor.connect();

    const allSchemas: Record<string, TableSchema> = {};
    const databaseName = this.config.database.database;
    const baseJobName = this.config.jobName || this.config.schema;
    const jobName = `${baseJobName}_${databaseName}`;

    // Database name with hyphens replaced by underscores
    const starRocksDbName = databaseName.replace(/-/g, '_');

    let starRocksScript = `-- ============================================================================\n`;
    starRocksScript += `-- StarRocks Table Definitions for ${this.config.schema}\n`;
    if (this.config.jobName) {
      starRocksScript += `-- Job: ${this.config.jobName}\n`;
    }
    starRocksScript += `-- ============================================================================\n\n`;
    starRocksScript += `-- Create database if not exists\n`;
    starRocksScript += `CREATE DATABASE IF NOT EXISTS \`${starRocksDbName}\`;\n\n`;

    // Complete pipeline script
    let pipelineScript = this.flinkGenerator.generateJobConfig(jobName, databaseName);
    pipelineScript += `-- =============================================================================\n`;
    pipelineScript += `-- Complete Flink CDC Pipeline for ${this.config.schema}\n`;
    if (this.config.jobName) {
      pipelineScript += `-- Job: ${this.config.jobName}\n`;
    }
    pipelineScript += `--\n`;
    pipelineScript += `-- This script contains:\n`;
    pipelineScript += `--   1. MSSQL CDC source tables\n`;
    pipelineScript += `--   2. StarRocks sink tables (Flink connectors)\n`;
    pipelineScript += `--   3. INSERT statements for data synchronization\n`;
    pipelineScript += `--\n`;
    pipelineScript += `-- Prerequisites:\n`;
    pipelineScript += `--   - StarRocks tables must be created first (run {jobname}_starrocks.sql in StarRocks)\n`;
    pipelineScript += `--   - Update connection parameters (marked with <...>)\n`;
    pipelineScript += `--   - Required Flink dependencies must be in lib/ folder\n`;
    pipelineScript += `--\n`;
    pipelineScript += `-- =============================================================================\n\n`;

    console.log(`\n📋 Processing schema: ${this.config.schema}`);
    if (this.config.jobName) {
      console.log(`   Job name: ${this.config.jobName}`);
    }

    // Discover tables based on patterns
    const tables = await this.extractor.discoverTables(
      this.config.schema,
      this.config.global?.tables
    );

    console.log(`   Found ${tables.length} tables matching patterns`);

    if (tables.length === 0) {
      console.warn(`⚠️  No tables found matching the specified patterns`);
    }

    // Store table schemas and overrides for pipeline generation
    const tableSchemas: Array<{ schema: TableSchema; override?: TableOverride }> = [];

    for (const tableMetadata of tables) {
      console.log(`\n   Processing table: ${tableMetadata.table}`);

      const override = this.config.tableOverrides?.find(
        o => o.table === tableMetadata.table
      );

      const schema = await this.extractor.extractTableSchema(
        tableMetadata.schema,
        tableMetadata.table,
        this.config.global?.columns
      );

      // Apply per-table column overrides
      if (override) {
        if (override.excludeColumns || override.includeColumns) {
          console.log(`      Applying column filters`);
        }
      }

      console.log(`      Columns: ${schema.columns.length}`);
      console.log(`      Primary Key: ${schema.primaryKey.join(', ') || 'none'}`);

      allSchemas[`${schema.schema}.${schema.table}`] = schema;
      tableSchemas.push({ schema, override });

      starRocksScript += this.starRocksGenerator.generate(schema, override) + '\n';

      // Detect changes if requested
      if (detectChanges) {
        const checksumFile = path.join(
          this.config.output.checksumPath,
          `${jobName}_checksums.json`
        );

        if (fs.existsSync(checksumFile)) {
          const oldChecksums = JSON.parse(fs.readFileSync(checksumFile, 'utf-8'));
          const oldSchema = oldChecksums[`${schema.schema}.${schema.table}`];

          if (oldSchema) {
            const changes = this.changeDetector.detectChanges(oldSchema, schema);
            if (changes[0] !== 'No schema changes detected') {
              console.log(`\n      📝 Changes detected:`);
              changes.forEach(change => console.log(`         ${change}`));
            }
          } else {
            console.log(`      📝 New table (not in previous checksum)`);
          }
        }
      }
    }

    // Generate complete pipeline script
    pipelineScript += `-- =============================================================================\n`;
    pipelineScript += `-- SECTION 1: MSSQL CDC Source Tables\n`;
    pipelineScript += `-- =============================================================================\n\n`;

    for (const { schema, override } of tableSchemas) {
      pipelineScript += this.flinkGenerator.generate(schema, override) + '\n';
    }

    pipelineScript += `\n-- =============================================================================\n`;
    pipelineScript += `-- SECTION 2: StarRocks Sink Tables (Flink Connectors)\n`;
    pipelineScript += `-- =============================================================================\n\n`;

    for (const { schema, override } of tableSchemas) {
      pipelineScript += this.flinkGenerator.generateStarRocksSink(schema, override) + '\n';
    }

    pipelineScript += `\n-- =============================================================================\n`;
    pipelineScript += `-- SECTION 3: Data Synchronization (Single Job)\n`;
    pipelineScript += `-- =============================================================================\n`;
    pipelineScript += `-- All INSERT statements run as a SINGLE Flink job using STATEMENT SET.\n`;
    pipelineScript += `-- This ensures all tables are synchronized together with shared checkpointing.\n`;
    pipelineScript += `--\n`;
    pipelineScript += `-- To execute:\n`;
    pipelineScript += `--   ./bin/sql-client.sh -f ${jobName}.sql\n`;
    pipelineScript += `--\n`;
    pipelineScript += `-- Or submit via SQL Client:\n`;
    pipelineScript += `--   ./bin/sql-client.sh\n`;
    pipelineScript += `--   Flink SQL> SOURCE '${jobName}.sql';\n`;
    pipelineScript += `-- =============================================================================\n\n`;

    pipelineScript += `EXECUTE STATEMENT SET\nBEGIN\n\n`;

    for (const { schema, override } of tableSchemas) {
      pipelineScript += this.flinkGenerator.generateInsertStatement(schema, override) + '\n';
    }

    pipelineScript += `END;\n`;

    await this.extractor.disconnect();

    // Write output files
    fs.mkdirSync(this.config.output.flinkPath, { recursive: true });
    fs.mkdirSync(this.config.output.starRocksPath, { recursive: true });
    fs.mkdirSync(this.config.output.checksumPath, { recursive: true });

    const flinkFile = path.join(this.config.output.flinkPath, `${jobName}.sql`);
    const starRocksFile = path.join(this.config.output.starRocksPath, `${jobName}_starrocks.sql`);
    const checksumFile = path.join(this.config.output.checksumPath, `${jobName}_checksums.json`);

    fs.writeFileSync(flinkFile, pipelineScript);
    fs.writeFileSync(starRocksFile, starRocksScript);
    fs.writeFileSync(checksumFile, JSON.stringify(allSchemas, null, 2));

    console.log(`\n✅ Scripts generated successfully!`);
    console.log(`   Flink CDC Pipeline: ${flinkFile}`);
    console.log(`   StarRocks DDL: ${starRocksFile}`);
    console.log(`   Checksums: ${checksumFile}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name('sqlserver-to-flink')
  .description('Generate Flink CDC and StarRocks DDL from SQL Server schema')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate migration scripts from schema configuration')
  .requiredOption('-c, --config <path>', 'Path to schema configuration file (YAML or JSON)')
  .option('-d, --detect-changes', 'Detect and display schema changes', false)
  .action(async (options) => {
    try {
      const configPath = options.config;
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: SchemaConfig = configPath.endsWith('.yaml') || configPath.endsWith('.yml')
        ? yaml.load(configContent) as SchemaConfig
        : JSON.parse(configContent);

      const generator = new MigrationScriptGenerator(config);
      await generator.generate(options.detectChanges);
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('generate-all')
  .description('Generate scripts from all schema configs in a directory')
  .requiredOption('-d, --config-dir <path>', 'Directory containing schema config files')
  .option('--detect-changes', 'Detect and display schema changes', false)
  .action(async (options) => {
    try {
      const configDir = options.configDir;
      const configFiles = glob.sync(path.join(configDir, '**/*.{yaml,yml}'));

      if (configFiles.length === 0) {
        console.log(`No config files found in ${configDir}`);
        return;
      }

      console.log(`\n🚀 Found ${configFiles.length} schema configuration(s)\n`);

      for (const configFile of configFiles) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`Processing: ${path.basename(configFile)}`);
        console.log('='.repeat(80));

        const configContent = fs.readFileSync(configFile, 'utf-8');
        const config: SchemaConfig = configFile.endsWith('.json')
          ? JSON.parse(configContent)
          : yaml.load(configContent) as SchemaConfig;

        const generator = new MigrationScriptGenerator(config);
        await generator.generate(options.detectChanges);
      }

      console.log(`\n\n✅ All schemas processed successfully!`);
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('analyze-io')
  .description('Analyze table I/O patterns and auto-generate optimized config files')
  .requiredOption('-b, --base-config <path>', 'Path to base configuration file (YAML or JSON)')
  .option('-o, --output-dir <path>', 'Output directory for generated configs', './configs')
  .option('--high-threshold <number>', 'I/O operations threshold for high category', '100000')
  .option('--low-threshold <number>', 'I/O operations threshold for low category', '10000')
  .option('--max-tables-per-job <number>', 'Maximum tables per job config', '10')
  .option('--no-group-by-domain', 'Disable domain-based table grouping')
  .option('--report-only', 'Generate analysis report only (no config files)', false)
  .action(async (options) => {
    try {
      // Load base config
      const baseConfigPath = options.baseConfig;
      if (!fs.existsSync(baseConfigPath)) {
        console.error(`❌ Base config file not found: ${baseConfigPath}`);
        console.log('\n💡 Create a base config file with your database credentials:');
        console.log('   See: configs/base_config_template.yaml');
        process.exit(1);
      }

      const baseConfigContent = fs.readFileSync(baseConfigPath, 'utf-8');
      const baseConfig = baseConfigPath.endsWith('.yaml') || baseConfigPath.endsWith('.yml')
        ? yaml.load(baseConfigContent) as SchemaConfig
        : JSON.parse(baseConfigContent);

      // Parse thresholds
      const highIOThreshold = parseInt(options.highThreshold);
      const lowIOThreshold = parseInt(options.lowThreshold);
      const maxTablesPerJob = parseInt(options.maxTablesPerJob);

      if (isNaN(highIOThreshold) || isNaN(lowIOThreshold) || isNaN(maxTablesPerJob)) {
        console.error('❌ Invalid threshold or max-tables-per-job value');
        process.exit(1);
      }

      console.log(`\n🔍 I/O Analysis Configuration:`);
      console.log(`   High I/O Threshold:     >${highIOThreshold.toLocaleString()} operations`);
      console.log(`   Low I/O Threshold:      <${lowIOThreshold.toLocaleString()} operations`);
      console.log(`   Max Tables Per Job:     ${maxTablesPerJob}`);
      console.log(`   Group By Domain:        ${options.groupByDomain ? 'Yes' : 'No'}`);

      // Initialize analyzer
      const analyzer = new IOAnalyzer(baseConfig.database);
      await analyzer.connect();

      // Prepare exclude list from global config
      const excludeTables = baseConfig.global?.tables?.exclude || [];

      if (excludeTables.length > 0) {
        console.log(`   Excluding Tables:       ${excludeTables.join(', ')}`);
      }

      // Analyze I/O patterns
      const tables = await analyzer.analyzeTableIO(baseConfig.schema, {
        highIOThreshold,
        lowIOThreshold,
        excludeTables,
      });

      await analyzer.disconnect();

      // Display summary
      analyzer.displaySummary(tables, { highIOThreshold, lowIOThreshold });

      // Generate report
      const report = analyzer.generateReport(tables, baseConfig.schema, {
        highIOThreshold,
        lowIOThreshold,
      });

      if (options.reportOnly) {
        // Save report only
        const outputDir = options.outputDir;
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        const reportPath = path.join(outputDir, '_io_analysis_report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
        console.log('━'.repeat(80));
        console.log(`\n✅ Analysis report saved: ${reportPath}`);
        console.log('\n💡 To generate config files, run without --report-only flag\n');
      } else {
        // Generate config files
        const configGenerator = new ConfigGenerator(baseConfig, {
          maxTablesPerJob,
          groupByDomain: options.groupByDomain,
        });

        const generatedConfigs = await configGenerator.generateAllConfigs(tables, options.outputDir);

        // Save analysis report with config references
        configGenerator.saveAnalysisReport(report, options.outputDir);

        // Display summary
        configGenerator.displaySummary(options.outputDir);
      }
    } catch (error) {
      console.error('❌ Error:', error);
      if (error instanceof Error) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program.parse();