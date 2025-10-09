# Configuration Directory

This directory contains your schema configuration files. Each YAML file defines migration rules for one schema or job.

## Directory Structure

```
configs/
├── README.md                    # This file
├── examples/                    # Example configurations (safe to commit)
│   ├── simple.yaml
│   ├── large_database.yaml
│   └── multi_job_*.yaml
├── dev/                         # Development configs (safe to commit)
│   └── sales_dev.yaml
├── staging/                     # Staging configs (be careful with credentials)
│   └── sales_staging.yaml
└── production/                  # Production configs (DO NOT COMMIT)
    └── sales_prod.yaml          # Use environment variables!
```

## Quick Start

1. **Copy an example:**
   ```bash
   cp examples/simple.yaml my_schema.yaml
   ```

2. **Edit with your database details:**
   ```bash
   vim my_schema.yaml
   ```

3. **Generate scripts:**
   ```bash
   npm run generate -- -c configs/my_schema.yaml
   ```

## Security Best Practices

### ⚠️ NEVER COMMIT PRODUCTION CREDENTIALS

Use environment variables for sensitive configs:

```yaml
database:
  server: "${PROD_SQL_SERVER}"
  database: "${PROD_DATABASE}"
  user: "${PROD_SQL_USER}"
  password: "${PROD_SQL_PASSWORD}"
```

### Safe to Commit
- ✅ Example configs
- ✅ Development configs (with dummy credentials)
- ✅ Config templates
- ✅ Pattern definitions

### DO NOT COMMIT
- ❌ Production credentials
- ❌ Staging passwords
- ❌ Any real database passwords
- ❌ Files ending with `_prod.yaml` or `_production.yaml`

## Configuration Tips

### For Small Databases (< 50 tables)
Use simple pattern matching:
```yaml
schema: "sales"
global:
  tables:
    exclude:
      - "^tmp_"
      - ".*_Archive$"
```

### For Large Databases (200+ tables)
Use broad patterns with targeted exclusions:
```yaml
schema: "warehouse"
jobName: "warehouse_full"

global:
  tables:
    include:
      - ".*"              # All tables
    exclude:
      - "^tmp"
      - ".*_(Archive|History|Staging|Backup)$"
  
  columns:
    exclude:
      - "^Internal"
      - "^System"
      - "RowVersion"
```

### For Multi-Job Splits
Create separate configs per job:
```
configs/
├── sales_orders_job.yaml       # Order tables
├── sales_customers_job.yaml    # Customer tables
└── sales_analytics_job.yaml    # Analytics tables
```

## Naming Conventions

We recommend:
- `{schema}_schema.yaml` - Single schema, all tables
- `{schema}_{job}_job.yaml` - Schema split into jobs
- `{env}_{schema}.yaml` - Environment-specific configs

Examples:
- `sales_schema.yaml`
- `sales_realtime_job.yaml`
- `dev_sales.yaml`
- `prod_inventory.yaml`

## Validation

Before committing, validate your config:

```bash
# Test generation
npm run generate -- -c configs/my_schema.yaml

# Check output
ls -la output/flink/
ls -la output/starrocks/
```

## Examples

See the `examples/` directory for:
- Simple configuration
- Large database (200+ tables)
- Multi-job splits
- Sensitive data filtering
- Complex type mappings

## Getting Help

- Read [QUICKSTART.md](../QUICKSTART.md) for setup
- Read [README.md](../README.md) for full documentation
- Check [EXAMPLES.md](../EXAMPLES.md) for more patterns
- See [MIGRATION_GUIDE.md](../MIGRATION_GUIDE.md) for pattern matching tips