# Quick Start Guide

Get up and running with the SQL Server to Flink/StarRocks migration tool in 5 minutes.

## Step 1: Project Setup (2 minutes)

```bash
# Create project directory
mkdir flink-migration-tool && cd flink-migration-tool

# Initialize npm project
npm init -y

# Install dependencies
npm install mssql js-yaml commander typescript glob @types/node @types/mssql @types/js-yaml ts-node

# Create directory structure
mkdir -p src configs output/{flink,starrocks,checksums}
```

## Step 2: Add the Tool (1 minute)

1. Copy the main TypeScript code to `src/index.ts`
2. Copy `package.json` template and merge with your existing one
3. Copy `tsconfig.json` to your project root

Update your `package.json` scripts section:
```json
{
  "scripts": {
    "generate": "ts-node src/index.ts generate",
    "generate-all": "ts-node src/index.ts generate-all"
  }
}
```

## Step 3: Create Schema Configuration (1 minute)

Create `configs/sales_schema.yaml`:

```yaml
database:
  server: "localhost"        # Your SQL Server host
  database: "YourDatabase"   # Your database name
  user: "your_user"          # SQL Server username
  password: "your_password"  # SQL Server password
  port: 1433
  encrypt: false             # Set to false for local SQL Server

# Schema to process
schema: "sales"              # Your schema name

# Optional: job name for organizing output
jobName: "sales_sync"

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
npm run generate -- -c configs/sales_schema.yaml

# With change detection (on subsequent runs)
npm run generate -- -c configs/sales_schema.yaml --detect-changes
```

## Step 5: Review Output

Check the generated files:

```bash
# Flink CDC table definitions
cat output/flink/sales_sync_flink.sql

# StarRocks table definitions
cat output/starrocks/sales_sync_starrocks.sql

# Schema checksums (for change detection)
cat output/checksums/sales_sync_checksums.json
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

### Add More Tables

```yaml
tables:
  - schema: "dbo"
    table: "Users"
  - schema: "dbo"
    table: "Orders"
  - schema: "sales"
    table: "Transactions"
```

### Exclude Sensitive Columns

```yaml
tables:
  - schema: "dbo"
    table: "Users"
    excludeColumns:
      - "Password"
      - "SSN"
      - "InternalNotes"
```

### Custom Type Mappings

```yaml
tables:
  - schema: "dbo"
    table: "Products"
    customMappings:
      Metadata:
        flink: "STRING"
        starRocks: "JSON"
      Price:
        flink: "DECIMAL(10,2)"
        starRocks: "DECIMAL(10,2)"
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
npm install

# 2. Configure (edit config.yaml with your database details)
vim config.yaml

# 3. Generate initial scripts
npm run generate -- -c config.yaml

# 4. Review generated DDL
cat output/flink/flink_tables.sql

# 5. Apply to Flink (example using Flink SQL Client)
# Update connection details in the generated SQL first!
# flink-sql -f output/flink/flink_tables.sql

# 6. Apply to StarRocks
# mysql -h starrocks-host -P 9030 -u root < output/starrocks/starrocks_tables.sql

# 7. Commit baseline
git add output/checksums/
git commit -m "Initial schema"

# 8. Later: detect changes
npm run generate -- -c config.yaml --detect-changes
```

## Production Checklist

Before deploying to production:

- [ ] Test with development database first
- [ ] Review all generated DDL scripts
- [ ] Update connection strings in Flink DDL (hostname, credentials)
- [ ] Verify primary keys are correct
- [ ] Check type mappings for your specific data
- [ ] Test with a small subset of data
- [ ] Set up proper credential management (environment variables)
- [ ] Configure appropriate StarRocks properties (replication_num, etc.)
- [ ] Establish change detection workflow
- [ ] Document your table configuration

## Getting Help

1. **Read the full README.md** for detailed documentation
2. **Check Troubleshooting section** for common issues
3. **Review examples** in the documentation
4. **Verify SQL Server connectivity** using `sqlcmd` or SSMS

## Example Configurations

### Local Development
```yaml
database:
  server: "localhost"
  database: "TestDB"
  user: "sa"
  password: "DevPassword123"
  encrypt: false

tables:
  - schema: "dbo"
    table: "TestTable"

output:
  flinkPath: "./dev-output/flink"
  starRocksPath: "./dev-output/starrocks"
  checksumPath: "./dev-output/state"
```

### Production with Environment Variables
```yaml
database:
  server: "${SQL_SERVER}"
  database: "${SQL_DATABASE}"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

tables:
  - schema: "prod"
    table: "Customers"
    excludeColumns:
      - "InternalNotes"
  - schema: "prod"
    table: "Orders"

output:
  flinkPath: "./prod-scripts/flink"
  starRocksPath: "./prod-scripts/starrocks"
  checksumPath: "./prod-scripts/state"
```

Set environment variables:
```bash
export SQL_SERVER="prod-sql.example.com"
export SQL_DATABASE="ProductionDB"
export SQL_USER="etl_user"
export SQL_PASSWORD="secure_password"
```

## Tips for Success

1. **Start small**: Begin with 1-2 tables, verify output, then add more
2. **Version control**: Commit config and checksums to Git
3. **Review DDL**: Always review generated SQL before applying
4. **Test mappings**: Verify data type conversions with sample data
5. **Automate**: Integrate into CI/CD for continuous schema sync

## What's Next?

- Set up automated schema checks in your CI/CD pipeline
- Configure multiple environments (dev, staging, prod)
- Customize type mappings for your specific use cases
- Implement change notifications (email, Slack, etc.)
- Create deployment scripts for Flink and StarRocks

Happy migrating! 🚀