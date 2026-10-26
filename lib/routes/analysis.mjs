import { readJson, sendJson, httpError } from '../http.mjs';

const maxReanalyzeIds = 50000;

export function registerAnalysisRoutes(router, app) {
  const { catalogue, analysis } = app;

  router.get('/api/analysis', ({ res }) => sendJson(res, analysis.status()));

  router.post('/api/analysis', async ({ req, res }) => {
    const input = await readJson(req);
    if (input.action === 'pause') {
      catalogue.setAnalysisPaused(true);
      analysis.pause();
      await analysis.save();
    } else if (input.action === 'resume') {
      catalogue.setAnalysisPaused(false);
      await analysis.save();
      analysis.resume();
    } else if (input.action === 'reanalyze') {
      if (!Array.isArray(input.ids) || input.ids.length > maxReanalyzeIds) throw httpError('Choose sample IDs to analyze.');
      catalogue.setAnalysisPaused(false);
      await analysis.save();
      analysis.enqueue(catalogue.analysisStates(input.ids), { force: true });
      analysis.resume();
    } else {
      throw httpError('Unknown analysis action.');
    }
    return sendJson(res, analysis.status());
  });
}
