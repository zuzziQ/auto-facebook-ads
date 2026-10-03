const express = require('express');
const router = express.Router();
const { stmts } = require('../db/database');
const { generateContent } = require('../services/aiGenerator');

// 1. Knowledge Base CRUD
router.get('/kb', (req, res) => {
  try {
    const rows = stmts.getKbEntries.all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/kb', (req, res) => {
  try {
    const { category, title, content_text } = req.body;
    stmts.insertKbEntry.run({ category, title, content_text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/kb/:id', (req, res) => {
  try {
    const { category, title, content_text } = req.body;
    stmts.updateKbEntry.run({ id: req.params.id, category, title, content_text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/kb/:id', (req, res) => {
  try {
    stmts.deleteKbEntry.run({ id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2. Global KB Settings for Content Hub (Single Shared UI)
router.get('/kb-settings', (req, res) => {
  try {
    const clinic = stmts.getSetting.get('kb_clinic')?.value || '';
    const doctor = stmts.getSetting.get('kb_doctor')?.value || '';
    const service = stmts.getSetting.get('kb_service')?.value || '';
    const tech = stmts.getSetting.get('kb_tech')?.value || '';
    const rules = stmts.getSetting.get('kb_rules')?.value || '';
    const design = stmts.getSetting.get('kb_design')?.value || '';
    const video = stmts.getSetting.get('kb_video')?.value || '';
    const tpl = stmts.getSetting.get('kb_tpl')?.value || '';
    res.json({ success: true, kb_clinic: clinic, kb_doctor: doctor, kb_service: service, kb_tech: tech, kb_rules: rules, kb_design: design, kb_video: video, kb_tpl: tpl });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/kb-settings', (req, res) => {
  try {
    const { kb_clinic, kb_doctor, kb_service, kb_tech, kb_rules, kb_design, kb_video, kb_tpl } = req.body;
    if (kb_clinic !== undefined) stmts.setSetting.run({ key: 'kb_clinic', value: kb_clinic });
    if (kb_doctor !== undefined) stmts.setSetting.run({ key: 'kb_doctor', value: kb_doctor });
    if (kb_service !== undefined) stmts.setSetting.run({ key: 'kb_service', value: kb_service });
    if (kb_tech !== undefined) stmts.setSetting.run({ key: 'kb_tech', value: kb_tech });
    if (kb_rules !== undefined) stmts.setSetting.run({ key: 'kb_rules', value: kb_rules });
    if (kb_design !== undefined) stmts.setSetting.run({ key: 'kb_design', value: kb_design });
    if (kb_video !== undefined) stmts.setSetting.run({ key: 'kb_video', value: kb_video });
    if (kb_tpl !== undefined) stmts.setSetting.run({ key: 'kb_tpl', value: kb_tpl });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. Post Templates CRUD
router.get('/templates', (req, res) => {
  try {
    const rows = stmts.getPostTemplates.all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/templates', (req, res) => {
  try {
    const { template_name, structure_prompt } = req.body;
    stmts.insertPostTemplate.run({ template_name, structure_prompt });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/templates/:id', (req, res) => {
  try {
    const { template_name, structure_prompt } = req.body;
    stmts.updatePostTemplate.run({ id: req.params.id, template_name, structure_prompt });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/templates/:id', (req, res) => {
  try {
    stmts.deletePostTemplate.run({ id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. Generate Content
router.post('/generate-direct', async (req, res) => {
  try {
    const { kb_clinic, kb_doctor, kb_service, kb_tech, kb_rules, kb_design, kb_video, template_structure, topic, format_type, video_duration } = req.body;
    
    // We will now pass these explicitly to the multi-agent generator
    const result = await generateContent(kb_clinic, kb_doctor, kb_service, kb_tech, kb_rules, kb_design, kb_video, template_structure, topic, format_type, video_duration);
    
    res.json({ success: true, fb_post: result.fb_post, design_brief: result.design_brief, video_brief: result.video_brief });
  } catch (e) {
    console.error("Generate error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
