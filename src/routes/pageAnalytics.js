const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { getPageSummary, syncPageInsights } = require('../services/facebookPageAnalytics');
const logger = require('../utils/logger');

/**
 * GET /api/pages/list
 * Returns list of fanpages filtered by workspaceId
 */
router.get('/list', (req, res) => {
  try {
    const rawWsId = req.query.workspaceId;
    const wsId = (rawWsId !== undefined && rawWsId !== '' && rawWsId !== 'all') ? Number(rawWsId) : null;

    let pages;
    if (wsId) {
      pages = db.prepare(`
        SELECT p.id, p.workspace_id, p.page_id, p.name, p.is_default,
               w.name as workspace_name,
               COALESCE((SELECT audience_quality_score FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 100) as quality_score,
               COALESCE((SELECT misalignment_pct FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 0) as misalignment_pct,
               COALESCE((SELECT fans_total FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 0) as fans_total,
               (SELECT MAX(date) FROM page_daily_insights WHERE page_id = p.page_id) as last_data_date
        FROM workspace_pages p
        JOIN workspaces w ON p.workspace_id = w.id
        WHERE p.workspace_id = ?
        ORDER BY p.is_default DESC, p.id ASC
      `).all(wsId);
    } else {
      pages = db.prepare(`
        SELECT p.id, p.workspace_id, p.page_id, p.name, p.is_default,
               w.name as workspace_name,
               COALESCE((SELECT audience_quality_score FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 100) as quality_score,
               COALESCE((SELECT misalignment_pct FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 0) as misalignment_pct,
               COALESCE((SELECT fans_total FROM page_daily_insights WHERE page_id = p.page_id ORDER BY date DESC LIMIT 1), 0) as fans_total,
               (SELECT MAX(date) FROM page_daily_insights WHERE page_id = p.page_id) as last_data_date
        FROM workspace_pages p
        JOIN workspaces w ON p.workspace_id = w.id
        ORDER BY p.workspace_id ASC, p.is_default DESC, p.id ASC
      `).all();
    }

    res.json({
      success: true,
      workspaceId: wsId,
      total: pages.length,
      pages
    });
  } catch (error) {
    logger.error('[Page Analytics Router] Error fetching page list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pages/:pageId/insights
 * Returns KPIs, Demographics, Top Cities, Audience Health & Timeline
 */
router.get('/:pageId/insights', (req, res) => {
  try {
    const { pageId } = req.params;
    const { workspaceId, since, until } = req.query;

    if (!pageId) {
      return res.status(400).json({ success: false, error: 'Thiếu pageId' });
    }

    const wsId = workspaceId ? Number(workspaceId) : 1;
    const data = getPageSummary(wsId, pageId, since, until);

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error(`[Page Analytics Router] Error fetching insights for ${req.params.pageId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pages/:pageId/sync
 * Trigger immediate synchronization from Meta / smart fallback
 */
router.post('/:pageId/sync', async (req, res) => {
  try {
    const { pageId } = req.params;
    const wsId = req.body.workspaceId ? Number(req.body.workspaceId) : 1;

    if (!pageId) {
      return res.status(400).json({ success: false, error: 'Thiếu pageId' });
    }

    logger.info(`[Page Analytics Router] Triggering sync for page ${pageId} (workspace ${wsId})`);
    const syncResult = await syncPageInsights(wsId, pageId);
    const updatedData = getPageSummary(wsId, pageId);

    res.json({
      success: true,
      message: 'Đồng bộ dữ liệu Fanpage thành công',
      syncResult,
      data: updatedData
    });
  } catch (error) {
    logger.error(`[Page Analytics Router] Error syncing page ${req.params.pageId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
