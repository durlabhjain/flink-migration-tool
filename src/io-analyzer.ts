import * as sql from 'mssql';
import { config as MSSQLConfig } from 'mssql';

// ============================================================================
// Types
// ============================================================================

export interface TableIOStats {
  schema: string;
  table: string;
  totalIOOperations: number;
  totalReads: number;
  totalUpdates: number;
  readWriteRatio: number;
  rowCount: number;
  lastActivity: Date | null;
  category: 'high' | 'medium' | 'low';
}

export interface IOAnalysisOptions {
  highIOThreshold: number;    // Default: 100000
  lowIOThreshold: number;     // Default: 10000
}

export interface IOAnalysisReport {
  analysisDate: string;
  schema: string;
  thresholds: {
    high: number;
    low: number;
  };
  summary: {
    totalTables: number;
    highIO: number;
    mediumIO: number;
    lowIO: number;
    configsGenerated?: number;
  };
  tables: Array<{
    name: string;
    category: 'high' | 'medium' | 'low';
    totalIOOperations: number;
    totalReads: number;
    totalUpdates: number;
    readWriteRatio: number;
    rowCount: number;
    lastActivity: string | null;
    configFile?: string;
  }>;
  configs?: Array<{
    file: string;
    jobName: string;
    category: 'high' | 'medium' | 'low' | 'bundle';
    tables: string[];
    estimatedIOOps: number;
  }>;
}

interface DatabaseConfig {
  server: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
}

// ============================================================================
// I/O Analyzer Class
// ============================================================================

export class IOAnalyzer {
  private connection: sql.ConnectionPool | null = null;

  constructor(private dbConfig: DatabaseConfig) {}

  async connect(): Promise<void> {
    const sqlConfig: MSSQLConfig = {
      server: this.dbConfig.server,
      database: this.dbConfig.database,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
      port: this.dbConfig.port || 1433,
      options: {
        encrypt: this.dbConfig.encrypt ?? true,
        trustServerCertificate: true,
      },
    };

    this.connection = new sql.ConnectionPool(sqlConfig);
    await this.connection.connect();
  }

  async disconnect(): Promise<void> {
    await this.connection?.close();
  }

  /**
   * Analyze table I/O operations from SQL Server DMVs
   */
  async analyzeTableIO(
    schema: string,
    options: IOAnalysisOptions
  ): Promise<TableIOStats[]> {
    if (!this.connection) throw new Error('Not connected to database');

    console.log(`\n📊 Analyzing I/O patterns for schema: ${schema}`);
    console.log(`   Querying table I/O statistics...`);

    let tables: TableIOStats[];

    try {
      // Query to get table I/O statistics using sys.dm_db_index_usage_stats
      const query = `
        SELECT
            OBJECT_SCHEMA_NAME(ios.object_id) AS SchemaName,
            OBJECT_NAME(ios.object_id) AS TableName,
            SUM(ios.user_seeks + ios.user_scans + ios.user_lookups) AS TotalReads,
            SUM(ios.user_updates) AS TotalWrites,
            SUM(ios.user_seeks + ios.user_scans + ios.user_lookups + ios.user_updates) AS TotalIO,
            MAX(ios.last_user_seek) AS LastSeek,
            MAX(ios.last_user_scan) AS LastScan,
            MAX(ios.last_user_update) AS LastUpdate
        FROM sys.dm_db_index_usage_stats AS ios
        WHERE ios.database_id = DB_ID()
            AND OBJECT_SCHEMA_NAME(ios.object_id) = @schema
            AND OBJECTPROPERTY(ios.object_id, 'IsUserTable') = 1
        GROUP BY ios.object_id
        ORDER BY TotalIO DESC;
      `;

      const result = await this.connection.request()
        .input('schema', schema)
        .query(query);

      console.log(`   ✓ Found ${result.recordset.length} tables with I/O statistics`);

      // If no I/O stats found, fall back to all tables
      if (result.recordset.length === 0) {
        console.log(`   ⚠️  No I/O statistics found (DMV may be empty or server recently restarted)`);
        console.log(`   📋 Fetching all tables from schema...`);
        tables = await this.getAllTablesAsFallback(schema);
      } else {
        // Get row counts for tables (separate query since we don't join with partitions)
        const tableNames = result.recordset.map((r: any) => r.TableName);
        const rowCountMap = await this.getRowCountsForTables(schema, tableNames);

        tables = result.recordset.map((row: any) => {
          const totalReads = Number(row.TotalReads) || 0;
          const totalWrites = Number(row.TotalWrites) || 0;
          const totalIO = Number(row.TotalIO) || 0;

          // Calculate read/write ratio
          let readWriteRatio = 0;
          if (totalWrites === 0 && totalReads > 0) {
            readWriteRatio = 999999; // Read-only
          } else if (totalWrites > 0) {
            readWriteRatio = totalReads / totalWrites;
          }

          // Determine last activity
          const lastSeek = row.LastSeek ? new Date(row.LastSeek) : null;
          const lastScan = row.LastScan ? new Date(row.LastScan) : null;
          const lastUpdate = row.LastUpdate ? new Date(row.LastUpdate) : null;
          const lastActivity = [lastSeek, lastScan, lastUpdate]
            .filter(d => d !== null)
            .sort((a, b) => b!.getTime() - a!.getTime())[0] || null;

          return {
            schema: row.SchemaName,
            table: row.TableName,
            totalIOOperations: totalIO,
            totalReads,
            totalUpdates: totalWrites,
            readWriteRatio,
            rowCount: rowCountMap.get(row.TableName) || 0,
            lastActivity,
            category: this.categorizeTable(totalIO, options),
          };
        });
      }
    } catch (error: any) {
      // Handle permission denied errors gracefully
      const errorMessage = error.message || '';
      const isPermissionError =
        errorMessage.toLowerCase().includes('permission') ||
        errorMessage.toLowerCase().includes('denied') ||
        (error.precedingErrors && error.precedingErrors.some((e: any) =>
          e.message && (e.message.toLowerCase().includes('permission') || e.message.toLowerCase().includes('denied'))
        ));

      if (isPermissionError) {
        console.log(`   ⚠️  Permission denied to access I/O statistics (VIEW SERVER STATE required)`);
        console.log(`   📋 Falling back to row-count based analysis...`);
        tables = await this.getTablesByRowCount(schema, options);
      } else {
        throw error;
      }
    }

    console.log(`   Analyzing I/O patterns...`);
    console.log(`   ✓ Categorization complete\n`);

    return tables;
  }

  /**
   * Get tables using database-level statistics when server-level DMV is unavailable
   * Tries multiple approaches in order of preference
   */
  private async getTablesByRowCount(
    schema: string,
    options: IOAnalysisOptions
  ): Promise<TableIOStats[]> {
    if (!this.connection) throw new Error('Not connected to database');

    // Try approach 1: sys.dm_db_index_operational_stats (database-level I/O statistics)
    try {
      console.log(`   Attempting to use database-level I/O statistics...`);
      const ioStatsQuery = `
        SELECT
          OBJECT_SCHEMA_NAME(ios.object_id) as SchemaName,
          OBJECT_NAME(ios.object_id) as TableName,
          SUM(ios.range_scan_count + ios.singleton_lookup_count) as TotalReads,
          SUM(ios.leaf_insert_count + ios.leaf_update_count + ios.leaf_delete_count) as TotalWrites,
          SUM(ios.row_lock_count + ios.page_lock_count) as LockRequests,
          SUM(ps.row_count) as TableRowCount,
          SUM(ps.used_page_count) * 8 as UsedSpaceKB,
          SUM(ps.reserved_page_count) * 8 as ReservedSpaceKB
        FROM sys.dm_db_index_operational_stats(DB_ID(), NULL, NULL, NULL) ios
        INNER JOIN sys.dm_db_partition_stats ps ON ios.object_id = ps.object_id AND ios.index_id = ps.index_id
        INNER JOIN sys.tables t ON ios.object_id = t.object_id
        WHERE OBJECT_SCHEMA_NAME(ios.object_id) = @schema
          AND ios.index_id IN (0, 1)
        GROUP BY ios.object_id
        ORDER BY SUM(ios.range_scan_count + ios.singleton_lookup_count + ios.leaf_insert_count + ios.leaf_update_count + ios.leaf_delete_count) DESC
      `;

      const result = await this.connection.request()
        .input('schema', schema)
        .query(ioStatsQuery);

      console.log(`   ✓ Found ${result.recordset.length} tables with I/O statistics`);
      console.log(`   ℹ️  Using actual database I/O statistics (reads + writes):`);
      console.log(`      Analyzing range scans, lookups, inserts, updates, deletes`);

      return result.recordset.map((row: any) => {
        const totalReads = Number(row.TotalReads) || 0;
        const totalWrites = Number(row.TotalWrites) || 0;
        const lockRequests = Number(row.LockRequests) || 0;
        const rowCount = Number(row.TableRowCount) || 0;
        const usedSpaceKB = Number(row.UsedSpaceKB) || 0;

        // Calculate total I/O operations (reads + writes + locks as activity indicator)
        const totalIOOps = totalReads + totalWrites + Math.floor(lockRequests / 10);

        // Calculate read/write ratio
        let readWriteRatio = 0;
        if (totalWrites === 0 && totalReads > 0) {
          readWriteRatio = 999999; // Read-only
        } else if (totalWrites > 0) {
          readWriteRatio = totalReads / totalWrites;
        }

        return {
          schema: row.SchemaName,
          table: row.TableName,
          totalIOOperations: totalIOOps,
          totalReads,
          totalUpdates: totalWrites,
          readWriteRatio,
          rowCount,
          lastActivity: null,
          category: this.categorizeTable(totalIOOps, options),
        };
      });
    } catch (statsError: any) {
      // Fallback approach 2: Simple row count from sys.partitions
      console.log(`   Database stats unavailable, using row count only...`);

      const query = `
        SELECT
          t.TABLE_SCHEMA as SchemaName,
          t.TABLE_NAME as TableName,
          SUM(p.[rows]) as TableRowCount
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN sys.partitions p ON OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME) = p.object_id
          AND p.index_id IN (0, 1)
        WHERE t.TABLE_SCHEMA = @schema
          AND t.TABLE_TYPE = 'BASE TABLE'
        GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME
        ORDER BY TableRowCount DESC
      `;

      const result = await this.connection.request()
        .input('schema', schema)
        .query(query);

      console.log(`   ✓ Found ${result.recordset.length} tables`);
      console.log(`   ℹ️  Using row count only (limited statistics available)`);
      console.log(`      Consider granting VIEW SERVER STATE for better I/O analysis`);

      return result.recordset.map((row: any) => {
        const rowCount = Number(row.TableRowCount) || 0;
        // Use row count × 10 as estimation (more conservative than ×100)
        const estimatedIOOps = rowCount * 10;

        return {
          schema: row.SchemaName,
          table: row.TableName,
          totalIOOperations: estimatedIOOps,
          totalReads: estimatedIOOps,
          totalUpdates: 0,
          readWriteRatio: 0,
          rowCount,
          lastActivity: null,
          category: this.categorizeTable(estimatedIOOps, options),
        };
      });
    }
  }

  /**
   * Fallback method to get all tables when DMV has no statistics
   */
  private async getAllTablesAsFallback(schema: string): Promise<TableIOStats[]> {
    if (!this.connection) throw new Error('Not connected to database');

    const query = `
      SELECT
        t.TABLE_SCHEMA as SchemaName,
        t.TABLE_NAME as TableName,
        p.[rows] as TableRowCount
      FROM INFORMATION_SCHEMA.TABLES t
      LEFT JOIN sys.partitions p ON OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME) = p.object_id
        AND p.index_id IN (0, 1)
      WHERE t.TABLE_SCHEMA = @schema
        AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY t.TABLE_NAME
    `;

    const result = await this.connection.request()
      .input('schema', schema)
      .query(query);

    console.log(`   ✓ Found ${result.recordset.length} tables`);
    console.log(`   ℹ️  All tables will be categorized as LOW I/O (no statistics available)`);

    return result.recordset.map((row: any) => ({
      schema: row.SchemaName,
      table: row.TableName,
      totalIOOperations: 0,
      totalReads: 0,
      totalUpdates: 0,
      readWriteRatio: 0,
      rowCount: Number(row.TableRowCount) || 0,
      lastActivity: null,
      category: 'low' as const,
    }));
  }

  /**
   * Get row counts for tables (used with I/O stats query)
   */
  private async getRowCountsForTables(
    schema: string,
    tableNames: string[]
  ): Promise<Map<string, number>> {
    if (!this.connection) throw new Error('Not connected to database');

    const rowCountMap = new Map<string, number>();

    const query = `
      SELECT
        t.name AS TableName,
        SUM(p.[rows]) AS TableRowCount
      FROM sys.tables t
      INNER JOIN sys.partitions p ON t.object_id = p.object_id
      WHERE t.schema_id = SCHEMA_ID(@schema)
        AND p.index_id IN (0, 1)
        AND t.name IN (${tableNames.map((_, i) => `@table${i}`).join(', ')})
      GROUP BY t.name
    `;

    const request = this.connection.request().input('schema', schema);
    tableNames.forEach((tableName, i) => {
      request.input(`table${i}`, tableName);
    });

    const result = await request.query(query);

    result.recordset.forEach((row: any) => {
      rowCountMap.set(row.TableName, Number(row.TableRowCount) || 0);
    });

    return rowCountMap;
  }

  /**
   * Categorize table based on I/O operations
   */
  private categorizeTable(
    totalIOOps: number,
    options: IOAnalysisOptions
  ): 'high' | 'medium' | 'low' {
    if (totalIOOps >= options.highIOThreshold) {
      return 'high';
    } else if (totalIOOps >= options.lowIOThreshold) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Generate analysis report
   */
  generateReport(
    tables: TableIOStats[],
    schema: string,
    options: IOAnalysisOptions
  ): IOAnalysisReport {
    const summary = {
      totalTables: tables.length,
      highIO: tables.filter(t => t.category === 'high').length,
      mediumIO: tables.filter(t => t.category === 'medium').length,
      lowIO: tables.filter(t => t.category === 'low').length,
    };

    return {
      analysisDate: new Date().toISOString(),
      schema,
      thresholds: {
        high: options.highIOThreshold,
        low: options.lowIOThreshold,
      },
      summary,
      tables: tables.map(t => ({
        name: t.table,
        category: t.category,
        totalIOOperations: t.totalIOOperations,
        totalReads: t.totalReads,
        totalUpdates: t.totalUpdates,
        readWriteRatio: t.readWriteRatio,
        rowCount: t.rowCount,
        lastActivity: t.lastActivity ? t.lastActivity.toISOString() : null,
      })),
    };
  }

  /**
   * Display analysis summary to console
   */
  displaySummary(tables: TableIOStats[], options: IOAnalysisOptions): void {
    const highIO = tables.filter(t => t.category === 'high');
    const mediumIO = tables.filter(t => t.category === 'medium');
    const lowIO = tables.filter(t => t.category === 'low');

    console.log('━'.repeat(80));
    console.log('📈 I/O Analysis Summary');
    console.log('━'.repeat(80));
    console.log();
    console.log(`Total Tables:           ${tables.length}`);
    console.log(`High I/O (>${this.formatNumber(options.highIOThreshold)}):       ${highIO.length} tables`);
    console.log(`Medium I/O (${this.formatNumber(options.lowIOThreshold)}-${this.formatNumber(options.highIOThreshold)}):  ${mediumIO.length} tables`);
    console.log(`Low I/O (<${this.formatNumber(options.lowIOThreshold)}):         ${lowIO.length} tables`);
    console.log();

    if (highIO.length > 0) {
      console.log('🔥 High I/O Tables (Individual Configs):');
      highIO.forEach(t => {
        console.log(`   • ${t.table.padEnd(25)} ${this.formatNumber(t.totalIOOperations).padStart(12)} ops`);
      });
      console.log();
    }

    if (mediumIO.length > 0) {
      console.log(`📦 Medium I/O Tables (${mediumIO.length} tables):`);
      console.log(`   Will be grouped intelligently by domain`);
      console.log();
    }

    if (lowIO.length > 0) {
      console.log(`📦 Low I/O Tables (${lowIO.length} tables):`);
      console.log(`   Will be bundled into single config`);
      console.log();
    }
  }

  private formatNumber(num: number): string {
    return num.toLocaleString();
  }
}
