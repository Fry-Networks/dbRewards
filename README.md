# dbRewards - Reward Management System

**⚠️ PRIVATE & CONFIDENTIAL - Internal Use Only**

A comprehensive reward management system for IoT devices with automated processing, auditing, and correction capabilities.

## 🏗️ System Architecture

### Core Components

- **🎯 Main Reward Engine** (`src/main.ts`) - Hourly automated reward processing
- **🔧 Reward Audit Tool** (`src/reward-audit.ts`) - Fix incorrect reward amounts
- **💰 Backpay System** (`src/backpay.ts`) - Generate missing reward records
- **📊 Performance Monitor** (`src/performance-monitor.ts`) - Database performance tracking
- **🚨 Health Checks & Alerting** (`src/health-check.ts`, `src/alerting.ts`) - System monitoring
- **🌐 Web Dashboard** (`src/web-dashboard.ts`) - Administrative interface

### Database Schemas

- **📱 Devices** (`src/db/devices-schema.ts`) - IoT device registry and configuration
- **🎁 Rewards** (`src/db/rewards-schema.ts`) - Reward transaction records
- **📦 Products** (`src/db/products-schema.ts`) - Device types and reward configurations
- **👥 Users** (`src/db/users-schema.ts`) - User account management

## 🚀 Quick Start

### Prerequisites

```bash
# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env
# Edit .env with your MongoDB connection string
```

### Environment Configuration

```env
# Database
MONGODB_URI=your_mongodb_connection_string
TEST_MODE=false

# Optional
DEBUG=false
DISCORD_WEBHOOK_URL=your_discord_webhook_for_alerts
```

### Running the System

```bash
# Start the main reward processing system
npm start

# Or run directly
npx ts-node src/main.ts

# Test mode
TEST_MODE=true npx ts-node src/main.ts
```

## 🛠️ Tools & Utilities

### 1. Reward Audit Tool 🔧

**Purpose**: Fix existing rewards with incorrect amounts

```bash
# Run the audit tool
npx ts-node src/reward-audit.ts

# With test mode
TEST_MODE=true npx ts-node src/reward-audit.ts
```

**📖 [Complete Audit Tool Guide →](./REWARD_AUDIT_GUIDE.md)**

**Use Cases:**
- Fix zero-amount rewards from old system bugs
- Correct staking calculation errors
- Update rewards for changed device configurations

### 2. Backpay System 💰

**Purpose**: Generate missing reward records for completely missing days

```bash
# Run the backpay tool
npx ts-node src/backpay.ts
```

**📖 [Complete Backpay Guide →](./BACKPAY_GUIDE.md)**

**Use Cases:**
- Fill gaps when reward system was down
- Generate rewards for newly registered devices
- Restore missing historical records

### 3. Web Dashboard 🌐

**Purpose**: Administrative interface for system monitoring

```bash
# Start the web dashboard
npx ts-node src/web-dashboard.ts
```

## 🎯 Reward System Logic

### Device Types Supported

- **Weather**: HWM (High Weather Monitor), LWM (Low Weather Monitor)
- **Air Quality**: IHAQM, ILAQM, OMAQM, IMAQM, OHAQM
- **Water Quality**: OLWQM, OHWQM
- **Radiation**: IRM
- **Hardware**: ISM, OSM, BM, IDM, ODM
- **Camera**: AOWSCM, AOWCM, AIWCM, etc.
- **Energy**: EM
- **Nodes**: SDN, SVN, RDN, CN, AEM

### Reward Calculation

Base reward calculation follows this logic:

1. **Base Amount**: From product configuration
2. **Staking Multipliers**:
   - Type "one" (24hr): 1.5x base reward
   - Type "two" (6 months): 3.0x base reward
3. **BYOD Reduction**: 50% reduction if device is BYOD
4. **Node Requirements**: Additional staking validation for node devices

### Processing Schedule

- **Hourly Processing**: Every hour at minute 5 (XX:05)
- **Device Distribution**: Hash-based assignment to distribute load across 24 hours
- **Status Updates**: Automatic "pending" → "claimable" after 30 days

## 📊 System Features

### Performance & Monitoring

- **Bulk Processing**: Optimized batch operations for 15K+ devices
- **Error Tracking**: Comprehensive error logging and recovery
- **Performance Metrics**: Database operation timing and optimization
- **Health Checks**: Automated system health monitoring
- **Discord Alerts**: Real-time notifications for system issues

### Safety & Reliability

- **Dry Run Mode**: Preview changes before applying them
- **Batch Processing**: Safe, incremental updates
- **Conflict Detection**: Prevents overlapping operations
- **Data Integrity**: Preserves reward sequence and timestamps
- **Rollback Support**: Audit trails for all changes

### Database Optimization

- **Connection Pooling**: Efficient MongoDB connection management
- **Query Optimization**: Indexed queries and aggregations
- **Bulk Operations**: Minimized database round trips
- **Performance Monitoring**: Real-time performance tracking

## 🏛️ Architecture Details

### Main Reward Engine (`main.ts`)

- **Hourly Scheduling**: Processes devices in 24-hour cycles
- **Hash Distribution**: Evenly distributes device processing across hours
- **Retry Logic**: Automatic retry for failed reward generations
- **Global Status Updates**: Daily batch status updates
- **Performance Tracking**: Comprehensive metrics collection

### Database Layer

- **Schema Validation**: TypeScript interfaces for type safety
- **Connection Management**: Robust MongoDB connection handling
- **Error Recovery**: Automatic reconnection and retry logic
- **Performance Monitoring**: Query timing and optimization insights

### Monitoring & Alerting

- **Health Checks**: Periodic system health verification
- **Discord Integration**: Real-time alert notifications
- **Error Tracking**: Centralized error logging and analysis
- **Performance Metrics**: Database and application performance monitoring

## 🔧 Development Commands

```bash
# Development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm run test         # Run tests (if configured)

# Utilities
npm run audit        # Run reward audit tool
npm run backpay      # Run backpay system
npm run dashboard    # Start web dashboard

# Database
npm run migrate      # Run database migrations (if configured)
npm run seed         # Seed test data (if configured)
```

## 🚨 Important Notes

### Data Safety

- **Always use dry-run mode** before making changes
- **Backup before major operations** 
- **Test in TEST_MODE** before production runs
- **Monitor during peak hours** to avoid conflicts

### Performance Considerations

- **Database Load**: 15K+ devices processed hourly
- **Memory Usage**: Batch processing to prevent memory issues
- **Network**: Optimized for MongoDB Atlas connections
- **Concurrency**: Designed for single-instance operation

### Security

- **Runtime Secrets**: 1Password Service Account token is read from `/etc/opt/dbrewards/op_service_account_token` via Docker secrets; no secret values live in `docker-compose.yml`
- **Environment Variables**: `op://` references are used at runtime; do not store secret values in `.env`
- **Host File Permissions**: `sudo chown root:1001 /etc/opt/dbrewards/op_service_account_token && sudo chmod 0440 /etc/opt/dbrewards/op_service_account_token`
- **Database Access**: Read-only MCP server for external access
- **Audit Trails**: All changes logged and tracked
- **Access Control**: Internal tools only

## 📋 Troubleshooting

### Common Issues

**High Database Load**
- Check batch sizes in configurations
- Monitor during off-peak hours
- Use performance monitoring tools

**Failed Reward Processing**
- Check device registration status
- Verify staking requirements
- Review error logs and retry

**Timing Conflicts**
- Coordinate with hourly processing schedule
- Use built-in conflict detection
- Run maintenance during low-traffic periods

### Getting Help

1. Check the specific tool guides (linked above)
2. Review error logs in the console output
3. Use dry-run mode to diagnose issues
4. Monitor Discord alerts for system status

## 📚 Additional Resources

- **[Reward Audit Tool Guide](./REWARD_AUDIT_GUIDE.md)** - Complete guide for fixing incorrect rewards
- **[Backpay System Guide](./BACKPAY_GUIDE.md)** - Complete guide for generating missing rewards
- **[Implementation Guide](./IMPLEMENTATION_GUIDE.md)** - Technical implementation details

---

**🔒 This system handles sensitive financial data. Always follow security protocols and test thoroughly before making production changes.**
