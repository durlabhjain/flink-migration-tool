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
import { resolveEnvVars } from './helper';
import { PatternMatcher } from './pattern-matcher';
import {
  ColumnInfo,
  DatabaseConfig,
  StarRocksConfig,
  TypeMapping,
  PatternConfig,
  TableOverride,
  FlinkConfig,
  SchemaConfig,
  TableSchema,
  TableMetadata,
} from './types';
import * as SqlConverter from './sql-formula-converter';

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

CREATE DATABASE IF NOT EXISTS \`default_catalog\`.\`${database}\`;

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
  'scan.incremental.snapshot.enabled' = 'false',
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
    const sourceTableName = `\`default_catalog\`.\`${database}\`.\`${tableSchema.schema}.${tableSchema.table}_mssql\``;
    const sinkTableName = `\`default_catalog\`.\`${database}\`.\`${tableSchema.schema}.${tableSchema.table}_sink\``;

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
SET 'state.checkpointing.dir' = '${fullCheckpointDir}';
SET 'state.savepoints.dir' = '${fullSavepointDir}';
SET 'pipeline.name' = '${jobName}';

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
   * Extract computed column information for ALTER statement generation
   */
  extractComputedColumns(tableSchema: TableSchema, override?: TableOverride): Array<{
    schema: string;
    table: string;
    column: ColumnInfo;
    convertedFormula: string;
    inferredType: string;
  }> {
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

    const computedColumns = columns.filter(col => col.isComputed);
    const result: Array<{
      schema: string;
      table: string;
      column: ColumnInfo;
      convertedFormula: string;
      inferredType: string;
    }> = [];

    for (const col of computedColumns) {
      const formula = col.computedFormula || '';
      let convertedFormula = SqlConverter.convertMSSQLFormulaToMySQL(formula);
      convertedFormula = SqlConverter.fixColumnNameCasing(convertedFormula, columns);

      // Remove excessive outer wrapping parentheses
      while (convertedFormula.startsWith('((') && convertedFormula.endsWith('))')) {
        const inner = convertedFormula.substring(1, convertedFormula.length - 1);
        if (inner.startsWith('(') && inner.endsWith(')')) {
          convertedFormula = inner;
        } else {
          break;
        }
      }

      const inferredType = SqlConverter.inferComputedColumnType(col, convertedFormula);

      result.push({
        schema: tableSchema.schema,
        table: tableSchema.table,
        column: col,
        convertedFormula,
        inferredType,
      });
    }

    return result;
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
      let convertedFormula = SqlConverter.convertMSSQLFormulaToMySQL(formula);

      // Fix column name casing - StarRocks is case-sensitive
      // Replace column references with the correct case from the actual column names
      convertedFormula = SqlConverter.fixColumnNameCasing(convertedFormula, columns);

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
      const inferredType = SqlConverter.inferComputedColumnType(col, convertedFormula);

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

  // Static property to collect all computed columns across all generators
  private static globalComputedColumns: Array<{
    schema: string;
    table: string;
    column: ColumnInfo;
    convertedFormula: string;
    inferredType: string;
    jobName: string;
  }> = [];

  constructor(private config: SchemaConfig) {
    this.extractor = new SchemaExtractor(config.database);
    this.typeMapper = new TypeMapper(config.typeMappings);
    this.flinkGenerator = new FlinkScriptGenerator(this.typeMapper, config.database, config.starRocks, config.flink);
    this.starRocksGenerator = new StarRocksScriptGenerator(this.typeMapper, config.database.database);
    this.changeDetector = new SchemaChangeDetector();
  }

  /**
   * Reset the global computed columns collection
   */
  static resetGlobalComputedColumns(): void {
    MigrationScriptGenerator.globalComputedColumns = [];
  }

  /**
   * Generate a single MSSQL ALTER statements file for all computed columns
   */
  static generateGlobalComputedColumnsFile(outputDir: string): string | null {
    if (MigrationScriptGenerator.globalComputedColumns.length === 0) {
      return null;
    }

    let computedColumnsScript = `-- ============================================================================\n`;
    computedColumnsScript += `-- MSSQL ALTER Statements for All Computed Columns\n`;
    computedColumnsScript += `-- ============================================================================\n`;
    computedColumnsScript += `-- IMPORTANT: This script contains ALTER statements in MSSQL format\n`;
    computedColumnsScript += `-- Execute this script in SQL Server Management Studio (SSMS)\n`;
    computedColumnsScript += `-- These statements add computed columns to MSSQL tables\n`;
    computedColumnsScript += `--\n`;
    computedColumnsScript += `-- Generated: ${new Date().toISOString()}\n`;
    computedColumnsScript += `-- Total Computed Columns: ${MigrationScriptGenerator.globalComputedColumns.length}\n`;
    computedColumnsScript += `-- ============================================================================\n\n`;

    // Group by table
    const columnsByTable = new Map<string, typeof MigrationScriptGenerator.globalComputedColumns>();
    for (const col of MigrationScriptGenerator.globalComputedColumns) {
      const tableKey = `${col.schema}.${col.table}`;
      if (!columnsByTable.has(tableKey)) {
        columnsByTable.set(tableKey, []);
      }
      columnsByTable.get(tableKey)!.push(col);
    }

    // Generate ALTER statements for each table
    for (const [tableKey, columns] of columnsByTable) {
      computedColumnsScript += `-- ============================================================================\n`;
      computedColumnsScript += `-- Table: ${tableKey}\n`;
      computedColumnsScript += `-- Computed Columns: ${columns.length}\n`;
      computedColumnsScript += `-- Jobs: ${[...new Set(columns.map(c => c.jobName))].join(', ')}\n`;
      computedColumnsScript += `-- ============================================================================\n\n`;

      for (const col of columns) {
        // Use the original MSSQL formula from the column
        const mssqlFormula = col.column.computedFormula || '';

        computedColumnsScript += `-- Column: ${col.column.name}\n`;
        computedColumnsScript += `-- Type: ${col.column.sqlServerType}\n`;
        computedColumnsScript += `-- Job: ${col.jobName}\n`;
        computedColumnsScript += `ALTER TABLE [${col.schema}].[${col.table}]\n`;
        computedColumnsScript += `ADD [${col.column.name}] AS ${mssqlFormula};\n`;
        computedColumnsScript += `GO\n\n`;
      }
    }

    const computedColumnsFile = path.join(outputDir, 'all_computed_columns_mssql.sql');
    fs.writeFileSync(computedColumnsFile, computedColumnsScript);

    return computedColumnsFile;
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

    // Array to track all computed columns for ALTER statement generation
    const allComputedColumns: Array<{
      schema: string;
      table: string;
      column: ColumnInfo;
      convertedFormula: string;
      inferredType: string;
    }> = [];

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

      // Extract computed columns for global ALTER statement generation
      const computedCols = this.starRocksGenerator.extractComputedColumns(schema, override);
      allComputedColumns.push(...computedCols);

      // Add to global collection with job name
      for (const col of computedCols) {
        MigrationScriptGenerator.globalComputedColumns.push({
          ...col,
          jobName,
        });
      }

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
    if (allComputedColumns.length > 0) {
      console.log(`   Computed Columns in this job: ${allComputedColumns.length}`);
    }
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

      // Reset global computed columns collection
      MigrationScriptGenerator.resetGlobalComputedColumns();

      const generator = new MigrationScriptGenerator(config);
      await generator.generate(options.detectChanges);

      // Generate single file with computed columns
      const computedColumnsFile = MigrationScriptGenerator.generateGlobalComputedColumnsFile(config.output.starRocksPath);

      if (computedColumnsFile) {
        console.log(`\n📝 Computed Columns Summary:`);
        console.log(`   All Computed Columns (MSSQL): ${computedColumnsFile}`);
        console.log(`   Total Computed Columns: ${MigrationScriptGenerator['globalComputedColumns'].length}`);
      }
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

      // Reset global computed columns collection
      MigrationScriptGenerator.resetGlobalComputedColumns();

      // Determine output directory from first config file
      let starRocksOutputDir: string | null = null;

      for (const configFile of configFiles) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`Processing: ${path.basename(configFile)}`);
        console.log('='.repeat(80));

        const configContent = fs.readFileSync(configFile, 'utf-8');
        const config: SchemaConfig = configFile.endsWith('.json')
          ? JSON.parse(configContent)
          : yaml.load(configContent) as SchemaConfig;

        // Store the output directory from the first config
        if (!starRocksOutputDir) {
          starRocksOutputDir = config.output.starRocksPath;
        }

        const generator = new MigrationScriptGenerator(config);
        await generator.generate(options.detectChanges);
      }

      // Generate single file with all computed columns
      if (starRocksOutputDir) {
        const computedColumnsFile = MigrationScriptGenerator.generateGlobalComputedColumnsFile(starRocksOutputDir);

        if (computedColumnsFile) {
          console.log(`\n\n📝 Computed Columns Summary:`);
          console.log(`   All Computed Columns (MSSQL): ${computedColumnsFile}`);
          console.log(`   Total Computed Columns: ${MigrationScriptGenerator['globalComputedColumns'].length}`);
        }
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