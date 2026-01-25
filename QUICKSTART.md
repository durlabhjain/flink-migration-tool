# Quick Start Guide

Get up and running with the SQL Server to Flink/StarRocks migration tool in 5 minutes.

## Step 1: Project Setup (2 minutes)

```bash
# Clone the repository
git clone https://github.com/durlabhjain/flink-migration-tool.git
cd flink-migration-tool

# Install dependencies and build
npm install
npm run build

# Create output directory structure
mkdir -p output/{flink,starrocks,checksums}
```

## Step 2: Verify Installation (1 minute)

Check that all commands are working:
```bash
# Check available commands (these should all show help text)
npm run generate -- --help
npm run generate-all -- --help
npm run analyze-io -- --help
```

## Step 3: Create Schema Configuration (1 minute)

Use one of the example configurations or create your own:

```bash
# Option 1: Use example configuration (recommended for first try)
cp configs/examples/simple.yaml configs/my_config.yaml

# Option 2: Create from base template
cp configs/base_config.yaml configs/my_config.yaml
```

**Edit the config file with your database details:**
```bash
# Edit the copied file with your database connection info
nano configs/my_config.yaml
# OR
code configs/my_config.yaml
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

**For your first run, use the basic generation command:**
```bash
# Generate Flink and StarRocks scripts from your config
npm run generate -- -c configs/my_config.yaml
```

**Alternative commands (use these later):**
```bash
# With change detection (after first run)
npm run generate -- -c configs/my_config.yaml --detect-changes

# Generate from multiple config files at once
npm run generate-all -- -d configs/examples

# Auto-generate optimized configs (advanced - requires existing database connection)
npm run analyze-io -- -b configs/my_config.yaml -o configs/auto-generated
```

## Step 5: Review Output

Check the generated files:

```bash
# First, see what files were created
ls -la output/flink/
ls -la output/starrocks/
ls -la output/checksums/

# View the generated Flink CDC pipeline
cat output/flink/*.sql

# View the StarRocks table definitions
cat output/starrocks/*.sql

# View checksums (for change detection)
cat output/checksums/*.json
```

**Note:** File names depend on your configuration. If you specified an environment (e.g., `environment: "dev"`), files will be in subdirectories like `output/flink/dev/`.

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
npm run build

# 2. Create configuration
cp configs/examples/simple.yaml configs/my_config.yaml
# Edit configs/my_config.yaml with your database connection details

# 3. Generate scripts
npm run generate -- -c configs/my_config.yaml

# 4. Check what was generated
ls -la output/flink/
ls -la output/starrocks/

# 5. View the generated SQL (file names will vary based on your config)
cat output/flink/*.sql
cat output/starrocks/*.sql

# 6. Apply to your systems (examples - adjust hostnames/credentials)
# First apply StarRocks table definitions:
mysql -h your-starrocks-host -P 9030 -u root < output/starrocks/*.sql

# Then apply Flink CDC pipeline:
# Upload the Flink SQL file to your Flink cluster or use sql-client

# 7. For change detection on subsequent runs
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

### Main Commands

**Basic script generation:**
```bash
npm run generate -- -c configs/my_config.yaml
```

**With change detection (after first run):**
```bash
npm run generate -- -c configs/my_config.yaml --detect-changes
```

**Multiple configs at once:**
```bash
npm run generate-all -- -d configs/examples
```

**I/O analysis (advanced):**
```bash
# Generate optimized configs based on table usage
npm run analyze-io -- -b configs/my_config.yaml -o configs/generated

# Just show analysis report
npm run analyze-io -- -b configs/my_config.yaml --report-only
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