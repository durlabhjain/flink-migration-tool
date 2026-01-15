# Quick Start Guide

Get up and running with the SQL Server to Flink/StarRocks migration tool in 5 minutes.

## Step 1: Project Setup (2 minutes)

```bash
# Clone or create project directory
git clone https://github.com/durlabhjain/flink-migration-tool.git
cd flink-migration-tool

# Install dependencies
npm install

# Create output directory structure
mkdir -p output/{flink,starrocks,checksums}
```

## Step 2: Verify Installation (1 minute)

Check that all components are ready:
```bash
# Verify TypeScript compilation
npm run build

# Check available commands
npm run generate -- --help
npm run generate-all -- --help
npm run analyze-io -- --help
```

## Step 3: Create Schema Configuration (1 minute)

Use one of the example configurations or create your own:

```bash
# Copy and modify an example
cp configs/examples/simple.yaml configs/my_config.yaml

# Or create from base template
cp configs/base_config_template.yaml configs/my_config.yaml
```

Example configuration (`configs/my_config.yaml`):

```yaml
database:
  server: "localhost"        # Your SQL Server host
  database: "YourDatabase"   # Your database name
  user: "your_user"          # SQL Server username
  password: "your_password"  # SQL Server password
  port: 1433
  encrypt: false             # Set to false for local SQL Server

# Optional: StarRocks connection (if omitted, placeholders will be used)
starRocks:
  feHost: "starrocks.example.com"
  database: "analytics"
  username: "root"
  password: "starrocks_password"
  jdbcPort: 9030
  loadPort: 8030

# Schema to process
schema: "dbo"                # Your schema name

# Optional: Environment for organizing outputs
environment: "dev"           # Creates dev/ subdirectories

# Optional: job name for organizing output
jobName: "sales_sync"

# Optional: Flink checkpoint configuration
flink:
  checkpointDir: "wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints"
  savepointDir: "wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints"

# Auto-discover tables with patterns
global:
  tables:
    # Include specific table patterns (optional)
    include:
      - "^Order.*"           # Tables starting with "Order"
      - "^Customer.*"        # Tables starting with "Customer"

    # Exclude unwanted tables
    exclude:
      - ".*_Archive$"        # Archive tables
      - "^tmp_"              # Temp tables
      - "sysdiagrams"        # SQL Server diagrams

  # Exclude unwanted columns globally
  columns:
    exclude:
      - "^Internal"          # Internal columns
      - "RowVersion"         # Row version columns

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

## Step 4: Generate Scripts (1 minute)

```bash
# Basic generation (auto-discovers tables based on patterns)
npm run generate -- -c configs/my_config.yaml

# With change detection (on subsequent runs)
npm run generate -- -c configs/my_config.yaml --detect-changes

# Generate from multiple config files
npm run generate-all -- -d configs/examples

# Auto-generate optimized configs based on I/O analysis
npm run analyze-io -- -b configs/base_config.yaml -o configs/auto-generated
```

## Step 5: Review Output

Check the generated files (organized by environment if specified):

```bash
# Flink CDC pipeline (complete job with CDC sources, StarRocks sinks, and INSERT statements)
cat output/flink/dev/sales_sync_YourDatabase.sql

# StarRocks table definitions
cat output/starrocks/dev/sales_sync_YourDatabase_starrocks.sql

# Computed columns (MSSQL ALTER statements)
cat output/starrocks/dev/all_computed_columns_mssql.sql

# Schema checksums (for change detection)
cat output/checksums/dev/sales_sync_YourDatabase_checksums.json
```

## Common First-Time Issues

### Connection Error: "Login failed"
```yaml
database:
  encrypt: false  # Try this for local SQL Server
```

### Connection Error: "Self-signed certificate"
Your SQL Server uses a self-signed certificate. The tool already sets `trustServerCertificate: true`, but if you still have issues:
```yaml
database:
  encrypt: false
```

### No Tables Found
Make sure you're using the correct schema name:
```sql
-- Check available schemas
SELECT DISTINCT TABLE_SCHEMA 
FROM INFORMATION_SCHEMA.TABLES;
```

## Next Steps

### Use I/O Analysis for Optimization

```bash
# Analyze table I/O patterns to auto-generate optimized configs
npm run analyze-io -- -b configs/base_config.yaml -o configs/optimized

# Generate report only (no config files)
npm run analyze-io -- -b configs/base_config.yaml --report-only
```

### Override Specific Tables

Use `tableOverrides` for fine-grained control:

```yaml
tableOverrides:
  - table: "Users"
    excludeColumns:
      - "Password"
      - "SSN"
    customMappings:
      Metadata:
        flink: "STRING"
        starRocks: "JSON"
```

### Environment-Based Configuration

Organize configurations by environment:

```yaml
# Development environment
environment: "dev"
database:
  server: "dev-sql.example.com"

# Production environment
environment: "prod"
database:
  server: "prod-sql.example.com"
```

### Use Environment Variables

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
export SQL_DATABASE="MyDatabase"
export SQL_USER="sa"
export SQL_PASSWORD="YourPassword123"
```

### Enable Change Detection

After your first run, use change detection to track schema modifications:

```bash
# First run - establishes baseline
npm run generate -- -c config.yaml

# Commit checksums
git add output/checksums/checksums.json
git commit -m "Schema baseline"

# Later, after schema changes
npm run generate -- -c config.yaml --detect-changes
```

You'll see output like:
```
Changes for dbo.Users:
  + Added column: MiddleName (varchar)
  - Removed column: OldField
  ~ Modified column: Status (int -> varchar)
```

## Example: Complete Workflow

```bash
# 1. Setup
git clone https://github.com/durlabhjain/flink-migration-tool.git
cd flink-migration-tool
npm install

# 2. Configure (use example or create your own)
cp configs/examples/simple.yaml configs/my_config.yaml
# Edit configs/my_config.yaml with your database details

# 3. Optional: Analyze I/O patterns for optimization
npm run analyze-io -- -b configs/my_config.yaml -o configs/optimized

# 4. Generate initial scripts
npm run generate -- -c configs/my_config.yaml

# 5. Review generated files
cat output/flink/dev/sales_sync_MyDatabase.sql
cat output/starrocks/dev/sales_sync_MyDatabase_starrocks.sql

# 6. Apply to StarRocks first
mysql -h starrocks-host -P 9030 -u root < output/starrocks/dev/sales_sync_MyDatabase_starrocks.sql

# 7. Apply to Flink (complete pipeline with CDC sources and sinks)
./bin/sql-client.sh -f output/flink/dev/sales_sync_MyDatabase.sql

# 8. Commit baseline for change detection
git add output/checksums/
git commit -m "Initial schema"

# 9. Later: detect changes
npm run generate -- -c configs/my_config.yaml --detect-changes
```

## Production Checklist

Before deploying to production:

- [ ] Test with development database first using I/O analysis
- [ ] Review all generated DDL scripts (CDC sources, StarRocks sinks, computed columns)
- [ ] Set up environment-based configurations (dev, staging, prod)
- [ ] Configure Flink checkpoint/savepoint directories
- [ ] Set up proper credential management (environment variables)
- [ ] Verify primary keys and column filtering work correctly
- [ ] Test StarRocks connection configuration
- [ ] Configure appropriate StarRocks properties (replication_num, etc.)
- [ ] Establish change detection workflow with git
- [ ] Review computed column handling and ALTER statements
- [ ] Test complete pipeline: SQL Server → Flink CDC → StarRocks

## Getting Help

1. **Read the full README.md** for detailed documentation
2. **Check Troubleshooting section** for common issues
3. **Review examples** in the documentation
4. **Verify SQL Server connectivity** using `sqlcmd` or SSMS

## Available Commands

### Generate Scripts
```bash
# Generate from single config
npm run generate -- -c configs/my_config.yaml

# Generate with change detection
npm run generate -- -c configs/my_config.yaml --detect-changes

# Generate from multiple configs
npm run generate-all -- -d configs/examples
npm run generate-all -- -d configs/examples --detect-changes
```

### I/O Analysis & Auto-Configuration
```bash
# Analyze and generate optimized configs
npm run analyze-io -- -b configs/base_config.yaml -o configs/generated

# Custom thresholds
npm run analyze-io -- -b configs/base_config.yaml --high-threshold 50000 --low-threshold 5000

# Report only (no config generation)
npm run analyze-io -- -b configs/base_config.yaml --report-only
```

## Example Configurations

Check the `configs/examples/` directory for various configuration examples:

- `simple.yaml` - Basic single-schema setup
- `large_database.yaml` - Multi-job configuration for large databases
- `sensitive_data.yaml` - Configuration with column exclusions
- `multi_job_*.yaml` - Examples of job-specific configurations

## Tips for Success

1. **Start small**: Begin with 1-2 tables using simple.yaml, verify output, then scale
2. **Use I/O analysis**: Let the tool auto-generate optimized configurations
3. **Environment organization**: Use environment-based folder structure
4. **Version control**: Commit configs and checksums to Git for change tracking
5. **Review outputs**: Always review generated SQL (CDC sources, sinks, computed columns)
6. **Test mappings**: Verify data type conversions with sample data
7. **StarRocks first**: Create StarRocks tables before running Flink pipeline

## Advanced Features

- **Environment support**: Organize configs by dev/staging/prod environments
- **I/O analysis**: Auto-generate configs based on table usage patterns
- **Computed columns**: Automatic handling with MSSQL ALTER statements
- **Multi-job support**: Process large databases with multiple optimized jobs
- **Change detection**: Track and report schema changes over time
- **StarRocks integration**: Direct sink connector configuration

Happy migrating! 🚀