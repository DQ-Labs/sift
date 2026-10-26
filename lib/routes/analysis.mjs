import { readJson, sendJson, httpError } from '../http.mjs';

const maxReanalyzeIds = 50000;

// Reanalysis takes explicit sample IDs, or `source` for every sample in a
// source ('' for all sources, 'demo', or a folder root), as in /api/samples.
function reanalyzeIds(catalogue, input) {
  if (input.source !== undefined) {
    if (input.ids !== undefined) throw httpError('Choose sample IDs or a source to analyze, not both.');
    if (typeof input.source !== 'string') throw httpError('Choose a valid source.');
    return catalogue.sourceIds(input.source);
  }
  if (!Array.isArray(input.ids) || input.ids.length > maxReanalyzeIds) throw httpError('Choose sample IDs to analyze.');
  return input.ids;
}

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
      const ids = reanalyzeIds(catalogue, input);
      catalogue.setAnalysisPaused(false);
      await analysis.save();
      analysis.enqueue(catalogue.analysisStates(ids), { force: true });
      analysis.resume();
    } else {
      throw httpError('Unknown analysis action.');
    }
    return sendJson(res, analysis.status());
  });
}
