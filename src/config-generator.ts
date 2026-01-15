import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { TableIOStats, IOAnalysisReport } from './io-analyzer';

// ============================================================================
// Types
// ============================================================================

interface SchemaConfig {
  database: {
    server: string;
    serverHostname?: string;
    database: string;
    user: string;
    password: string;
    port?: number;
    encrypt?: boolean;
  };
  starRocks?: {
    feHost: string;
    database: string;
    username: string;
    password: string;
    jdbcPort?: number;
    loadPort?: number;
  };
  schema: string;
  environment?: string;
  jobName?: string;
  global?: {
    tables?: {
      include?: string[];
      exclude?: string[];
    };
    columns?: {
      include?: string[];
      exclude?: string[];
    };
  };
  output: {
    flinkPath: string;
    starRocksPath: string;
    checksumPath: string;
  };
}

interface ConfigGenerationOptions {
  maxTablesPerJob: number;      // Default: 10
  groupByDomain: boolean;        // Default: true
}

interface GeneratedConfig {
  file: string;
  jobName: string;
  category: 'high' | 'medium' | 'low' | 'bundle';
  tables: string[];
  estimatedUpdateOps: number;
  estimatedIOOps: number;
}

// ============================================================================
// Config Generator Class
// ============================================================================

export class ConfigGenerator {
  private generatedConfigs: GeneratedConfig[] = [];

  constructor(
    private baseConfig: Partial<SchemaConfig>,
    private options: ConfigGenerationOptions
  ) { }

  /**
   * Generate all configuration files based on I/O analysis
   */
  async generateAllConfigs(
    tables: TableIOStats[],
    outputDir: string
  ): Promise<GeneratedConfig[]> {
    this.generatedConfigs = [];

    // Create environment-specific output directory
    const environment = this.baseConfig.environment || 'default';
    const envOutputDir = path.join(outputDir, environment);

    // Ensure environment output directory exists
    if (!fs.existsSync(envOutputDir)) {
      fs.mkdirSync(envOutputDir, { recursive: true });
    }

    // Generate configs for high I/O tables (individual)
    const highIOTables = tables.filter(t => t.category === 'high');
    for (const table of highIOTables) {
      await this.generateHighIOConfig(table, envOutputDir);
    }

    // Generate single bundle config for all medium I/O tables
    const mediumIOTables = tables.filter(t => t.category === 'medium');
    if (mediumIOTables.length > 0) {
      await this.generateMediumIOBundleConfig(mediumIOTables, envOutputDir);
    }

    // Generate single bundle config for all low I/O tables
    const lowIOTables = tables.filter(t => t.category === 'low');
    if (lowIOTables.length > 0) {
      await this.generateLowIOBundleConfig(lowIOTables, envOutputDir);
    }

    return this.generatedConfigs;
  }

  /**
   * Generate individual config for high I/O table
   */
  private async generateHighIOConfig(
    table: TableIOStats,
    outputDir: string
  ): Promise<void> {
    const schema = table.schema;
    const tableName = table.table;
    const jobName = `${schema}_${tableName}`;
    const filename = `${schema}_${tableName}_config.yaml`;
    const filepath = path.join(outputDir, filename);

    const config: SchemaConfig = {
      ...this.getBaseConfigFields(),
      schema,
      jobName,
      global: {
        ...this.baseConfig.global,
        tables: {
          include: [tableName],
        },
      },
    };

    // Add comment header
    const comment = this.generateConfigComment({
      category: 'HIGH',
      totalIOOps: table.totalIOOperations,
      readWriteRatio: table.readWriteRatio,
      rowCount: table.rowCount,
      tables: [tableName],
    });

    this.writeConfigFile(config, filepath, comment);

    this.generatedConfigs.push({
      file: filename,
      jobName,
      category: 'high',
      tables: [tableName],
      estimatedUpdateOps: table.totalUpdates,
      estimatedIOOps: table.totalIOOperations,
    });
  }

  /**
   * Generate single bundle config for all medium I/O tables
   */
  private async generateMediumIOBundleConfig(
    tables: TableIOStats[],
    outputDir: string
  ): Promise<void> {
    const schema = tables[0].schema;
    const jobName = `${schema}_medium_io_bundle`;
    const filename = `${schema}_medium_io_bundle_config.yaml`;
    const filepath = path.join(outputDir, filename);

    const totalIOOps = tables.reduce((sum, t) => sum + t.totalIOOperations, 0);

    const config: SchemaConfig = {
      ...this.getBaseConfigFields(),
      schema,
      jobName,
      global: {
        ...this.baseConfig.global,
        tables: {
          include: tables.map(t => t.table),
        },
      },
    };

    const comment = this.generateConfigComment({
      category: 'MEDIUM (BUNDLE)',
      totalIOOps,
      readWriteRatio: 0,
      rowCount: tables.reduce((sum, t) => sum + t.rowCount, 0),
      tables: tables.map(t => t.table),
    });

    this.writeConfigFile(config, filepath, comment);

    this.generatedConfigs.push({
      file: filename,
      jobName,
      category: 'bundle',
      tables: tables.map(t => t.table),
      estimatedUpdateOps: tables.reduce((sum, t) => sum + t.totalUpdates, 0),
      estimatedIOOps: totalIOOps,
    });
  }

  /**
   * Generate bundle config for low I/O tables
   */
  private async generateLowIOBundleConfig(
    tables: TableIOStats[],
    outputDir: string
  ): Promise<void> {
    const schema = tables[0].schema;
    const jobName = `${schema}_low_io_bundle`;
    const filename = `${schema}_low_io_bundle_config.yaml`;
    const filepath = path.join(outputDir, filename);

    const totalIOOps = tables.reduce((sum, t) => sum + t.totalIOOperations, 0);

    const config: SchemaConfig = {
      ...this.getBaseConfigFields(),
      schema,
      jobName,
      global: {
        ...this.baseConfig.global,
        tables: {
          include: tables.map(t => t.table),
        },
      },
    };

    const comment = this.generateConfigComment({
      category: 'LOW (BUNDLE)',
      totalIOOps,
      readWriteRatio: 0,
      rowCount: tables.reduce((sum, t) => sum + t.rowCount, 0),
      tables: tables.map(t => t.table),
    });

    this.writeConfigFile(config, filepath, comment);

    this.generatedConfigs.push({
      file: filename,
      jobName,
      category: 'bundle',
      tables: tables.map(t => t.table),
      estimatedUpdateOps: tables.reduce((sum, t) => sum + t.totalUpdates, 0),
      estimatedIOOps: totalIOOps,
    });
  }

  /**
   * Group tables by domain (prefix)
   */
  private groupTablesByDomain(tables: TableIOStats[]): Map<string, TableIOStats[]> {
    const domainGroups = new Map<string, TableIOStats[]>();

    // Extract domain prefix with smarter logic
    const getDomain = (tableName: string): string => {
      // Handle multiple patterns:
      // 1. All caps prefix: "GLNumber" -> "gl", "QBInvoice" -> "qb"
      // 2. CamelCase: "OrderItems" -> "order", "CustomerAddress" -> "customer"
      // 3. Underscore separated: "Order_Route" -> "order"

      // First check for all-caps prefix (2+ consecutive capitals)
      const allCapsMatch = tableName.match(/^([A-Z]{2,})[A-Z][a-z]|^([A-Z]{2,})$/);
      if (allCapsMatch) {
        return (allCapsMatch[1] || allCapsMatch[2]).toLowerCase();
      }

      // Check for CamelCase (first word)
      const camelMatch = tableName.match(/^([A-Z][a-z]+)/);
      if (camelMatch) {
        return camelMatch[1].toLowerCase();
      }

      // Fallback to 'misc' for unusual naming
      return 'misc';
    };

    // Group by domain
    for (const table of tables) {
      const domain = getDomain(table.table);
      if (!domainGroups.has(domain)) {
        domainGroups.set(domain, []);
      }
      domainGroups.get(domain)!.push(table);
    }

    // Separate domains with multiple tables vs single tables
    const multiTableDomains = new Map<string, TableIOStats[]>();
    const singleTables: TableIOStats[] = [];

    for (const [domain, domainTables] of domainGroups) {
      if (domainTables.length > 1) {
        // Domain has multiple tables - keep grouped
        multiTableDomains.set(domain, domainTables);
      } else {
        // Single table in this domain - add to misc batch
        singleTables.push(...domainTables);
      }
    }

    // Create final groups
    const finalGroups = new Map<string, TableIOStats[]>();

    // Add multi-table domains as separate groups
    for (const [domain, domainTables] of multiTableDomains) {
      if (domainTables.length <= this.options.maxTablesPerJob) {
        // Single group for this domain
        finalGroups.set(`${domain}_group1`, domainTables);
      } else {
        // Split large domains into multiple groups
        for (let i = 0; i < domainTables.length; i += this.options.maxTablesPerJob) {
          const chunk = domainTables.slice(i, i + this.options.maxTablesPerJob);
          const groupNum = Math.floor(i / this.options.maxTablesPerJob) + 1;
          finalGroups.set(`${domain}_group${groupNum}`, chunk);
        }
      }
    }

    // Batch single tables together into misc groups
    if (singleTables.length > 0) {
      for (let i = 0; i < singleTables.length; i += this.options.maxTablesPerJob) {
        const chunk = singleTables.slice(i, i + this.options.maxTablesPerJob);
        const groupNum = Math.floor(i / this.options.maxTablesPerJob) + 1;
        finalGroups.set(`medium_misc_group${groupNum}`, chunk);
      }
    }

    return finalGroups;
  }

  /**
   * Get base config fields
   */
  private getBaseConfigFields() {
    return {
      database: this.baseConfig.database || {
        server: '<YOUR_SQL_SERVER_HOST>',
        database: '<DATABASE_NAME>',
        user: '<USERNAME>',
        password: '<PASSWORD>',
        port: 1433,
        encrypt: false,
      },
      starRocks: this.baseConfig.starRocks,
      environment: this.baseConfig.environment || 'default',
      output: this.baseConfig.output || {
        flinkPath: './output/flink',
        starRocksPath: './output/starrocks',
        checksumPath: './output/checksums',
      },
    };
  }

  /**
   * Generate comment header for config file
   */
  private generateConfigComment(params: {
    category: string;
    totalIOOps: number;
    readWriteRatio: number;
    rowCount: number;
    tables: string[];
  }): string {
    const now = new Date().toISOString();
    let comment = `# Auto-generated configuration based on I/O analysis\n`;
    comment += `# Generated: ${now}\n`;
    comment += `# I/O Category: ${params.category}\n`;
    comment += `# Total I/O Operations: ${params.totalIOOps.toLocaleString()}\n`;

    if (params.readWriteRatio > 0) {
      comment += `# Read/Write Ratio: ${params.readWriteRatio.toFixed(2)}:1\n`;
    }

    comment += `# Total Rows: ${params.rowCount.toLocaleString()}\n`;
    comment += `# Tables (${params.tables.length}): ${params.tables.join(', ')}\n`;
    comment += `\n`;

    return comment;
  }

  /**
   * Write config file with comment header
   */
  private writeConfigFile(
    config: SchemaConfig,
    filepath: string,
    comment: string
  ): void {
    const yamlContent = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
    });

    const content = comment + yamlContent;
    fs.writeFileSync(filepath, content, 'utf-8');
  }

  /**
   * Generate and save analysis report
   */
  saveAnalysisReport(
    report: IOAnalysisReport,
    outputDir: string
  ): void {
    // Add generated configs to report
    report.configs = this.generatedConfigs;
    report.summary.configsGenerated = this.generatedConfigs.length;

    // Update table entries with config file names
    for (const table of report.tables) {
      const config = this.generatedConfigs.find(c => c.tables.includes(table.name));
      if (config) {
        table.configFile = config.file;
      }
    }

    // Save report in environment-specific folder
    const environment = this.baseConfig.environment || 'default';
    const envOutputDir = path.join(outputDir, environment);
    const reportPath = path.join(envOutputDir, '_io_analysis_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  }

  /**
   * Display generation summary
   */
  displaySummary(outputDir: string): void {
    console.log('━'.repeat(80));
    console.log();

    const highConfigs = this.generatedConfigs.filter(c => c.category === 'high');
    const bundleConfigs = this.generatedConfigs.filter(c => c.category === 'bundle');

    if (highConfigs.length > 0) {
      console.log('🔥 High I/O Tables (Individual Configs):');
      highConfigs.forEach(c => {
        const opsStr = c.estimatedUpdateOps.toLocaleString().padStart(12);
        console.log(`   • ${c.tables[0].padEnd(30)} ${opsStr} ops  →  ${c.file}`);
      });
      console.log();
    }

    if (bundleConfigs.length > 0) {
      console.log('📦 Bundled Configs:');
      bundleConfigs.forEach(c => {
        const category = c.file.includes('medium') ? 'MEDIUM I/O' : 'LOW I/O';
        const opsStr = c.estimatedUpdateOps.toLocaleString().padStart(12);
        console.log(`   • ${category.padEnd(15)} ${c.tables.length.toString().padStart(3)} tables ${opsStr} ops  →  ${c.file}`);
      });
      console.log();
    }

    console.log('━'.repeat(80));
    console.log();
    const environment = this.baseConfig.environment || 'default';
    const envOutputDir = path.join(outputDir, environment);
    console.log(`✅ Generated ${this.generatedConfigs.length} config files in: ${envOutputDir}`);
    console.log(`✅ Analysis report saved: ${path.join(envOutputDir, '_io_analysis_report.json')}`);
    console.log();
    console.log('💡 Next steps:');
    console.log('   1. Review generated configs in', outputDir);
    console.log('   2. Run: npm run generate-all -- --config-dir', outputDir);
  }
}