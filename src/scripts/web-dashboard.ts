import express from 'express';
import { healthCheck } from '../health-check';
import { dbPerformanceMonitor } from '../performance-monitor';
import { alertingSystem } from '../alerting';
import { connect } from '../db/connect';
import { DeviceModel, TestDeviceModel } from '../db/devices-schema';
import { DeviceRewardModel, TestDeviceRewardModel } from '../db/device-rewards-schema';
import { tokenManager } from '../security/token-manager';
import { auditLogger } from '../security/audit-logger';
import { rateLimiter, createRateLimitMiddleware } from '../security/rate-limiter';
import { backupManager } from '../security/backup-manager';
import { dataValidator } from '../security/data-validator';
// PoC (Proof of Connectivity) imports
import {
  recordMinerActivity,
  recordMinerActivityBulk,
  getConnectivityReport,
  getDailyPocSummary,
  isPocEnabled,
} from '../poc/poc-service';
import "dotenv/config";

const app = express();
const PORT: number = Number(process.env.DASHBOARD_PORT) || 3001;
const testMode = process.env.TEST_MODE === 'true';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Enhanced security middleware for admin endpoints
const adminAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const allowedIPs = process.env.ADMIN_ALLOWED_IPS?.split(',') || [];
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  const endpoint = req.path;
  
  try {
    // Check if admin endpoints are disabled in production
    if (process.env.NODE_ENV === 'production' && process.env.ADMIN_ENDPOINTS_ENABLED !== 'true') {
      await auditLogger.logSecurityViolation(
        clientIP,
        'Admin endpoints disabled',
        { endpoint, userAgent }
      );
      return res.status(403).json({ 
        success: false, 
        message: 'Admin endpoints disabled in production' 
      });
    }
    
    // IP allowlist check (if configured)
    if (allowedIPs.length > 0 && !allowedIPs.includes(clientIP)) {
      await auditLogger.logAuthFailure(clientIP, 'IP not in allowlist', userAgent, endpoint);
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied - IP not allowed' 
      });
    }
    
    // Token-based authentication using new token manager
    const providedToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token as string;
    
    if (!providedToken) {
      await auditLogger.logAuthFailure(clientIP, 'No token provided', userAgent, endpoint);
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied - no token provided' 
      });
    }
    
    // Validate token using new token manager
    if (!tokenManager.isValidToken(providedToken)) {
      await auditLogger.logAuthFailure(clientIP, 'Invalid token', userAgent, endpoint);
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied - invalid token' 
      });
    }
    
    // Log successful authentication
    await auditLogger.logAuthSuccess(clientIP, userAgent, endpoint);
    
    // Check and rotate token if needed
    await tokenManager.checkAndRotateToken();
    
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    await auditLogger.logSecurityViolation(
      clientIP,
      'Admin auth middleware error',
      { error: error instanceof Error ? error.message : 'Unknown error', endpoint, userAgent }
    );
    return res.status(500).json({
      success: false,
      message: 'Internal authentication error'
    });
  }
};

// API Routes
app.get('/api/health', async (req, res) => {
  try {
    const health = await healthCheck();
    res.json(health);
  } catch (error) {
    res.status(500).json({ error: 'Health check failed', message: String(error) });
  }
});

app.get('/api/performance', async (req, res) => {
  try {
    const stats = dbPerformanceMonitor.getStats();
    const slowQueries = dbPerformanceMonitor.getSlowQueries(5);
    const errorQueries = dbPerformanceMonitor.getErrorQueries(5);
    
    res.json({
      stats,
      slowQueries,
      errorQueries,
      isPerformanceConcerning: dbPerformanceMonitor.isPerformanceConcerning()
    });
  } catch (error) {
    res.status(500).json({ error: 'Performance data fetch failed', message: String(error) });
  }
});

// ---------- Admin helpers (UTC utilities) ----------
function formatDateUTC(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getThisFridayStartUTC(ref: Date): Date {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0));
  const day = d.getUTCDay(); // 0=Sun..5=Fri
  const diffToFriday = (day + 7 - 5) % 7; // days since last Friday
  d.setUTCDate(d.getUTCDate() - diffToFriday);
  return d; // Friday 00:00 UTC of this week
}

function getWeekDatesFromFridayStart(fridayStart: Date): string[] {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(fridayStart.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(formatDateUTC(d));
  }
  return dates;
}

function getLastWeekWindowUTC(ref: Date): { weekStart: Date; weekEnd: Date; unlockAt: Date; dateStrings: string[] } {
  const thisFriday = getThisFridayStartUTC(ref);
  const weekStart = new Date(thisFriday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = new Date(thisFriday.getTime() - 1000);
  const unlockAt = new Date(thisFriday.getTime() + 5 * 60 * 1000);
  const dateStrings = getWeekDatesFromFridayStart(weekStart);
  return { weekStart, weekEnd, unlockAt, dateStrings };
}

// ---------- Admin API: seed, roll-up, mature, force-claim (ACCELERATED TEST TOOLS) ----------

// Seed daily accruals for a given device (or devices) for a given Friday-start week
// Body: { miner_keys: string[] | string, asset_id: string, amount: number, friday_start_utc?: string }
app.post('/api/admin/weekly/seed', createRateLimitMiddleware('admin'), adminAuth, async (req, res) => {
  try {
    await connect();
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    const { miner_keys, asset_id, amount, friday_start_utc } = req.body || {};
    if (!miner_keys || !asset_id || typeof amount !== 'number') {
      return res.status(400).json({ success: false, message: 'miner_keys, asset_id, amount required' });
    }
    const list: string[] = Array.isArray(miner_keys) ? miner_keys : [miner_keys];
    const start = friday_start_utc ? new Date(friday_start_utc) : getThisFridayStartUTC(new Date(new Date().getTime() + 7*24*60*60*1000));
    const dates = getWeekDatesFromFridayStart(start);

    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    let totalInserted = 0;
    for (const miner_key of list) {
      let doc = await Model.findOne({ miner_key });
      if (!doc) {
        doc = await Model.create({ miner_key });
      }
      let count = doc.reward_count || 0;
      for (const dateStr of dates) {
        count += 1;
        doc.daily_rewards.push({
          date: dateStr,
          amount: amount,
          status: 'accruing',
          asset_id: asset_id,
          created_at: new Date(`${dateStr}T00:00:00.000Z`),
          reward_number: count
        } as any);
        totalInserted += 1;
      }
      doc.reward_count = count;
      doc.last_updated = new Date();
      doc.last_reward_date = new Date();
      await doc.save();
    }
    await auditLogger.logAdminAction(
      clientIP,
      'Weekly seed operation',
      '/api/admin/weekly/seed',
      { totalInserted, minerKeys: list, assetId: asset_id, amount, dates },
      userAgent
    );

    return res.json({ success: true, inserted: totalInserted, days: dates });
  } catch (err) {
    console.error('admin/weekly/seed error', err);
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Roll-up last week (relative to ref date) into weekly_rewards
// Body: { ref_utc?: string }
app.post('/api/admin/weekly/rollup', createRateLimitMiddleware('admin'), adminAuth, async (req, res) => {
  try {
    await connect();
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    const ref = req.body?.ref_utc ? new Date(req.body.ref_utc) : new Date();
    const { weekStart, weekEnd, unlockAt, dateStrings } = getLastWeekWindowUTC(ref);
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const devices = await Model.find({ 'daily_rewards': { $elemMatch: { status: 'accruing', date: { $in: dateStrings } } } });
    let devicesProcessed = 0;
    let totalAdded = 0;
    for (const doc of devices) {
      const accruals = doc.daily_rewards.filter((r: any) => r.status === 'accruing' && dateStrings.includes(r.date));
      if (accruals.length === 0) continue;
      const byAsset = new Map<string, number>();
      for (const r of accruals) {
        byAsset.set(r.asset_id, Math.round(((byAsset.get(r.asset_id) || 0) + r.amount) * 100) / 100);
      }
      const existingAtUnlock = new Set((doc.weekly_rewards || []).filter((w: any) => new Date(w.unlock_at).getTime() === unlockAt.getTime()).map((w: any) => `${w.asset_id}`));
      let added = 0;
      for (const [asset_id, amt] of byAsset) {
        if (existingAtUnlock.has(asset_id)) continue;
        const nextNo = (doc.weekly_reward_count || 0) + 1;
        doc.weekly_rewards.push({
          week_start: weekStart,
          week_end: weekEnd,
          unlock_at: unlockAt,
          status: 'pending',
          asset_id,
          amount: amt,
          created_at: unlockAt,
          reward_number: nextNo
        } as any);
        doc.weekly_reward_count = nextNo;
        doc.total_pending = (doc.total_pending || 0) + amt;
        added++;
        totalAdded++;
      }
      if (added > 0) {
        // Mark accruals as aggregated
        for (const r of accruals) r.status = 'aggregated';
        doc.last_updated = new Date();
        await doc.save();
        devicesProcessed++;
      }
    }
    await auditLogger.logAdminAction(
      clientIP,
      'Weekly rollup operation',
      '/api/admin/weekly/rollup',
      { totalAdded, devicesProcessed, refDate: req.body?.ref_utc },
      userAgent
    );

    return res.json({ success: true, devicesProcessed, window: { weekStart, weekEnd, unlockAt, dateStrings } });
  } catch (err) {
    console.error('admin/weekly/rollup error', err);
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Mature weekly pending -> claimable for entries with unlock_at <= now - thresholdDays
// Body: { thresholdDays?: number }
app.post('/api/admin/weekly/mature', createRateLimitMiddleware('admin'), adminAuth, async (req, res) => {
  try {
    await connect();
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    const thresholdDays = typeof req.body?.thresholdDays === 'number' ? req.body.thresholdDays : 30;
    const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const devices = await Model.find({ 'weekly_rewards': { $elemMatch: { status: 'pending', unlock_at: { $lte: cutoff } } } });
    let updatedEntries = 0;
    for (const doc of devices) {
      let delta = 0;
      for (const wr of doc.weekly_rewards) {
        if (wr.status === 'pending' && wr.unlock_at <= cutoff) {
          wr.status = 'claimable';
          delta += wr.amount;
          updatedEntries++;
        }
      }
      if (delta > 0) {
        doc.total_pending = (doc.total_pending || 0) - delta;
        doc.total_claimable = (doc.total_claimable || 0) + delta;
        doc.last_updated = new Date();
        await doc.save();
      }
    }
    
    await auditLogger.logAdminAction(
      clientIP,
      'Weekly mature operation',
      '/api/admin/weekly/mature',
      { updatedEntries, thresholdDays, cutoff },
      userAgent
    );
    
    return res.json({ success: true, updatedEntries, cutoff });
  } catch (err) {
    console.error('admin/weekly/mature error', err);
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Force-claim all claimable weekly rewards (ACCELERATED/TEST: sets a fake tx id)
// Body: { miner_key?: string }
app.post('/api/admin/weekly/force-claim', createRateLimitMiddleware('admin'), adminAuth, async (req, res) => {
  try {
    await connect();
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    const Model = testMode ? TestDeviceRewardModel : DeviceRewardModel;
    const filter: any = req.body?.miner_key ? { miner_key: req.body.miner_key } : {};
    const devices = await Model.find(filter);
    let updated = 0;
    for (const doc of devices) {
      const claimables = doc.weekly_rewards.filter((wr: any) => wr.status === 'claimable');
      if (claimables.length === 0) continue;
      let sum = 0;
      for (const wr of claimables) {
        wr.status = 'claimed';
        wr.claimed_at = new Date();
        wr.tx_id = `SIMULATED-${Date.now()}`;
        sum += wr.amount;
      }
      doc.total_claimable = (doc.total_claimable || 0) - sum;
      doc.total_claimed = (doc.total_claimed || 0) + sum;
      await doc.save();
      updated += claimables.length;
    }
    
    await auditLogger.logAdminAction(
      clientIP,
      'Weekly force-claim operation',
      '/api/admin/weekly/force-claim',
      { updated, minerKey: req.body?.miner_key },
      userAgent
    );
    
    return res.json({ success: true, updated });
  } catch (err) {
    console.error('admin/weekly/force-claim error', err);
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ---------- PoC (Proof of Connectivity) API Endpoints ----------

/**
 * POST /api/poc/activity - Record miner activity (data received)
 * Called by miners/gateways when data is sent/received.
 *
 * Body: { miner_key: string, timestamp?: string (ISO) }
 * OR for bulk: { activities: Array<{ miner_key: string, timestamp?: string }> }
 */
app.post('/api/poc/activity', createRateLimitMiddleware('api'), async (req, res) => {
  try {
    if (!isPocEnabled()) {
      return res.status(503).json({
        success: false,
        message: 'Proof of Connectivity is disabled',
      });
    }

    await connect();

    const { miner_key, timestamp, activities } = req.body || {};

    // Handle bulk activity recording
    if (activities && Array.isArray(activities)) {
      const parsed = activities.map((a: { miner_key: string; timestamp?: string }) => ({
        minerKey: a.miner_key,
        timestamp: a.timestamp ? new Date(a.timestamp) : undefined,
      }));

      const count = await recordMinerActivityBulk(parsed);
      return res.json({
        success: true,
        recorded: count,
        message: `Recorded ${count} activity events`,
      });
    }

    // Handle single activity recording
    if (!miner_key) {
      return res.status(400).json({
        success: false,
        message: 'miner_key is required',
      });
    }

    const ts = timestamp ? new Date(timestamp) : undefined;
    const result = await recordMinerActivity(miner_key, ts);

    if (!result) {
      return res.status(500).json({
        success: false,
        message: 'Failed to record activity',
      });
    }

    return res.json({
      success: true,
      message: 'Activity recorded',
      connectivity: {
        date: result.date,
        hoursWithData: result.hours_with_data,
        connectivityPercentage: result.connectivity_percentage,
      },
    });
  } catch (error) {
    console.error('PoC activity recording error:', error);
    res.status(500).json({
      success: false,
      message: String(error),
    });
  }
});

/**
 * GET /api/poc/report/:minerKey/:date - Get connectivity report for a miner on a date
 * Date format: YYYY-MM-DD
 */
app.get('/api/poc/report/:minerKey/:date', async (req, res) => {
  try {
    if (!isPocEnabled()) {
      return res.status(503).json({
        success: false,
        message: 'Proof of Connectivity is disabled',
      });
    }

    await connect();

    const { minerKey, date } = req.params;

    if (!minerKey || !date) {
      return res.status(400).json({
        success: false,
        message: 'minerKey and date are required',
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Use YYYY-MM-DD',
      });
    }

    const report = await getConnectivityReport(minerKey, date);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'No connectivity data found for this miner and date',
      });
    }

    return res.json({
      success: true,
      report,
    });
  } catch (error) {
    console.error('PoC report error:', error);
    res.status(500).json({
      success: false,
      message: String(error),
    });
  }
});

/**
 * GET /api/poc/summary/:date - Get daily PoC summary across all miners
 * Date format: YYYY-MM-DD
 */
app.get('/api/poc/summary/:date', async (req, res) => {
  try {
    if (!isPocEnabled()) {
      return res.status(503).json({
        success: false,
        message: 'Proof of Connectivity is disabled',
      });
    }

    await connect();

    const { date } = req.params;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'date is required',
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Use YYYY-MM-DD',
      });
    }

    const summary = await getDailyPocSummary(date);

    return res.json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error('PoC summary error:', error);
    res.status(500).json({
      success: false,
      message: String(error),
    });
  }
});

/**
 * GET /api/poc/status - Get PoC system status
 */
app.get('/api/poc/status', async (req, res) => {
  try {
    const enabled = isPocEnabled();
    const today = new Date().toISOString().split('T')[0];

    let todaySummary = null;
    if (enabled) {
      await connect();
      todaySummary = await getDailyPocSummary(today);
    }

    return res.json({
      success: true,
      enabled,
      today: todaySummary,
    });
  } catch (error) {
    console.error('PoC status error:', error);
    res.status(500).json({
      success: false,
      message: String(error),
    });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    await connect();
    
    // Get basic metrics
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const totalDevices = await (testMode ? TestDeviceModel : DeviceModel)
      .countDocuments({ is_registered: true });
    
    const deviceRewardsModel = testMode ? TestDeviceRewardModel : DeviceRewardModel;

    const dailyCountPipeline = (start: Date, end?: Date) => {
      const match: Record<string, unknown> = {
        'daily_rewards.created_at': { $gte: start }
      };
      if (end) {
        (match['daily_rewards.created_at'] as any).$lt = end;
      }
      return [
        { $unwind: '$daily_rewards' },
        { $match: match },
        { $count: 'total' }
      ];
    };

    const [
      todayCountRes,
      yesterdayCountRes,
      weekCountRes,
      pendingDailyRes,
      pendingWeeklyRes,
      claimableDailyRes,
      claimableWeeklyRes
    ] = await Promise.all([
      deviceRewardsModel.aggregate(dailyCountPipeline(todayStart)),
      deviceRewardsModel.aggregate(dailyCountPipeline(yesterdayStart, todayStart)),
      deviceRewardsModel.aggregate(dailyCountPipeline(weekStart)),
      deviceRewardsModel.aggregate([
        { $unwind: '$daily_rewards' },
        { $match: { 'daily_rewards.status': 'pending' } },
        { $count: 'total' }
      ]),
      deviceRewardsModel.aggregate([
        { $unwind: '$weekly_rewards' },
        { $match: { 'weekly_rewards.status': 'pending' } },
        { $count: 'total' }
      ]),
      deviceRewardsModel.aggregate([
        { $unwind: '$daily_rewards' },
        { $match: { 'daily_rewards.status': 'claimable' } },
        { $count: 'total' }
      ]),
      deviceRewardsModel.aggregate([
        { $unwind: '$weekly_rewards' },
        { $match: { 'weekly_rewards.status': 'claimable' } },
        { $count: 'total' }
      ])
    ]);

    const todayRewards = todayCountRes[0]?.total || 0;
    const yesterdayRewards = yesterdayCountRes[0]?.total || 0;
    const weekRewards = weekCountRes[0]?.total || 0;
    const pendingRewards = (pendingDailyRes[0]?.total || 0) + (pendingWeeklyRes[0]?.total || 0);
    const claimableRewards = (claimableDailyRes[0]?.total || 0) + (claimableWeeklyRes[0]?.total || 0);

    // Daily accruals today (preview only)
    const dailyAccrualsTodayResult = await deviceRewardsModel.aggregate([
      { $unwind: '$daily_rewards' },
      { $match: { 'daily_rewards.created_at': { $gte: todayStart }, 'daily_rewards.status': 'accruing' } },
      { $count: 'total' }
    ]);
    const dailyAccrualsToday = dailyAccrualsTodayResult[0]?.total || 0;

    // Weekly totals across all devices
    const weeklyPendingSumRes = await deviceRewardsModel.aggregate([
      { $unwind: '$weekly_rewards' },
      { $match: { 'weekly_rewards.status': 'pending' } },
      { $group: { _id: null, total: { $sum: '$weekly_rewards.amount' } } }
    ]);
    const weeklyClaimableSumRes = await deviceRewardsModel.aggregate([
      { $unwind: '$weekly_rewards' },
      { $match: { 'weekly_rewards.status': 'claimable' } },
      { $group: { _id: null, total: { $sum: '$weekly_rewards.amount' } } }
    ]);
    const weeklyPendingSum = Math.round((weeklyPendingSumRes[0]?.total || 0) * 100) / 100;
    const weeklyClaimableSum = Math.round((weeklyClaimableSumRes[0]?.total || 0) * 100) / 100;

    // Last roll-up count (unlock_at == last Friday 00:05 UTC)
    const nowUtc = new Date();
    const d = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 0, 0, 0, 0));
    const day = d.getUTCDay();
    const diffToFriday = (day + 7 - 5) % 7;
    d.setUTCDate(d.getUTCDate() - diffToFriday); // this Friday 00:00
    const lastFridayStart = new Date(d.getTime());
    const unlockAt = new Date(lastFridayStart.getTime() + 5 * 60 * 1000);
    const lastRollupCountRes = await deviceRewardsModel.aggregate([
      { $unwind: '$weekly_rewards' },
      { $match: { 'weekly_rewards.unlock_at': unlockAt } },
      { $count: 'total' }
    ]);
    const lastRollupCount = lastRollupCountRes[0]?.total || 0;
    
    // Get hourly breakdown for today
    const hourlyBreakdown = await deviceRewardsModel.aggregate([
      { $unwind: '$daily_rewards' },
      { $match: { 'daily_rewards.created_at': { $gte: todayStart } } },
      {
        $group: {
          _id: { $hour: '$daily_rewards.created_at' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id': 1 } }
    ]);
    
    // Get top devices by rewards today
    const topDevices = await deviceRewardsModel.aggregate([
      { $unwind: '$daily_rewards' },
      { $match: { 'daily_rewards.created_at': { $gte: todayStart } } },
      {
        $group: {
          _id: '$miner_key',
          rewardCount: { $sum: 1 },
          totalAmount: { $sum: '$daily_rewards.amount' }
        }
      },
      { $sort: { rewardCount: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      overview: {
        totalDevices,
        todayRewards,
        yesterdayRewards,
        weekRewards,
        pendingRewards,
        claimableRewards,
        expectedHourlyDevices: Math.ceil(totalDevices / 24)
      },
      hourlyBreakdown,
      topDevices,
      deviceCentric: {
        dailyAccrualsToday,
        weeklyPendingSum,
        weeklyClaimableSum,
        lastRollupCount
      },
      environment: testMode ? 'TEST' : 'PRODUCTION'
    });
  } catch (error) {
    res.status(500).json({ error: 'Metrics fetch failed', message: String(error) });
  }
});

// Admin UI page: Weekly Epoch Simulator
app.get('/admin/weekly', adminAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Weekly Epoch Simulator</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans, "Apple Color Emoji", "Segoe UI Emoji"; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    .wrap { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.6rem; margin-bottom: 1rem; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    label { display:block; font-size: 0.9rem; margin-top: 0.75rem; }
    input, textarea { width: 100%; padding: 0.5rem; margin-top: 0.25rem; background: #0b1220; color: #e2e8f0; border: 1px solid #374151; border-radius: 6px; }
    button { margin-top: 0.75rem; padding: 0.5rem 1rem; border: 1px solid #ef4444; background: transparent; color: #e2e8f0; border-radius: 6px; cursor: pointer; }
    button:hover { background: #ef4444; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace; background: #0b1220; padding: 0.75rem; border-radius: 6px; margin-top: 0.5rem; border: 1px solid #374151; }
    .hint { color: #94a3b8; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Weekly Epoch Simulator</h1>
    <p class="hint">Use these tools to simulate daily accruals, the Friday roll-up, 30-day maturation, and claiming — all within minutes.</p>

    <div class="card">
      <h2>1) Seed Daily Accruals (Preview)</h2>
      <div class="row">
        <div>
          <label>Miner Keys (comma-separated)</label>
          <textarea id="seed-miners" rows="3" placeholder="MINER-ABC123, MINER-DEF456"></textarea>
        </div>
        <div>
          <label>Asset ID</label>
          <input id="seed-asset" placeholder="924268058" />
          <label>Amount per Day</label>
          <input id="seed-amount" type="number" step="0.01" placeholder="1.23" />
          <label>Friday Start UTC (optional)</label>
          <input id="seed-friday" placeholder="2025-01-03T00:00:00.000Z" />
        </div>
      </div>
      <button onclick="seed()">Seed 7 days</button>
      <div id="seed-log" class="log"></div>
    </div>

    <div class="card">
      <h2>2) Roll-Up Last Week → Weekly Pending</h2>
      <label>Reference UTC (optional)</label>
      <input id="roll-ref" placeholder="2025-01-10T00:06:00.000Z" />
      <button onclick="rollup()">Roll-Up Now</button>
      <div id="roll-log" class="log"></div>
    </div>

    <div class="card">
      <h2>3) Mature Pending → Claimable</h2>
      <label>Threshold Days</label>
      <input id="mature-days" type="number" placeholder="30" />
      <button onclick="mature()">Mature Now</button>
      <div id="mature-log" class="log"></div>
    </div>

    <div class="card">
      <h2>4) Force-Claim (Simulation)</h2>
      <label>Miner Key (optional; leave blank to claim all claimables)</label>
      <input id="claim-miner" placeholder="MINER-ABC123" />
      <button onclick="forceClaim()">Force-Claim</button>
      <div id="claim-log" class="log"></div>
    </div>
  </div>

  <script>
    async function post(url, body) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, json };
    }

    async function seed() {
      const miners = document.getElementById('seed-miners').value.split(',').map(s => s.trim()).filter(Boolean);
      const asset = document.getElementById('seed-asset').value.trim();
      const amount = parseFloat(document.getElementById('seed-amount').value);
      const friday = document.getElementById('seed-friday').value.trim();
      const { ok, json } = await post('/api/admin/weekly/seed', { miner_keys: miners, asset_id: asset, amount, friday_start_utc: friday || undefined });
      document.getElementById('seed-log').textContent = ok ? JSON.stringify(json, null, 2) : 'Failed: ' + JSON.stringify(json);
    }

    async function rollup() {
      const ref = document.getElementById('roll-ref').value.trim();
      const { ok, json } = await post('/api/admin/weekly/rollup', { ref_utc: ref || undefined });
      document.getElementById('roll-log').textContent = ok ? JSON.stringify(json, null, 2) : 'Failed: ' + JSON.stringify(json);
    }

    async function mature() {
      const days = parseInt(document.getElementById('mature-days').value || '30', 10);
      const { ok, json } = await post('/api/admin/weekly/mature', { thresholdDays: days });
      document.getElementById('mature-log').textContent = ok ? JSON.stringify(json, null, 2) : 'Failed: ' + JSON.stringify(json);
    }

    async function forceClaim() {
      const miner = document.getElementById('claim-miner').value.trim();
      const { ok, json } = await post('/api/admin/weekly/force-claim', miner ? { miner_key: miner } : {});
      document.getElementById('claim-log').textContent = ok ? JSON.stringify(json, null, 2) : 'Failed: ' + JSON.stringify(json);
    }
  </script>
</body>
</html>
  `);
});

app.get('/api/alerts/config', async (req, res) => {
  try {
    const config = alertingSystem.getConfig();
    res.json({
      enabled: config.enabled,
      hasWebhook: !!config.discordWebhook,
      thresholds: config.criticalThresholds
    });
  } catch (error) {
    res.status(500).json({ error: 'Alert config fetch failed', message: String(error) });
  }
});

app.post('/api/alerts/test', async (req, res) => {
  try {
    await alertingSystem.sendTestAlert();
    res.json({ success: true, message: 'Test alert sent' });
  } catch (error) {
    res.status(500).json({ error: 'Test alert failed', message: String(error) });
  }
});

// Main dashboard HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>dbRewards Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            color: #333;
        }
        
        .header {
            background: #2c3e50;
            color: white;
            padding: 1rem 2rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .header h1 {
            margin: 0;
            font-size: 1.5rem;
        }
        
        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: bold;
            margin-left: 1rem;
        }
        
        .status-healthy { background: #27ae60; color: white; }
        .status-warning { background: #f39c12; color: white; }
        .status-critical { background: #e74c3c; color: white; }
        .status-error { background: #8e44ad; color: white; }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        
        .card {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .card h3 {
            margin-bottom: 1rem;
            color: #2c3e50;
            border-bottom: 2px solid #ecf0f1;
            padding-bottom: 0.5rem;
        }
        
        .metric {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem 0;
            border-bottom: 1px solid #ecf0f1;
        }
        
        .metric:last-child {
            border-bottom: none;
        }
        
        .metric-value {
            font-weight: bold;
            color: #27ae60;
        }
        
        .metric-value.warning {
            color: #f39c12;
        }
        
        .metric-value.critical {
            color: #e74c3c;
        }
        
        .chart-container {
            position: relative;
            height: 300px;
            margin-top: 1rem;
        }
        
        .loading {
            text-align: center;
            padding: 2rem;
            color: #666;
        }
        
        .error {
            background: #e74c3c;
            color: white;
            padding: 1rem;
            border-radius: 4px;
            margin: 1rem 0;
        }
        
        .btn {
            background: #3498db;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
        }
        
        .btn:hover {
            background: #2980b9;
        }
        
        .btn:disabled {
            background: #bdc3c7;
            cursor: not-allowed;
        }
        
        .refresh-info {
            text-align: center;
            color: #666;
            font-size: 0.9rem;
            margin-top: 1rem;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>dbRewards System Dashboard</h1>
        <span id="statusBadge" class="status-badge">Loading...</span>
        <span id="frydayCountdown" style="margin-left: 1rem; font-size: 0.9rem;">Next FRYday: calculating…</span>
        <span id="lastUpdate" style="float: right; font-size: 0.9rem;">Last updated: Never</span>
    </div>
    
    <div class="container">
        <div id="errorContainer"></div>
        
        <div class="grid">
            <div class="card">
                <h3>System Overview</h3>
                <div id="systemOverview" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3>Today's Performance</h3>
                <div id="todayPerformance" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3>Database Performance</h3>
                <div id="dbPerformance" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3>Alert Configuration</h3>
                <div id="alertConfig" class="loading">Loading...</div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>Hourly Rewards Today</h3>
                <div class="chart-container">
                    <canvas id="hourlyChart"></canvas>
                </div>
            </div>
            
            <div class="card">
                <h3>System Health Issues</h3>
                <div id="healthIssues" class="loading">Loading...</div>
            </div>
            
            <div class="card">
                <h3>Weekly Roll-Ups</h3>
                <div id="weeklyRollups" class="loading">Loading...</div>
            </div>
        </div>
        
        <div class="refresh-info">
            <button class="btn" onclick="refreshData()">Refresh Now</button>
            <p>Dashboard automatically refreshes every 30 seconds</p>
        </div>
    </div>

    <script>
        let hourlyChart = null;
        
        async function fetchData(endpoint) {
            const response = await fetch(endpoint);
            if (!response.ok) {
                throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            return response.json();
        }
        
        function showError(message) {
            const errorContainer = document.getElementById('errorContainer');
            errorContainer.innerHTML = \`<div class="error">Error: \${message}</div>\`;
        }
        
        function clearError() {
            document.getElementById('errorContainer').innerHTML = '';
        }
        
        function formatNumber(num) {
            return num.toLocaleString();
        }
        
        function updateSystemOverview(health, metrics) {
            const container = document.getElementById('systemOverview');
            container.innerHTML = \`
                <div class="metric">
                    <span>Environment</span>
                    <span class="metric-value">\${metrics.environment}</span>
                </div>
                <div class="metric">
                    <span>Total Devices</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.totalDevices)}</span>
                </div>
                <div class="metric">
                    <span>Today's Rewards</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.todayRewards)}</span>
                </div>
                <div class="metric">
                    <span>Pending Rewards</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.pendingRewards)}</span>
                </div>
                <div class="metric">
                    <span>Claimable Rewards</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.claimableRewards)}</span>
                </div>
                <div class="metric">
                    <span>Current Hour</span>
                    <span class="metric-value">\${health.current_hour}:00</span>
                </div>
            \`;
        }
        
        function updateTodayPerformance(health, metrics) {
            const container = document.getElementById('todayPerformance');
            const expectedRewards = metrics.overview.expectedHourlyDevices * (health.current_hour + 1);
            const completionRate = (metrics.overview.todayRewards / expectedRewards * 100).toFixed(1);
            
            container.innerHTML = \`
                <div class="metric">
                    <span>Hours Processed</span>
                    <span class="metric-value">\${health.hours_processed_today}/\${health.current_hour}</span>
                </div>
                <div class="metric">
                    <span>Expected Rewards</span>
                    <span class="metric-value">\${formatNumber(expectedRewards)}</span>
                </div>
                <div class="metric">
                    <span>Completion Rate</span>
                    <span class="metric-value \${completionRate < 80 ? 'critical' : completionRate < 95 ? 'warning' : ''}">\${completionRate}%</span>
                </div>
                <div class="metric">
                    <span>Yesterday's Rewards</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.yesterdayRewards)}</span>
                </div>
                <div class="metric">
                    <span>This Week's Rewards</span>
                    <span class="metric-value">\${formatNumber(metrics.overview.weekRewards)}</span>
                </div>
            \`;
        }
        
        function updateDbPerformance(performance) {
            const container = document.getElementById('dbPerformance');
            const errorRate = performance.stats.totalQueries > 0 ? (performance.stats.errorCount / performance.stats.totalQueries * 100).toFixed(1) : '0.0';
            const slowQueryRate = performance.stats.totalQueries > 0 ? (performance.stats.slowQueries / performance.stats.totalQueries * 100).toFixed(1) : '0.0';
            
            container.innerHTML = \`
                <div class="metric">
                    <span>Total Queries</span>
                    <span class="metric-value">\${formatNumber(performance.stats.totalQueries)}</span>
                </div>
                <div class="metric">
                    <span>Average Duration</span>
                    <span class="metric-value">\${performance.stats.averageDuration.toFixed(1)}ms</span>
                </div>
                <div class="metric">
                    <span>Slow Queries</span>
                    <span class="metric-value \${slowQueryRate > 10 ? 'critical' : slowQueryRate > 5 ? 'warning' : ''}">\${performance.stats.slowQueries} (\${slowQueryRate}%)</span>
                </div>
                <div class="metric">
                    <span>Error Rate</span>
                    <span class="metric-value \${errorRate > 5 ? 'critical' : errorRate > 2 ? 'warning' : ''}">\${errorRate}%</span>
                </div>
                <div class="metric">
                    <span>Performance Status</span>
                    <span class="metric-value \${performance.isPerformanceConcerning ? 'critical' : ''}">\${performance.isPerformanceConcerning ? 'Concerning' : 'Good'}</span>
                </div>
            \`;
        }
        
        function updateWeeklyRollups(metrics) {
            const container = document.getElementById('weeklyRollups');
            const dc = metrics.deviceCentric || { dailyAccrualsToday: 0, weeklyPendingSum: 0, weeklyClaimableSum: 0, lastRollupCount: 0 };
            container.innerHTML = \`
                <div class=\"metric\">
                    <span>Accruals Today (daily)</span>
                    <span class=\"metric-value\">\${formatNumber(dc.dailyAccrualsToday)}</span>
                </div>
                <div class=\"metric\">
                    <span>Weekly Pending Total</span>
                    <span class=\"metric-value\">\${formatNumber(dc.weeklyPendingSum)}</span>
                </div>
                <div class=\"metric\">
                    <span>Weekly Claimable Total</span>
                    <span class=\"metric-value\">\${formatNumber(dc.weeklyClaimableSum)}</span>
                </div>
                <div class=\"metric\">
                    <span>Last Roll-Up Entries</span>
                    <span class=\"metric-value\">\${formatNumber(dc.lastRollupCount)}</span>
                </div>
            \`;
        }
        
        function updateAlertConfig(alertConfig) {
            const container = document.getElementById('alertConfig');
            container.innerHTML = \`
                <div class="metric">
                    <span>Alerts Enabled</span>
                    <span class="metric-value \${alertConfig.enabled ? '' : 'critical'}">\${alertConfig.enabled ? 'Yes' : 'No'}</span>
                </div>
                <div class="metric">
                    <span>Discord Webhook</span>
                    <span class="metric-value \${alertConfig.hasWebhook ? '' : 'warning'}">\${alertConfig.hasWebhook ? 'Configured' : 'Not Set'}</span>
                </div>
                <div class="metric">
                    <span>Max Error Rate</span>
                    <span class="metric-value">\${alertConfig.thresholds.maxErrorRate}%</span>
                </div>
                <div class="metric">
                    <span>Max Slow Query Rate</span>
                    <span class="metric-value">\${alertConfig.thresholds.maxSlowQueryRate}%</span>
                </div>
                <div style="margin-top: 1rem;">
                    <button class="btn" onclick="sendTestAlert()" id="testAlertBtn">Send Test Alert</button>
                </div>
            \`;
        }
        
        function updateHealthIssues(health) {
            const container = document.getElementById('healthIssues');
            if (health.issues.length === 0) {
                container.innerHTML = '<div class="metric"><span style="color: #27ae60;">✅ No issues detected</span></div>';
            } else {
                container.innerHTML = health.issues.map((issue, index) => 
                    \`<div class="metric"><span>\${index + 1}. \${issue}</span></div>\`
                ).join('');
            }
        }
        
        function updateHourlyChart(hourlyData) {
            const ctx = document.getElementById('hourlyChart').getContext('2d');
            
            // Create 24-hour array with zeros
            const data = new Array(24).fill(0);
            hourlyData.forEach(item => {
                data[item._id] = item.count;
            });
            
            if (hourlyChart) {
                hourlyChart.destroy();
            }
            
            hourlyChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Array.from({length: 24}, (_, i) => \`\${i}:00\`),
                    datasets: [{
                        label: 'Rewards Generated',
                        data: data,
                        backgroundColor: '#3498db',
                        borderColor: '#2980b9',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        }
                    }
                }
            });
        }
        
        function updateStatusBadge(health) {
            const badge = document.getElementById('statusBadge');
            badge.textContent = health.system_status;
            badge.className = \`status-badge status-\${health.system_status.toLowerCase()}\`;
        }
        
        async function sendTestAlert() {
            const btn = document.getElementById('testAlertBtn');
            btn.disabled = true;
            btn.textContent = 'Sending...';
            
            try {
                const response = await fetch('/api/alerts/test', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    btn.textContent = 'Sent!';
                    setTimeout(() => {
                        btn.textContent = 'Send Test Alert';
                        btn.disabled = false;
                    }, 2000);
                } else {
                    throw new Error(result.message || 'Unknown error');
                }
            } catch (error) {
                btn.textContent = 'Failed';
                showError(\`Test alert failed: \${error.message}\`);
                setTimeout(() => {
                    btn.textContent = 'Send Test Alert';
                    btn.disabled = false;
                }, 2000);
            }
        }
        
        async function refreshData() {
            try {
                clearError();
                
                const [health, metrics, performance, alertConfig] = await Promise.all([
                    fetchData('/api/health'),
                    fetchData('/api/metrics'),
                    fetchData('/api/performance'),
                    fetchData('/api/alerts/config')
                ]);
                
                updateStatusBadge(health);
                updateSystemOverview(health, metrics);
                updateTodayPerformance(health, metrics);
                updateDbPerformance(performance);
                updateAlertConfig(alertConfig);
                updateHealthIssues(health);
                updateHourlyChart(metrics.hourlyBreakdown);
                updateWeeklyRollups(metrics);
                
                document.getElementById('lastUpdate').textContent = \`Last updated: \${new Date().toLocaleTimeString()}\`;
                
            } catch (error) {
                showError(error.message);
            }
        }
        
        // Initial load and auto-refresh
        refreshData();
        setInterval(refreshData, 30000); // Refresh every 30 seconds

        // -------- FRYday Countdown (UTC Friday 00:05) --------
        function getNextFridayUnlockUTC(now) {
            const n = new Date(now.getTime());
            const day = n.getUTCDay(); // 0=Sun..5=Fri
            // Move to this week's Friday 00:05
            const thisFriday = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 0, 0, 0));
            const diffToFriday = (day + 7 - 5) % 7; // days since last Friday
            thisFriday.setUTCDate(thisFriday.getUTCDate() - diffToFriday);
            const thisUnlock = new Date(thisFriday.getTime() + 5 * 60 * 1000); // 00:05 UTC

            // If already past this unlock, move to next Friday
            if (now.getTime() >= thisUnlock.getTime()) {
                const nextFriday = new Date(thisFriday.getTime() + 7 * 24 * 60 * 60 * 1000);
                return new Date(nextFriday.getTime() + 5 * 60 * 1000);
            }
            return thisUnlock;
        }

        function updateFrydayCountdown() {
            const el = document.getElementById('frydayCountdown');
            if (!el) return;
            const now = new Date();
            const target = getNextFridayUnlockUTC(now);
            const diff = Math.max(0, target.getTime() - now.getTime());
            const days = Math.floor(diff / (24 * 60 * 60 * 1000));
            const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            const mins = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
            const secs = Math.floor((diff % (60 * 1000)) / 1000);
            el.textContent = 'Next FRYday (UTC 00:05): ' + target.toUTCString() + ' • ' + days + 'd ' + hours + 'h ' + mins + 'm ' + secs + 's';
        }

        updateFrydayCountdown();
        setInterval(updateFrydayCountdown, 1000);
    </script>
</body>
</html>
  `);
});

export function startWebDashboard(): void {
  app.listen(PORT, () => {
    console.log(`📊 Web dashboard running on http://localhost`);
    console.log(`   Environment: ${testMode ? 'TEST' : 'PRODUCTION'}`);
  });
}

// Export for external use
export { app };

// Auto-start when invoked directly via `node dist/web-dashboard.js`
if (require.main === module) {
  startWebDashboard();
}
