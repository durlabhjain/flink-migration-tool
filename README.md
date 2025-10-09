# SQL Server to Flink/StarRocks Migration Tool

A modern, configurable utility to generate Flink CDC and StarRocks DDL scripts from SQL Server schemas with automatic data type mapping and change detection.

## Features

- ✅ **Automatic Schema Extraction** from SQL Server databases
- ✅ **Intelligent Type Mapping** with customizable overrides
- ✅ **Flink CDC Table Generation** with proper connector configuration
- ✅ **StarRocks DDL Generation** with optimal table properties
- ✅ **Schema Checksums** for change tracking
- ✅ **Change Detection** to identify schema differences
- ✅ **YAML/JSON Configuration** for easy maintenance
- ✅ **Extensible Type System** with default mappings for all SQL Server types

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

### 1. Flink CDC Tables (`output/flink/{jobName}_flink.sql`)

The generated Flink script includes:

**A. Job Configuration** (at the top of the file):
```sql
-- Checkpoint and savepoint configuration
SET 'execution.checkpointing.interval' = '60s';
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';
SET 'state.backend' = 'rocksdb';
SET 'state.checkpoints.dir' = 'hdfs:///flink/checkpoints/my_job';
SET 'state.savepoints.dir' = 'hdfs:///flink/savepoints/my_job';
-- ... and more configuration
```

**B. Table Definitions**:
```sql
CREATE TABLE `sales_Orders` (
  `OrderId` INT NOT NULL,
  `CustomerId` INT NOT NULL,
  `OrderDate` TIMESTAMP(3),
  `TotalAmount` DECIMAL(18,2),
  PRIMARY KEY (`OrderId`) NOT ENFORCED
) WITH (
  'connector' = 'sqlserver-cdc',
  'hostname' = '<YOUR_SQL_SERVER_HOST>',
  'scan.incremental.snapshot.enabled' = 'true',
  'debezium.snapshot.mode' = 'initial',
  -- ... full CDC configuration
);
```

> 📖 **See [FLINK_OPERATIONS.md](FLINK_OPERATIONS.md)** for complete guide on checkpoints, savepoints, and job recovery.

### 2. StarRocks Tables (`output/starrocks/{jobName}_starrocks.sql`)

```sql
-- StarRocks Table Definitions for sales
-- Job: sales_realtime_sync

CREATE TABLE IF NOT EXISTS `sales_Orders` (
  `OrderId` INT NOT NULL,
  `CustomerId` INT NOT NULL,
  `OrderDate` DATETIME NULL,
  `TotalAmount` DECIMAL(18,2) NULL
)
PRIMARY KEY (`OrderId`)
DISTRIBUTED BY HASH(`OrderId`)
PROPERTIES (
  "replication_num" = "3"
);

CREATE TABLE IF NOT EXISTS `sales_OrderDetails` (
  ...
);
```

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
   npm run generate -- -c config.yaml
   
   # Commit checksums to version control
   git add output/checksums/checksums.json
   git commit -m "Initial schema baseline"
   ```

2. **Regular Updates**
   ```bash
   # Detect changes
   npm run generate -- -c config.yaml --detect-changes
   
   # Review changes
   git diff output/
   
   # Apply to Flink/StarRocks
   # ... apply scripts manually or via automation
   
   # Update baseline
   git add output/checksums/checksums.json
   git commit -m "Schema update: Added CustomerEmail column"
   ```

3. **Production Deployment**
   ```bash
   # Generate production scripts
   npm run generate -- -c config.prod.yaml
   
   # Review DDL
   less output/flink/flink_tables.sql
   less output/starrocks/starrocks_tables.sql
   
   # Test in staging first
   flink-sql < output/flink/flink_tables.sql
   
   # Deploy to production
   # ... after validation
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
```

Set environment variables:
```bash
export SQL_SERVER="localhost"
export SQL_DATABASE="MyDB"
export SQL_USER="admin"
export SQL_PASSWORD="secure_password"
```

Or use a `.env` file with `dotenv`:
```bash
npm install dotenv
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