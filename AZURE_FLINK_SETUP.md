# Azure Flink Operations Guide

Guide for managing Flink CDC jobs with checkpoints and savepoints on **Azure Blob Storage**.

## 🎯 Your Current Configuration

Based on your `flink-conf.yaml`:

```yaml
execution:
  checkpointing:
    interval: 30s                                    # ✅ Already configured
    externalized-checkpoint-retention: RETAIN_ON_CANCELLATION  # ✅ Already configured
    mode: EXACTLY_ONCE                               # ✅ Already configured

state:
  checkpoints:
    dir: wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints
  savepoints:
    dir: wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints
  backend: rocksdb                                   # ✅ Already configured
  backend.rocksdb.memory.managed: true              # ✅ Already configured
  backend.rocksdb.block.cache-size: 256mb           # ✅ Already configured
```

## ✅ What's Already Working

Your cluster is **already production-ready** with:
- ✅ Checkpoints every 30 seconds
- ✅ Exactly-once processing
- ✅ RocksDB state backend with managed memory
- ✅ Externalized checkpoints (survive cancellation)
- ✅ Azure Blob Storage for persistence

## 📋 How Generated Scripts Work with Your Config

### Generated Script Structure

```sql
-- =============================================================================
-- Job Configuration for sales_pipeline
-- =============================================================================
-- 
-- NOTE: Your cluster already has checkpoint configuration
-- The settings below are OPTIONAL job-specific overrides.
--
-- =============================================================================

-- OPTIONAL: Job-specific storage paths (commented out by default)
-- SET 'state.checkpoints.dir' = 'wasbs://...checkpoints/sales_pipeline';
-- SET 'state.savepoints.dir' = 'wasbs://...savepoints/sales_pipeline';

-- CDC source configuration (recommended for all CDC jobs)
SET 'table.exec.source.idle-timeout' = '30s';

-- Table definitions follow...
CREATE TABLE `sales_Orders` ( ... ) WITH ( ... );
```

### Default Behavior (Recommended)

**By default, generated scripts:**
- ✅ Use cluster-wide checkpoint settings (30s interval, EXACTLY_ONCE, etc.)
- ✅ Store checkpoints in: `wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints`
- ✅ Store savepoints in: `wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints`
- ✅ Include CDC-specific optimizations only

This is the **recommended approach** - let your cluster manage checkpointing.

### Optional: Job-Specific Paths

If you want to organize storage by job name, uncomment these lines in generated scripts:

```sql
-- Organize by job name
SET 'state.checkpoints.dir' = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints/sales_pipeline';
SET 'state.savepoints.dir' = 'wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/sales_pipeline';
```

**Pros:**
- Better organization for multiple jobs
- Easier to manage retention policies per job
- Clear separation in Azure Storage Explorer

**Cons:**
- Must configure for each job
- More configuration to maintain

## 🚀 Operations with Azure CLI

### View Checkpoints

```bash
# List all checkpoints
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix checkpoints/ \
  --output table

# List checkpoints for specific job (if using job-specific paths)
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix checkpoints/sales_pipeline/ \
  --output table
```

### View Savepoints

```bash
# List all savepoints
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix savepoints/ \
  --output table

# List savepoints for specific job
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix savepoints/sales_pipeline/ \
  --output table
```

### Create Savepoint

```bash
# Create savepoint (stored in configured savepoints dir)
flink savepoint <job-id>

# Example
flink savepoint a1b2c3d4e5f6

# Output shows Azure Blob Storage path:
# Savepoint completed. Path: wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/savepoint-a1b2c3-12345678
```

### Stop Job with Savepoint

```bash
# Stop job gracefully with savepoint
flink stop --savepointPath wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/sales_pipeline <job-id>
```

### Resume from Savepoint

```bash
# Resume from specific savepoint
flink run \
  -s wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/savepoint-123456 \
  -d your-job.jar
```

### Delete Old Checkpoints/Savepoints

```bash
# Delete specific checkpoint
az storage blob delete-batch \
  --account-name coolr0flink0starrocks \
  --source flink \
  --pattern 'checkpoints/chk-old-*'

# Delete savepoints older than 30 days
az storage blob delete-batch \
  --account-name coolr0flink0starrocks \
  --source flink \
  --pattern 'savepoints/*' \
  --if-unmodified-since $(date -d '30 days ago' -u +%Y-%m-%dT%H:%M:%SZ)
```

## 📊 Monitoring with Azure

### Using Azure Storage Explorer

1. Open Azure Storage Explorer
2. Connect to `coolr0flink0starrocks` storage account
3. Navigate to `flink` container
4. Browse `checkpoints/` and `savepoints/` folders
5. View checkpoint metadata and sizes

### Using Azure Portal

1. Go to Azure Portal → Storage Account `coolr0flink0starrocks`
2. Click "Containers" → "flink"
3. Browse checkpoints and savepoints
4. View metrics: storage used, blob count, etc.

### Monitoring Metrics

**Key metrics to track:**

```bash
# Get checkpoint storage size
az storage blob directory show \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --directory-path checkpoints \
  --query '[].properties.contentLength' \
  --output table

# Get savepoint count
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix savepoints/ \
  --query 'length(@)' \
  --output tsv
```

## 🔧 Tuning for Your Cluster

### Current Configuration is Good For:
- ✅ Most CDC workloads
- ✅ Moderate data volumes
- ✅ Mixed read/write state operations

### Consider Adjusting If:

#### Checkpoint Interval

**If you have HIGH volume CDC:**
```yaml
execution:
  checkpointing:
    interval: 15s  # More frequent for less data loss
```

**If you have LOW volume CDC:**
```yaml
execution:
  checkpointing:
    interval: 60s  # Less frequent for less overhead
```

#### RocksDB Memory

**If jobs have LARGE state:**
```yaml
state:
  backend.rocksdb.block.cache-size: 512mb  # Increase cache
```

**If jobs have SMALL state:**
```yaml
state:
  backend.rocksdb.block.cache-size: 128mb  # Reduce cache, save memory
```

## 🎯 Deployment Workflow

### 1. Generate Scripts
```bash
npm run generate -- -c configs/sales_schema.yaml
```

### 2. Review Generated Configuration
```bash
cat output/flink/sales_pipeline_flink.sql
```

**Check:**
- CDC source configuration is present
- Job-specific overrides are commented (using cluster defaults)
- Azure Blob Storage paths are correct

### 3. Deploy via SQL Client
```bash
# Start SQL Client
./bin/sql-client.sh

# Execute generated script
Flink SQL> SOURCE 'output/flink/sales_pipeline_flink.sql';
```

### 4. Verify Job Started
```bash
# List running jobs
flink list

# Check job details
flink info <job-id>
```

### 5. Verify Checkpointing
```bash
# Wait 30 seconds, then check for checkpoints
az storage blob list \
  --account-name coolr0flink0starrocks \
  --container-name flink \
  --prefix checkpoints/ \
  --output table
```

## 🔄 Recovery Scenarios

### Scenario 1: Job Crashes

**What happens:**
- Flink automatically restarts (failover-strategy: region)
- Job resumes from last checkpoint in Azure Blob Storage
- No manual intervention needed

**Verify recovery:**
```bash
# Check Flink logs
tail -f log/flink-*.log | grep -i checkpoint

# Look for: "Restoring job from latest checkpoint"
```

### Scenario 2: Cluster Restart

**What to do:**
```bash
# 1. Start Flink cluster
./bin/start-cluster.sh

# 2. Resubmit jobs
flink run -d sales-job.jar

# Jobs automatically find latest checkpoints in Azure Blob Storage
```

### Scenario 3: Planned Maintenance

**Best practice:**
```bash
# 1. Create savepoint and stop job
flink stop --savepointPath wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/sales_pipeline <job-id>

# 2. Perform maintenance

# 3. Resume from savepoint
flink run -s wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints/sales_pipeline/savepoint-latest -d sales-job.jar
```

## 💰 Cost Optimization

### Storage Costs

**Your checkpoint strategy:**
- Checkpoints every 30s = ~120 checkpoints/hour
- With externalized retention = checkpoints accumulate
- Need cleanup strategy!

**Recommended cleanup:**

```bash
# Automated cleanup script (save as cleanup-checkpoints.sh)
#!/bin/bash

ACCOUNT="coolr0flink0starrocks"
CONTAINER="flink"
RETENTION_HOURS=24  # Keep last 24 hours only

# Delete checkpoints older than retention period
az storage blob delete-batch \
  --account-name $ACCOUNT \
  --source $CONTAINER \
  --pattern 'checkpoints/chk-*' \
  --if-unmodified-since $(date -d "$RETENTION_HOURS hours ago" -u +%Y-%m-%dT%H:%M:%SZ)

echo "Cleanup completed"
```

**Run via cron:**
```bash
# Add to crontab (runs daily at 2 AM)
0 2 * * * /opt/flink/scripts/cleanup-checkpoints.sh
```

### Azure Blob Storage Lifecycle Management

**Alternative: Use Azure's built-in lifecycle policy**

1. Azure Portal → Storage Account → Lifecycle Management
2. Add rule:
   - Name: "cleanup-old-checkpoints"
   - Blob type: Block blobs
   - Prefix filter: `flink/checkpoints/`
   - Delete blobs older than: 7 days

## 🔒 Security Considerations

### Your Current Setup

```yaml
fs:
  azure:
    account:
      key:
        coolr0flink0starrocks.blob.core.windows.net: <<key>>
```

**Recommendations:**

1. **Use Managed Identity instead of storage key:**
   ```yaml
   fs:
     azure:
       account:
         auth:
           coolr0flink0starrocks.blob.core.windows.net: IDENTITY
   ```

2. **Rotate storage keys regularly**

3. **Use SAS tokens for limited access:**
   ```yaml
   fs:
     azure:
       sas:
         coolr0flink0starrocks.blob.core.windows.net: "?sv=2021-06-08&ss=..."
   ```

4. **Restrict network access:**
   - Azure Portal → Storage Account → Networking
   - Allow access only from Flink cluster IPs

## ✅ Checklist for Production

### Before Deploying Jobs

- [ ] flink-conf.yaml has correct Azure Blob Storage paths
- [ ] Storage account key is configured (or managed identity)
- [ ] Generated scripts reviewed and customized if needed
- [ ] Cleanup strategy for old checkpoints in place
- [ ] Monitoring configured (Azure Monitor or custom)

### After Deploying Jobs

- [ ] Verify checkpoints appearing in Azure Blob Storage
- [ ] Confirm checkpoint interval (should be ~30s)
- [ ] Test recovery by stopping and restarting job
- [ ] Create initial savepoint for rollback capability
- [ ] Document savepoint locations

### Regular Maintenance

- [ ] Weekly: Review checkpoint storage growth
- [ ] Monthly: Create and test savepoint restore
- [ ] Quarterly: Validate recovery procedures
- [ ] Annually: Review and optimize checkpoint configuration

## 📞 Quick Reference

### Your Azure Storage Paths
```
Checkpoints: wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/checkpoints
Savepoints:  wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/savepoints
History:     wasbs://flink@coolr0flink0starrocks.blob.core.windows.net/history
```

### Common Commands
```bash
# List checkpoints
az storage blob list --account-name coolr0flink0starrocks --container-name flink --prefix checkpoints/

# Create savepoint
flink savepoint <job-id>

# Resume from savepoint
flink run -s wasbs://...savepoints/savepoint-123 -d job.jar

# Stop with savepoint
flink stop --savepointPath wasbs://...savepoints/my_job <job-id>
```

---

**Need more help?** See `FLINK_OPERATIONS.md` for general Flink operations, and Azure Flink documentation for platform-specific features.