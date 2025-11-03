# SQL Server to Flink/StarRocks Migration Tool

A modern, configurable utility to generate **complete, ready-to-run** Flink CDC pipelines and StarRocks DDL scripts from SQL Server schemas with automatic data type mapping and change detection.

## Key Improvements

This tool generates **production-ready, single-file SQL scripts** that can be executed directly:

- **🚀 One Command Deployment** - Run `./bin/sql-client.sh -f job.sql` to start your entire CDC pipeline
- **📦 Complete Pipeline in One File** - CDC sources + StarRocks sinks + data sync in a single SQL script
- **🔄 STATEMENT SET** - All tables sync as ONE Flink job with shared state and checkpointing
- **⚙️ Cluster-Aware** - Inherits your Flink cluster configuration, optional job-specific overrides
- **🎯 Pattern-Based Discovery** - Auto-discover tables using regex patterns, no manual table lists
- **🔧 Flexible Organization** - Split 200+ tables across multiple Flink jobs for better management
- **✅ Production-Grade** - Exactly-once semantics, incremental snapshots, comprehensive CDC configuration

## Features

- ✅ **Complete Pipeline Generation** - Single-file Flink SQL script ready to execute
- ✅ **STATEMENT SET Support** - All tables synchronized as one Flink job with shared checkpointing
- ✅ **Cluster-Aware Configuration** - Inherits cluster settings with optional job-specific overrides
- ✅ **Dual Table Generation** - Creates both CDC source and StarRocks sink tables in Flink
- ✅ **Automatic Schema Extraction** from SQL Server databases
- ✅ **Intelligent Type Mapping** with customizable overrides (38+ SQL Server types)
- ✅ **Pattern-Based Discovery** - Regex patterns to include/exclude tables and columns
- ✅ **Per-Table Overrides** - Custom primary keys, column filters, and type mappings
- ✅ **Schema Checksums** for change tracking with SHA-256 hashing
- ✅ **Change Detection** to identify schema differences between runs
- ✅ **Multi-Job Organization** - Split large schemas into multiple Flink jobs
- ✅ **YAML/JSON Configuration** for easy maintenance and version control
- ✅ **Production Ready** - Comprehensive CDC configuration with exactly-once semantics

## Installation

### Prerequisites

- Node.js 16+ or TypeScript environment
- Access to SQL Server database
- npm or yarn

### Setup

1. **Initialize the project:**

```bash
mkdir flink-migration-tool
cd flink-migration-tool
npm init -y
```

2. **Install dependencies:**

```bash
npm install mssql js-yaml commander typescript @types/node @types/mssql @types/js-yaml
npm install -D ts-node
```

3. **Setup TypeScript:**

```bash
npx tsc --init
```

4. **Copy the main script** to `src/index.ts`

5. **Add scripts to package.json:**

```json
{
  "scripts": {
    "build": "tsc",
    "start": "ts-node src/index.ts",
    "generate": "ts-node src/index.ts generate"
  }
}
```

## Configuration

The tool uses **schema-based configuration files** where each YAML file represents one schema or job. This makes it easy to manage large databases with hundreds of tables.

### Basic Configuration

Create a schema config file (e.g., `sales_schema.yaml`):

```yaml
database:
  server: "localhost"
  database: "MyDatabase"
  user: "sa"
  password: "YourPassword"
  port: 1433
  encrypt: true

# StarRocks connection (optional - if omitted, placeholders will be used)
starRocks:
  feHost: "${STARROCKS_FE_HOST}"      # Use environment variables for security
  database: "${STARROCKS_DATABASE}"
  username: "${STARROCKS_USERNAME}"
  password: "${STARROCKS_PASSWORD}"

# Schema to process
schema: "sales"

# Optional: job name for output files
jobName: "sales_realtime_sync"

# Global patterns for auto-discovery
global:
  tables:
    include:
      - "^Order.*"      # All tables starting with "Order"
      - "^Customer.*"   # All tables starting with "Customer"
    exclude:
      - ".*_Archive$"   # Exclude archive tables
      - "^tmp_"         # Exclude temp tables

  columns:
    exclude:
      - "^Internal"     # Exclude internal columns
      - "RowVersion"    # Exclude specific columns

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

### Configuration Options

#### Database Section
- `server`: SQL Server hostname or IP
- `database`: Database name
- `user`: Database username
- `password`: Database password (use `${ENV_VAR}` for environment variables)
- `port`: SQL Server port (default: 1433)
- `encrypt`: Enable encryption (default: true)

#### StarRocks Section (Optional)
Configure StarRocks connection details. If omitted, placeholders will be used in generated scripts.

- `feHost`: StarRocks Frontend host (e.g., `starrocks.example.com` or `${STARROCKS_FE_HOST}`)
- `database`: Target StarRocks database name (e.g., `analytics` or `${STARROCKS_DATABASE}`)
- `username`: StarRocks username (e.g., `root` or `${STARROCKS_USERNAME}`)
- `password`: StarRocks password (e.g., `password` or `${STARROCKS_PASSWORD}`)
- `jdbcPort`: JDBC port (optional, default: 9030)
- `loadPort`: HTTP port for Stream Load (optional, default: 8030)

**Example with direct values:**
```yaml
starRocks:
  feHost: "starrocks-prod.example.com"
  database: "analytics"
  username: "root"
  password: "secure_password"
```

**Example with environment variables:**
```yaml
starRocks:
  feHost: "${STARROCKS_FE_HOST}"
  database: "${STARROCKS_DATABASE}"
  username: "${STARROCKS_USERNAME}"
  password: "${STARROCKS_PASSWORD}"
```

**Mixed approach (recommended for production):**
```yaml
starRocks:
  feHost: "starrocks-prod.example.com"  # Direct value
  database: "${STARROCKS_DATABASE}"      # From environment
  username: "${STARROCKS_USERNAME}"      # From environment
  password: "${STARROCKS_PASSWORD}"      # From environment (secure)
```

#### Schema Section
- `schema`: Database schema name (required)
- `jobName`: Optional name for output files (defaults to schema name)

#### Global Patterns Section
Automatically discover and filter tables/columns using regex patterns:

**Tables:**
- `include`: Regex patterns to include tables (if omitted, includes all)
- `exclude`: Regex patterns to exclude tables (overrides includes)

**Columns:**
- `include`: Regex patterns to include columns (if omitted, includes all)
- `exclude`: Regex patterns to exclude columns (overrides includes)

#### Table Overrides Section
Override settings for specific tables:

```yaml
tableOverrides:
  - table: "Orders"
    primaryKey: ["OrderId"]
    excludeColumns: ["InternalNotes"]
    customMappings:
      Metadata:
        flink: "STRING"
        starRocks: "JSON"
```

#### Type Mappings Section
Add custom type mappings or override defaults:

```yaml
typeMappings:
  - sqlServer: "geography"
    flink: "STRING"
    starRocks: "STRING"
```

## Usage

### Single Schema Generation

Generate scripts for one schema:
```bash
npm run generate -- -c configs/sales_schema.yaml
```

With change detection:
```bash
npm run generate -- -c configs/sales_schema.yaml --detect-changes
```

### Multi-Schema Generation

Process all schemas in a directory:
```bash
npm run generate-all -- -d configs
```

With change detection:
```bash
npm run generate-all -- -d configs --detect-changes
```

### Organizing Large Databases

For databases with 200+ tables, create multiple config files:

```
configs/
├── sales_realtime.yaml     # Real-time transactional tables
├── sales_analytics.yaml    # Analytics/summary tables
├── hr_schema.yaml          # HR schema
└── inventory_schema.yaml   # Inventory schema
```

Generate all:
```bash
npm run generate-all -- -d configs
```

### Command Line Options

```bash
# Single schema
generate -c <config-file> [--detect-changes]

# Multiple schemas
generate-all -d <config-directory> [--detect-changes]

Options:
  -c, --config <path>         Path to schema configuration file
  -d, --config-dir <path>     Directory containing config files
  --detect-changes            Detect and display schema changes
  -h, --help                  Display help
  -V, --version               Display version
```

## Output

The tool generates three types of files per schema/job:

### 1. Flink CDC Pipeline (`output/flink/{jobName}_flink.sql`)

The generated Flink script is a **complete, ready-to-run pipeline** that includes:

**A. Job Configuration** (optional cluster overrides):
```sql
-- =============================================================================
-- Flink Job Configuration for sales_realtime_sync
-- =============================================================================
-- NOTE: Your cluster already has checkpoint configuration in flink-conf.yaml:
--   - Checkpoint Interval: 30s
--   - Mode: EXACTLY_ONCE
--   - State Backend: RocksDB
--   - Storage: wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/
--
-- The settings below are OPTIONAL job-specific overrides.
-- =============================================================================

-- OPTIONAL: Job-Specific Storage Paths
-- SET 'state.checkpoints.dir' = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints/sales_realtime_sync';
-- SET 'state.savepoints.dir' = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/sales_realtime_sync';

-- CDC Source Configuration (recommended)
SET 'table.exec.source.idle-timeout' = '30s';
```

**B. MSSQL CDC Source Tables**:
```sql
CREATE TABLE `sales_Orders_mssql` (
  `OrderId` INT NOT NULL,
  `CustomerId` INT NOT NULL,
  `OrderDate` TIMESTAMP(3),
  `TotalAmount` DECIMAL(18,2),
  PRIMARY KEY (`OrderId`) NOT ENFORCED
) WITH (
  'connector' = 'sqlserver-cdc',
  'hostname' = '<YOUR_SQL_SERVER_HOST>',
  'database-name' = '<DATABASE>',
  'schema-name' = 'sales',
  'table-name' = 'Orders',
  'scan.incremental.snapshot.enabled' = 'true',
  'debezium.snapshot.mode' = 'initial',
  -- ... full CDC configuration
);
```

**C. StarRocks Sink Tables** (Flink connectors):
```sql
CREATE TABLE `sales_Orders_sink` (
  `OrderId` INT NOT NULL,
  `CustomerId` INT NOT NULL,
  `OrderDate` TIMESTAMP(3),
  `TotalAmount` DECIMAL(18,2),
  PRIMARY KEY (`OrderId`) NOT ENFORCED
) WITH (
  'connector' = 'starrocks',
  'jdbc-url' = 'jdbc:mysql://<STARROCKS_FE_HOST>:9030',
  'load-url' = '<STARROCKS_FE_HOST>:8030',
  'database-name' = '<STARROCKS_DATABASE>',
  'table-name' = 'sales_Orders',
  'sink.buffer-flush.max-rows' = '500000',
  'sink.buffer-flush.max-bytes' = '104857600',
  -- ... Stream Load configuration
);
```

**D. Data Synchronization** (Single Job with STATEMENT SET):
```sql
-- All INSERT statements run as a SINGLE Flink job with shared checkpointing
EXECUTE STATEMENT SET
BEGIN

  -- Sync: sales.Orders
  INSERT INTO `sales_Orders_sink` (`OrderId`, `CustomerId`, `OrderDate`, `TotalAmount`)
  SELECT `OrderId`, `CustomerId`, `OrderDate`, `TotalAmount`
  FROM `sales_Orders_mssql`;

  -- Sync: sales.OrderDetails
  INSERT INTO `sales_OrderDetails_sink` (...)
  SELECT ...
  FROM `sales_OrderDetails_mssql`;

END;
```

**To Execute the Pipeline:**
```bash
# Run the complete pipeline as a single Flink job
./bin/sql-client.sh -f sales_realtime_sync_flink.sql

# Or in SQL Client interactive mode
./bin/sql-client.sh
Flink SQL> SOURCE 'sales_realtime_sync_flink.sql';
```

### 2. StarRocks Target Tables (`output/starrocks/{jobName}_starrocks.sql`)

**IMPORTANT:** Execute this script in **StarRocks SQL Client** BEFORE running the Flink pipeline.

```sql
-- ============================================================================
-- StarRocks Target Table for sales.Orders
-- ============================================================================
-- IMPORTANT: This script should be executed in StarRocks SQL Client
-- DO NOT run this script in Flink - it uses StarRocks-specific types and syntax
-- ============================================================================

CREATE TABLE IF NOT EXISTS `sales_Orders` (
  `OrderId` INT NOT NULL,
  `CustomerId` INT NOT NULL,
  `OrderDate` DATETIME NULL,
  `TotalAmount` DECIMAL(18,2) NULL
)
PRIMARY KEY (`OrderId`)
DISTRIBUTED BY HASH(`OrderId`)
PROPERTIES (
  "replication_num" = "3",
  "storage_format" = "DEFAULT"
);

-- Additional tables follow...
```

**Execution Order:**
1. **First**: Run `{jobName}_starrocks.sql` in StarRocks to create target tables
2. **Then**: Run `{jobName}_flink.sql` in Flink to start CDC replication

### 3. Schema Checksums (`output/checksums/{jobName}_checksums.json`)

JSON file containing complete schema metadata with SHA-256 checksums for change detection.

### Output Organization

For multiple jobs:
```
output/
├── flink/
│   ├── sales_realtime_sync_flink.sql
│   ├── sales_analytics_flink.sql
│   └── hr_full_sync_flink.sql
├── starrocks/
│   ├── sales_realtime_sync_starrocks.sql
│   ├── sales_analytics_starrocks.sql
│   └── hr_full_sync_starrocks.sql
└── checksums/
    ├── sales_realtime_sync_checksums.json
    ├── sales_analytics_checksums.json
    └── hr_full_sync_checksums.json
```

## Type Mappings

### Default Mappings

The tool includes comprehensive default mappings:

| SQL Server | Flink | StarRocks |
|------------|-------|-----------|
| int | INT | INT |
| bigint | BIGINT | BIGINT |
| varchar(n) | VARCHAR(n) | VARCHAR(n) |
| decimal(p,s) | DECIMAL(p,s) | DECIMAL(p,s) |
| datetime | TIMESTAMP(3) | DATETIME |
| bit | BOOLEAN | BOOLEAN |
| uniqueidentifier | VARCHAR(36) | VARCHAR(36) |

### Custom Mappings

Override mappings in three ways:

1. **Global type mapping** (in config):
```yaml
typeMappings:
  - sqlServer: "xml"
    flink: "STRING"
    starRocks: "STRING"
```

2. **Per-column mapping** (in table config):
```yaml
tables:
  - schema: "dbo"
    table: "Users"
    customMappings:
      ProfileData:
        flink: "STRING"
        starRocks: "JSON"
```

3. **Dynamic placeholders** (automatic):
- `{maxLength}` - Column max length
- `{precision}` - Numeric precision
- `{scale}` - Numeric scale

## Change Detection

Run with `--detect-changes` to see schema differences:

```
Changes for dbo.Customers:
  + Added column: MiddleName (varchar)
  - Removed column: OldField
  ~ Modified column: Status (varchar -> int)
  ~ Nullability changed: Email (NOT NULL -> NULL)
```

## Advanced Usage

### Programmatic Usage

```typescript
import { MigrationScriptGenerator, Config } from './index';

const config: Config = {
  database: {
    server: 'localhost',
    database: 'MyDB',
    user: 'sa',
    password: 'pass'
  },
  tables: [
    { schema: 'dbo', table: 'Users' }
  ],
  output: {
    flinkPath: './flink',
    starRocksPath: './starrocks',
    checksumPath: './checksums'
  }
};

const generator = new MigrationScriptGenerator(config);
await generator.generate(true); // true for change detection
```

### Extending Type Mappings

The `TypeMapper` class can be extended:

```typescript
class CustomTypeMapper extends TypeMapper {
  mapType(column: ColumnInfo, target: 'flink' | 'starRocks'): string {
    // Custom logic here
    return super.mapType(column, target);
  }
}
```

## Best Practices

1. **Version Control**: Store config files and generated checksums in Git
2. **CI/CD Integration**: Run with `--detect-changes` in CI pipeline
3. **Review Changes**: Always review generated DDL before applying
4. **Backup Checksums**: Keep historical checksums for auditing
5. **Environment Configs**: Use separate configs for dev/staging/prod

## Troubleshooting

### Connection Issues

If you see connection errors:
```yaml
database:
  encrypt: false  # Try disabling encryption for local SQL Server
  # or
  trustServerCertificate: true  # Add to options
```

### Type Mapping Warnings

When you see `No mapping found for type: X`:
1. Check if it's a custom SQL Server type
2. Add mapping in `typeMappings` section
3. Verify spelling matches `DATA_TYPE` from `INFORMATION_SCHEMA.COLUMNS`

### Missing Primary Keys

If tables lack primary keys:
- Tool falls back to first column
- Manually specify in config:
```yaml
tables:
  - schema: "dbo"
    table: "MyTable"
    primaryKey: ["Id"]
```

## Maintenance

### Updating Type Mappings

Edit `DEFAULT_TYPE_MAPPINGS` array or add to config:

```typescript
const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
  { sqlServer: 'newtype', flink: 'STRING', starRocks: 'STRING' },
  // Add more mappings as needed
];
```

### Adding New Generators

Create custom generators by extending base classes:

```typescript
class CustomFlinkGenerator extends FlinkScriptGenerator {
  generate(tableSchema: TableSchema, config: TableConfig): string {
    // Custom Flink generation logic
    return super.generate(tableSchema, config);
  }
}
```

## Examples

### Example 1: Simple Schema (All Tables)

**config/hr_schema.yaml:**
```yaml
database:
  server: "localhost"
  database: "CompanyDB"
  user: "admin"
  password: "password"

schema: "hr"

# No patterns = include all tables
global:
  tables:
    exclude:
      - "^tmp_"       # Exclude temp tables
  columns:
    exclude:
      - "RowVersion"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**Run:**
```bash
npm run generate -- -c configs/hr_schema.yaml
```

### Example 2: Large Database with 200+ Tables

**configs/inventory_schema.yaml:**
```yaml
database:
  server: "warehouse-sql.example.com"
  database: "WarehouseDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"

schema: "inventory"
jobName: "inventory_master_data"

global:
  tables:
    include:
      - ".*"           # Include all
    exclude:
      - "^tmp"
      - ".*_Archive$"
      - ".*_History$"
      - ".*_Staging$"
  
  columns:
    exclude:
      - "^Internal"
      - "^System"
      - "^_"
      - "RowVersion"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

### Example 3: Divide Schema into Multiple Jobs

**configs/sales_job1_orders.yaml:**
```yaml
database:
  server: "prod-sql"
  database: "SalesDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"

schema: "sales"
jobName: "sales_orders_pipeline"

global:
  tables:
    include:
      - "^Order"      # Only Order* tables

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**configs/sales_job2_customers.yaml:**
```yaml
database:
  server: "prod-sql"
  database: "SalesDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"

schema: "sales"
jobName: "sales_customers_pipeline"

global:
  tables:
    include:
      - "^Customer"   # Only Customer* tables

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**Process all jobs:**
```bash
npm run generate-all -- -d configs
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Schema Migration Check

on:
  pull_request:
    paths:
      - 'database/**'
  schedule:
    - cron: '0 0 * * *' # Daily check

jobs:
  check-schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm install
      
      - name: Generate scripts with change detection
        run: |
          npm run generate -- -c config.yaml --detect-changes
        env:
          SQL_PASSWORD: ${{ secrets.SQL_PASSWORD }}
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: migration-scripts
          path: |
            output/flink/
            output/starrocks/
            output/checksums/
```

### Jenkins Pipeline Example

```groovy
pipeline {
    agent any
    
    stages {
        stage('Generate Migration Scripts') {
            steps {
                script {
                    sh 'npm install'
                    sh 'npm run generate -- -c config.yaml --detect-changes'
                }
            }
        }
        
        stage('Archive Scripts') {
            steps {
                archiveArtifacts artifacts: 'output/**/*', fingerprint: true
            }
        }
        
        stage('Notify Changes') {
            when {
                expression { 
                    return sh(
                        script: 'grep -q "Modified column" output/changes.log',
                        returnStatus: true
                    ) == 0
                }
            }
            steps {
                emailext (
                    subject: "Schema Changes Detected",
                    body: readFile('output/changes.log'),
                    to: 'team@example.com'
                )
            }
        }
    }
}
```

## Migration Workflow

### Recommended Workflow

1. **Initial Setup**
   ```bash
   # Generate baseline scripts
   npm run generate -- -c config/sales_schema.yaml

   # Review generated files
   ls -l output/flink/sales_realtime_sync_flink.sql
   ls -l output/starrocks/sales_realtime_sync_starrocks.sql

   # Commit checksums to version control
   git add output/checksums/sales_realtime_sync_checksums.json
   git commit -m "Initial schema baseline for sales"
   ```

2. **Deploy to StarRocks (First Time)**
   ```bash
   # Execute StarRocks DDL to create target tables
   mysql -h <starrocks-host> -P 9030 -u root < output/starrocks/sales_realtime_sync_starrocks.sql

   # Verify tables created
   mysql -h <starrocks-host> -P 9030 -u root -e "SHOW TABLES FROM your_database;"
   ```

3. **Deploy Flink Pipeline**
   ```bash
   # Update connection parameters in the generated file
   vim output/flink/sales_realtime_sync_flink.sql
   # Replace <YOUR_SQL_SERVER_HOST>, <STARROCKS_FE_HOST>, etc.

   # Run complete pipeline as single Flink job
   ./bin/sql-client.sh -f output/flink/sales_realtime_sync_flink.sql

   # Monitor job
   ./bin/flink list
   ```

4. **Regular Updates (Schema Changes)**
   ```bash
   # Detect changes
   npm run generate -- -c config/sales_schema.yaml --detect-changes

   # Review changes
   git diff output/checksums/sales_realtime_sync_checksums.json

   # If schema changed:
   # 1. Stop Flink job (create savepoint first!)
   flink stop --savepointPath /path/to/savepoints <job-id>

   # 2. Update StarRocks tables (add new columns)
   mysql -h <starrocks-host> -P 9030 -u root < output/starrocks/sales_realtime_sync_starrocks.sql

   # 3. Restart Flink job from savepoint
   ./bin/sql-client.sh -f output/flink/sales_realtime_sync_flink.sql \
     -s wasbs://flink@storage.blob.core.windows.net/savepoints/sales_realtime_sync/savepoint-xxxxx

   # 4. Update baseline
   git add output/checksums/sales_realtime_sync_checksums.json
   git commit -m "Schema update: Added CustomerEmail column to sales.Orders"
   ```

5. **Production Deployment**
   ```bash
   # Generate production scripts with prod config
   npm run generate -- -c config.prod.yaml

   # Review DDL differences
   diff output/flink/sales_realtime_sync_flink.sql.old output/flink/sales_realtime_sync_flink.sql

   # Test in staging first
   ./bin/sql-client.sh -f output/flink/sales_realtime_sync_flink.sql

   # Monitor for issues
   ./bin/flink list

   # Check StarRocks data
   mysql -h <starrocks-host> -P 9030 -u root -e "SELECT COUNT(*) FROM sales_Orders;"

   # After validation, deploy to production
   ```

## Performance Considerations

### Large Databases

For databases with many tables:

1. **Batch Processing**: Process tables in groups
2. **Parallel Execution**: Modify to support concurrent extraction
3. **Filtering**: Use `excludeColumns` to reduce payload

### Optimization Tips

```yaml
# Process only changed tables
tables:
  - schema: "dbo"
    table: "FrequentlyChanging"
    # Separate config for stable tables
```

## Security Best Practices

### Credential Management

**Never commit credentials!** Use environment variables:

```yaml
database:
  server: "${SQL_SERVER}"
  database: "${SQL_DATABASE}"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"

starRocks:
  feHost: "${STARROCKS_FE_HOST}"
  database: "${STARROCKS_DATABASE}"
  username: "${STARROCKS_USERNAME}"
  password: "${STARROCKS_PASSWORD}"
```

Set environment variables:
```bash
# SQL Server credentials
export SQL_SERVER="localhost"
export SQL_DATABASE="MyDB"
export SQL_USER="admin"
export SQL_PASSWORD="secure_password"

# StarRocks credentials
export STARROCKS_FE_HOST="starrocks.example.com"
export STARROCKS_DATABASE="analytics"
export STARROCKS_USERNAME="root"
export STARROCKS_PASSWORD="starrocks_password"
```

Or use a `.env` file with `dotenv`:
```bash
npm install dotenv
```

Create a `.env` file:
```bash
# .env file
SQL_SERVER=localhost
SQL_DATABASE=MyDB
SQL_USER=admin
SQL_PASSWORD=secure_password

STARROCKS_FE_HOST=starrocks.example.com
STARROCKS_DATABASE=analytics
STARROCKS_USERNAME=root
STARROCKS_PASSWORD=starrocks_password
```

Update script to load environment:
```typescript
import 'dotenv/config';
```

### Secure Configuration Files

```bash
# Ignore sensitive configs
echo "config.prod.yaml" >> .gitignore
echo ".env" >> .gitignore
```

## Comparison with StarRocks SMT

| Feature | StarRocks SMT | This Tool |
|---------|---------------|-----------|
| Maintenance | Inactive | Active, extensible |
| Configuration | Limited | YAML/JSON, highly configurable |
| Type Mapping | Fixed | Customizable with overrides |
| Change Detection | None | Built-in with checksums |
| Data Sources | Limited | SQL Server (extensible) |
| Output Format | Fixed | Modular generators |
| CI/CD Ready | No | Yes |
| Language | Java | TypeScript/Node.js |

## Roadmap

Future enhancements:

- [ ] PostgreSQL source support
- [ ] MySQL source support
- [ ] Oracle source support
- [ ] Doris target support
- [ ] Interactive CLI wizard
- [ ] Web UI for configuration
- [ ] Parallel table processing
- [ ] Schema diff reporting (HTML/PDF)
- [ ] Auto-deployment to Flink/StarRocks
- [ ] Column-level lineage tracking

## Contributing

Contributions are welcome! Areas for improvement:

1. Additional source databases
2. More target data warehouses
3. Enhanced type mapping intelligence
4. Performance optimizations
5. Additional output formats

## License

MIT License - feel free to use and modify for your needs.

## Support

For issues or questions:
1. Check the Troubleshooting section
2. Review examples
3. Open an issue with configuration and error details

## Acknowledgments

Inspired by StarRocks SMT and the need for a modern, maintainable alternative for SQL Server to Flink/StarRocks migrations.