# Flink Checkpoint & Savepoint Operations Guide

Complete guide for managing Flink CDC jobs with proper checkpoint and savepoint configuration.

## 📋 Table of Contents

- [Overview](#overview)
- [Checkpoint Configuration](#checkpoint-configuration)
- [Savepoint Management](#savepoint-management)
- [Job Operations](#job-operations)
- [Recovery Scenarios](#recovery-scenarios)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

### What Are Checkpoints?

**Checkpoints** are automatic, periodic snapshots of your Flink job's state:
- Taken automatically at configured intervals
- Enable fault tolerance and exactly-once processing
- Survive job failures but NOT job cancellation (by default)
- Stored in distributed file system (HDFS, S3, etc.)

### What Are Savepoints?

**Savepoints** are manual, versioned snapshots:
- Triggered manually by operators
- Used for planned operations (upgrades, config changes)
- Survive job cancellation
- Can be used to restore jobs with different parallelism

### Why You Need Them

**Without checkpoints/savepoints:**
- ❌ Job restart reads entire database from scratch
- ❌ Duplicate data processing during recovery
- ❌ No exactly-once guarantees
- ❌ Lost progress on failure

**With checkpoints/savepoints:**
- ✅ Resume from exact point of failure
- ✅ Exactly-once processing semantics
- ✅ Fast recovery (seconds, not hours)
- ✅ Safe upgrades and maintenance

## Checkpoint Configuration

### Generated Configuration

The tool now generates complete checkpoint configuration in your Flink scripts:

```sql
-- Set checkpoint interval (every 60 seconds)
SET 'execution.checkpointing.interval' = '60s';

-- Set checkpointing mode to exactly-once
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';

-- Checkpoint timeout (10 minutes)
SET 'execution.checkpointing.timeout' = '10min';

-- Minimum pause between checkpoints (30 seconds)
SET 'execution.checkpointing.min-pause' = '30s';

-- Maximum concurrent checkpoints
SET 'execution.checkpointing.max-concurrent-checkpoints' = '1';

-- Enable externalized checkpoints (survive job cancellation)
SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';

-- State backend configuration
SET 'state.backend' = 'rocksdb';
SET 'state.backend.incremental' = 'true';

-- Checkpoint storage paths
SET 'state.checkpoints.dir' = 'hdfs:///flink/checkpoints/my_job';
SET 'state.savepoints.dir' = 'hdfs:///flink/savepoints/my_job';
```

### Key Parameters Explained

#### Checkpoint Interval
```sql
SET 'execution.checkpointing.interval' = '60s';
```
- **What it does:** How often checkpoints are taken
- **Recommended:** 30s - 5min depending on data volume
- **Trade-off:** 
  - Shorter = Less data loss on failure, more overhead
  - Longer = Less overhead, more data to replay on failure

#### Checkpointing Mode
```sql
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';
```
- **EXACTLY_ONCE:** Each record processed exactly once (recommended for CDC)
- **AT_LEAST_ONCE:** Faster but may duplicate records on failure

#### Checkpoint Timeout
```sql
SET 'execution.checkpointing.timeout' = '10min';
```
- **What it does:** Maximum time allowed for a checkpoint to complete
- **Recommended:** 5-15 minutes
- **Note:** If checkpoints consistently timeout, increase state backend performance

#### Externalized Checkpoints
```sql
SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';
```
- **RETAIN_ON_CANCELLATION:** Keep checkpoints after job cancellation (recommended)
- **DELETE_ON_CANCELLATION:** Delete checkpoints after cancellation

### Storage Configuration

#### HDFS (Production)
```sql
SET 'state.checkpoints.dir' = 'hdfs:///flink/checkpoints/sales_pipeline';
SET 'state.savepoints.dir' = 'hdfs:///flink/savepoints/sales_pipeline';
```

#### S3 (AWS)
```sql
SET 'state.checkpoints.dir' = 's3://my-bucket/flink/checkpoints/sales_pipeline';
SET 'state.savepoints.dir' = 's3://my-bucket/flink/savepoints/sales_pipeline';
```

#### Local Filesystem (Development Only)
```sql
SET 'state.checkpoints.dir' = 'file:///tmp/flink/checkpoints/sales_pipeline';
SET 'state.savepoints.dir' = 'file:///tmp/flink/savepoints/sales_pipeline';
```

⚠️ **Never use local filesystem in production!**

## Savepoint Management

### Creating a Savepoint

```bash
# Trigger savepoint for running job
flink savepoint <job-id> hdfs:///flink/savepoints/my_job

# Example
flink savepoint a1b2c3d4e5f6 hdfs:///flink/savepoints/sales_pipeline

# Output:
# Savepoint completed. Path: hdfs:///flink/savepoints/sales_pipeline/savepoint-a1b2c3-12345678
```

### Listing Savepoints

```bash
# HDFS
hdfs dfs -ls /flink/savepoints/sales_pipeline

# S3
aws s3 ls s3://my-bucket/flink/savepoints/sales_pipeline/

# Local
ls -la /tmp/flink/savepoints/sales_pipeline/
```

### Stopping Job with Savepoint

```bash
# Stop job and create savepoint atomically
flink stop --savepointPath hdfs:///flink/savepoints/my_job <job-id>

# Example
flink stop --savepointPath hdfs:///flink/savepoints/sales_pipeline a1b2c3d4e5f6
```

This ensures:
- All in-flight records are processed
- Savepoint is created
- Job stops gracefully

### Deleting Old Savepoints

```bash
# HDFS
hdfs dfs -rm -r /flink/savepoints/sales_pipeline/savepoint-old-12345678

# S3
aws s3 rm --recursive s3://my-bucket/flink/savepoints/sales_pipeline/savepoint-old-12345678/
```

## Job Operations

### Starting a New Job

```bash
# Start without savepoint (reads from beginning)
flink run -d your-job.jar
```

### Resuming from Latest Checkpoint

```bash
# Flink automatically resumes from latest checkpoint
# No special flags needed if checkpoints are externalized
flink run -d your-job.jar
```

Flink will:
1. Look for checkpoints in `state.checkpoints.dir`
2. Resume from most recent completed checkpoint
3. Continue CDC streaming from that point

### Resuming from Specific Savepoint

```bash
# Resume from savepoint
flink run -s hdfs:///flink/savepoints/my_job/savepoint-123456 -d your-job.jar

# Example
flink run -s hdfs:///flink/savepoints/sales_pipeline/savepoint-a1b2c3-12345678 -d sales-job.jar
```

### Resuming with Different Parallelism

```bash
# Increase parallelism from 4 to 8
flink run \
  -s hdfs:///flink/savepoints/my_job/savepoint-123456 \
  -p 8 \
  -d your-job.jar

# Decrease parallelism from 8 to 4
flink run \
  -s hdfs:///flink/savepoints/my_job/savepoint-123456 \
  -p 4 \
  -d your-job.jar
```

### Job Upgrade Workflow

```bash
# 1. Stop current job with savepoint
flink stop --savepointPath hdfs:///flink/savepoints/my_job <old-job-id>

# 2. Deploy new version
flink run \
  -s hdfs:///flink/savepoints/my_job/savepoint-latest \
  -d new-version-job.jar
```

## Recovery Scenarios

### Scenario 1: Job Crashes

**What happens:**
- Flink automatically restarts job based on restart strategy
- Resumes from last completed checkpoint
- Reprocesses data since last checkpoint

**No action needed** - automatic recovery!

**Logs will show:**
```
Restoring job from latest checkpoint
Checkpoint restored from hdfs:///flink/checkpoints/.../chk-123
```

### Scenario 2: Flink Cluster Restarts

**What happens:**
- Jobs were running with externalized checkpoints
- Submit jobs again, they resume automatically

**Action required:**
```bash
# Resubmit all jobs
flink run -d job1.jar
flink run -d job2.jar
# Jobs automatically find latest checkpoints
```

### Scenario 3: Planned Maintenance

**Action required:**
```bash
# 1. Create savepoint and stop job
flink stop --savepointPath hdfs:///flink/savepoints/my_job <job-id>

# 2. Perform maintenance

# 3. Restart from savepoint
flink run -s hdfs:///flink/savepoints/my_job/savepoint-latest -d job.jar
```

### Scenario 4: Code Changes

**For compatible changes** (add columns, change types):
```bash
# 1. Stop with savepoint
flink stop --savepointPath hdfs:///flink/savepoints/my_job <job-id>

# 2. Deploy new code
flink run -s hdfs:///flink/savepoints/my_job/savepoint-latest -d new-job.jar
```

**For incompatible changes** (schema changes, state structure):
```bash
# 1. Stop job
flink cancel <job-id>

# 2. Deploy new code (starts from beginning)
flink run -d new-job.jar
```

### Scenario 5: Source Database Restored

**If SQL Server was restored to earlier point:**
```bash
# 1. Stop current job
flink cancel <job-id>

# 2. Start fresh (no savepoint) to resync from database
flink run -d job.jar
```

## Best Practices

### Production Configuration

```sql
-- Checkpoints every 1-2 minutes
SET 'execution.checkpointing.interval' = '120s';

-- Exactly-once for CDC
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';

-- Generous timeout
SET 'execution.checkpointing.timeout' = '15min';

-- Prevent checkpoint storms
SET 'execution.checkpointing.min-pause' = '60s';

-- Always retain checkpoints
SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';

-- RocksDB for large state
SET 'state.backend' = 'rocksdb';
SET 'state.backend.incremental' = 'true';

-- Restart on failure
SET 'restart-strategy' = 'fixed-delay';
SET 'restart-strategy.fixed-delay.attempts' = '5';
SET 'restart-strategy.fixed-delay.delay' = '30s';
```

### Savepoint Strategy

**Regular savepoints:**
- Before code deployments
- Before configuration changes
- Before changing parallelism
- Weekly/monthly for compliance

**Retention policy:**
- Keep last 3 savepoints per job
- Keep pre-deployment savepoints for 30 days
- Keep monthly savepoints for 1 year

**Automation:**
```bash
# Cron job to create daily savepoints
0 2 * * * /opt/scripts/create-savepoint.sh sales_pipeline
```

### Monitoring

**Key metrics to monitor:**
- Checkpoint duration (should be < 50% of interval)
- Checkpoint size (growing over time indicates state leak)
- Checkpoint failure rate (should be near 0%)
- Time since last successful checkpoint

**Alerts:**
- Checkpoint duration > 5 minutes
- No successful checkpoint in 30 minutes
- Checkpoint size > 100GB (adjust per job)

### Storage Management

**Cleanup old checkpoints:**
```bash
# Keep last 10 checkpoints only
hdfs dfs -ls /flink/checkpoints/my_job | tail -n +11 | awk '{print $8}' | xargs -I {} hdfs dfs -rm -r {}
```

**Monitor storage usage:**
```bash
# HDFS
hdfs dfs -du -h /flink/checkpoints
hdfs dfs -du -h /flink/savepoints

# S3
aws s3 ls --summarize --recursive s3://bucket/flink/
```

## Troubleshooting

### Checkpoints Taking Too Long

**Symptoms:**
- Checkpoints timing out
- High checkpoint duration

**Solutions:**
1. Increase checkpoint interval:
   ```sql
   SET 'execution.checkpointing.interval' = '300s';
   ```

2. Increase timeout:
   ```sql
   SET 'execution.checkpointing.timeout' = '20min';
   ```

3. Use incremental checkpoints:
   ```sql
   SET 'state.backend.incremental' = 'true';
   ```

4. Increase parallelism to distribute state

### Checkpoint Failures

**Symptoms:**
- "Checkpoint expired before completing"
- "Checkpoint aborted"

**Solutions:**
1. Check storage connectivity (HDFS/S3)
2. Increase timeout
3. Check for backpressure in pipeline
4. Review TaskManager logs for errors

### Cannot Resume from Savepoint

**Error:** "Cannot map savepoint state to operator"

**Causes:**
- State structure changed incompatibly
- Operator UIDs changed
- State removed but expected

**Solutions:**
1. For compatible changes, use state migration:
   ```bash
   flink run --allowNonRestoredState -s savepoint-path job.jar
   ```

2. For incompatible changes, start fresh:
   ```bash
   flink run job.jar  # No savepoint
   ```

### Storage Full

**Symptoms:**
- Checkpoints failing with I/O errors
- "No space left on device"

**Solutions:**
1. Clean old checkpoints:
   ```bash
   # Delete checkpoints older than 7 days
   find /flink/checkpoints -type d -mtime +7 -exec rm -rf {} +
   ```

2. Implement automatic cleanup
3. Increase storage capacity
4. Use incremental checkpoints to reduce size

### Job Not Finding Checkpoints

**Symptoms:**
- Job starts from beginning despite checkpoints existing

**Solutions:**
1. Verify checkpoint directory matches:
   ```sql
   SHOW CREATE TABLE my_table;  -- Check state.checkpoints.dir
   ```

2. Check directory permissions:
   ```bash
   hdfs dfs -ls /flink/checkpoints/my_job
   ```

3. Ensure externalized checkpoints enabled:
   ```sql
   SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';
   ```

## Quick Reference

### Common Commands

```bash
# List running jobs
flink list

# Create savepoint
flink savepoint <job-id> hdfs:///path

# Stop with savepoint
flink stop --savepointPath hdfs:///path <job-id>

# Resume from savepoint
flink run -s hdfs:///path/savepoint-123 job.jar

# Cancel job (no savepoint)
flink cancel <job-id>

# List checkpoints
hdfs dfs -ls /flink/checkpoints/my_job
```

### Configuration Cheat Sheet

| Setting | Development | Production |
|---------|-------------|------------|
| Checkpoint Interval | 30s | 60-300s |
| Checkpoint Timeout | 5min | 10-15min |
| Min Pause | 10s | 30-60s |
| Externalized | RETAIN | RETAIN |
| State Backend | HashMap | RocksDB |
| Incremental | false | true |
| Storage | file:// | hdfs:// or s3:// |

---

**Remember:** Checkpoints are automatic, savepoints are manual. Use both for robust, production-ready CDC pipelines!