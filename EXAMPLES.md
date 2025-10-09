# Configuration Examples

## Directory Structure for Multi-Schema/Multi-Job Setup

```
project/
├── configs/
│   ├── sales/
│   │   ├── sales_realtime.yaml      # Real-time sales data
│   │   └── sales_analytics.yaml     # Analytics tables
│   ├── hr/
│   │   └── hr_schema.yaml           # HR schema
│   ├── inventory/
│   │   └── inventory_schema.yaml    # Inventory schema
│   └── shared/
│       └── common_tables.yaml       # Shared/lookup tables
├── output/
│   ├── flink/
│   ├── starrocks/
│   └── checksums/
└── src/
    └── index.ts
```

---

## Example 1: Simple Schema - Include All Tables

**configs/hr/hr_schema.yaml**

```yaml
database:
  server: "localhost"
  database: "CompanyDB"
  user: "etl_user"
  password: "${SQL_PASSWORD}"
  encrypt: false

schema: "hr"
jobName: "hr_full_sync"

# No patterns = include all tables in the schema
# Just exclude system/temp tables
global:
  tables:
    exclude:
      - "^tmp_"
      - ".*_backup$"
      - ".*_archive$"
  
  columns:
    exclude:
      - "ssma_timestamp"
      - "RowVersion"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Example 2: Selective Pattern Matching

**configs/sales/sales_realtime.yaml**

```yaml
database:
  server: "prod-sql.example.com"
  database: "ProductionDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "sales_realtime_cdc"

# Only include real-time transactional tables
global:
  tables:
    include:
      - "^Order"           # Orders, OrderDetails, OrderPayments
      - "^Cart"            # Cart, CartItems
      - "^Payment"         # Payment-related tables
    exclude:
      - ".*_History$"      # Exclude history tables
      - ".*_Log$"          # Exclude log tables
  
  columns:
    exclude:
      - "^Internal"
      - "^Debug"
      - "AuditLog"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**configs/sales/sales_analytics.yaml**

```yaml
database:
  server: "prod-sql.example.com"
  database: "ProductionDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "sales_analytics_batch"

# Only include analytical/reporting tables
global:
  tables:
    include:
      - ".*Summary$"       # All summary tables
      - ".*Aggregate$"     # All aggregate tables
      - "^Report"          # Reporting tables
    exclude:
      - ".*_Temp$"
  
  columns:
    exclude:
      - "ComputedHash"
      - "ProcessingTime"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Example 3: Large Database with 200+ Tables

**configs/inventory/inventory_schema.yaml**

```yaml
database:
  server: "warehouse-sql.example.com"
  database: "WarehouseDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "inventory"
jobName: "inventory_master_data"

# For large schemas, use broad patterns
global:
  tables:
    # Include all tables except temp/archive
    include:
      - ".*"               # Include everything...
    exclude:
      - "^tmp"             # ...except temp tables
      - "^bak_"            # ...backup tables
      - ".*_Archive"       # ...archive tables
      - ".*_History"       # ...history tables
      - ".*_Staging"       # ...staging tables
      - "^test"            # ...test tables
      - "sysdiagrams"      # ...system tables
  
  columns:
    exclude:
      - "^Internal"        # Internal use columns
      - "^System"          # System columns
      - "^_"               # Columns starting with underscore
      - "ssma_timestamp"   # SSMA columns
      - "RowVersion"       # SQL Server row version
      - "ModifiedBy"       # Audit columns if not needed
      - "CreatedBy"        # Audit columns if not needed

# Override specific high-volume tables
tableOverrides:
  - table: "ProductInventory"
    # Use specific PK for partitioning
    primaryKey:
      - "ProductId"
      - "LocationId"
  
  - table: "InventoryTransactions"
    primaryKey:
      - "TransactionId"
    excludeColumns:
      - "DebugInfo"
      - "ProcessingMetadata"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Example 4: Multiple Jobs from Same Schema

**configs/sales/sales_job1_orders.yaml**

```yaml
database:
  server: "prod-sql.example.com"
  database: "SalesDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "orders_pipeline"  # First job: Orders processing

global:
  tables:
    include:
      - "^Order"          # Only Order* tables
    exclude:
      - ".*_Archive$"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**configs/sales/sales_job2_customers.yaml**

```yaml
database:
  server: "prod-sql.example.com"
  database: "SalesDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "customers_pipeline"  # Second job: Customer data

global:
  tables:
    include:
      - "^Customer"       # Only Customer* tables
    exclude:
      - ".*_Archive$"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

**configs/sales/sales_job3_products.yaml**

```yaml
database:
  server: "prod-sql.example.com"
  database: "SalesDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "products_pipeline"  # Third job: Product catalog

global:
  tables:
    include:
      - "^Product"        # Only Product* tables
      - "^Category"       # And Category tables
    exclude:
      - ".*_Archive$"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Example 5: Environment-Specific Configurations

**configs/dev/sales_dev.yaml**

```yaml
database:
  server: "dev-sql"
  database: "SalesDB_Dev"
  user: "dev_user"
  password: "dev_password"
  encrypt: false

schema: "sales"
jobName: "sales_dev"

global:
  tables:
    include:
      - ".*"            # Include all for dev testing
    exclude:
      - "^tmp"

output:
  flinkPath: "./output/dev/flink"
  starRocksPath: "./output/dev/starrocks"
  checksumPath: "./output/dev/checksums"
```

**configs/prod/sales_prod.yaml**

```yaml
database:
  server: "${PROD_SQL_SERVER}"
  database: "${PROD_DATABASE}"
  user: "${PROD_SQL_USER}"
  password: "${PROD_SQL_PASSWORD}"
  encrypt: true

schema: "sales"
jobName: "sales_prod"

global:
  tables:
    include:
      - "^Order"
      - "^Customer"
      - "^Product"
    exclude:
      - ".*_Test$"
      - ".*_Archive$"
  
  columns:
    exclude:
      - "^Internal"
      - "^Debug"
      - "TestColumn"

output:
  flinkPath: "./output/prod/flink"
  starRocksPath: "./output/prod/starrocks"
  checksumPath: "./output/prod/checksums"
```

---

## Example 6: Complex Column Filtering

**configs/sensitive/customer_data.yaml**

```yaml
database:
  server: "secure-sql.example.com"
  database: "CustomerDB"
  user: "${SQL_USER}"
  password: "${SQL_PASSWORD}"
  encrypt: true

schema: "dbo"
jobName: "customer_pii_filtered"

global:
  tables:
    include:
      - "Customers"
      - "CustomerContacts"
      - "CustomerAddresses"
  
  # Globally exclude PII columns
  columns:
    exclude:
      - "SSN"
      - "TaxId"
      - "CreditCard"
      - "Password"
      - "SecurityAnswer"
      - "BankAccount"

# Per-table: explicitly include only needed columns
tableOverrides:
  - table: "Customers"
    includeColumns:
      - "CustomerId"
      - "FirstName"
      - "LastName"
      - "Email"
      - "Phone"
      - "CreatedDate"
      - "Status"
    primaryKey:
      - "CustomerId"
  
  - table: "CustomerContacts"
    includeColumns:
      - "ContactId"
      - "CustomerId"
      - "ContactType"
      - "ContactValue"
      - "IsPrimary"
    primaryKey:
      - "ContactId"

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Example 7: Minimal Configuration (Quick Start)

**configs/simple.yaml**

```yaml
database:
  server: "localhost"
  database: "MyDB"
  user: "sa"
  password: "MyPassword"
  encrypt: false

schema: "dbo"

# That's it! Will process all tables in dbo schema

output:
  flinkPath: "./output/flink"
  starRocksPath: "./output/starrocks"
  checksumPath: "./output/checksums"
```

---

## Usage Examples

### Generate from a single config

```bash
npm run generate -- -c configs/sales/sales_realtime.yaml
```

### Generate with change detection

```bash
npm run generate -- -c configs/hr/hr_schema.yaml --detect-changes
```

### Generate from all configs in a directory

```bash
npm run generate-all -- -d configs/sales
```

### Generate from all configs (all schemas/jobs)

```bash
npm run generate-all -- -d configs --detect-changes
```

### Environment-specific generation

```bash
# Development
npm run generate -- -c configs/dev/sales_dev.yaml

# Production
export PROD_SQL_SERVER="prod-sql.example.com"
export PROD_DATABASE="SalesDB"
export PROD_SQL_USER="prod_user"
export PROD_SQL_PASSWORD="secure_password"

npm run generate -- -c configs/prod/sales_prod.yaml
```

---

## Pattern Matching Tips

### Common Patterns

```yaml
# Match tables starting with prefix
include:
  - "^Order"          # Orders, OrderDetails, OrderHistory

# Match tables ending with suffix
include:
  - ".*Summary$"      # DailySummary, MonthlySummary

# Match tables containing text
include:
  - "Transaction"     # UserTransactions, TransactionLog, PaymentTransactions

# Match exact table name
include:
  - "^Users$"         # Only "Users" table

# Match multiple prefixes
include:
  - "^(Order|Product|Customer)"

# Exclude specific patterns
exclude:
  - "^tmp_"           # Temporary tables
  - ".*_bak$"         # Backup tables
  - ".*_(archive|history|staging)$"  # Multiple suffixes
```

### Column Patterns

```yaml
# Exclude audit columns
columns:
  exclude:
    - "Created(By|Date|Time)"
    - "Modified(By|Date|Time)"
    - "Updated(By|Date|Time)"
    - "Deleted(By|Date|Time)"

# Exclude system columns
columns:
  exclude:
    - "^__"           # Double underscore prefix
    - "^sys"          # System prefix
    - "RowVersion"
    - "Timestamp"

# Include only specific column patterns
columns:
  include:
    - "^[A-Z]"        # Only columns starting with uppercase
    - "^[^_]"         # Only columns not starting with underscore
```

---

## Best Practices

1. **One schema per config file**: Easier to manage and organize
2. **Use jobName for splitting work**: Divide large schemas into multiple jobs
3. **Start with broad patterns**: Refine with excludes
4. **Use tableOverrides sparingly**: Only for exceptions
5. **Version control all configs**: Track changes over time
6. **Use environment variables**: Keep credentials secure
7. **Organize by domain**: Group related configs in subdirectories