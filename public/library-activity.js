const number = value => (value || 0).toLocaleString();

export function libraryActivity(scan, analysis, unavailable = false) {
  if (unavailable) return { visible:true, busy:false, label:'Connection unavailable', title:'Library status unavailable', detail:'Reconnecting to Sift… Processing progress will update when the connection returns.' };
  if (scan?.running) return {
    visible:true, busy:!scan.cancelled, label:scan.cancelled?'Stopping indexing…':'Processing library…',
    title:scan.cancelled?'Stopping folder indexing…':scan.phase==='saving'?'Saving your library…':'Indexing your library…',
    detail:`${number(scan.count)} samples indexed${scan.skipped?` · ${number(scan.skipped)} unreadable items skipped`:''}. Tempo and key analysis follows indexing.`,
    current:scan.current, action:scan.cancelled?null:'cancel', actionLabel:'Cancel indexing'
  };
  if (analysis?.saveError) return { visible:true, busy:false, label:'Analysis needs attention', title:'Library processing paused', detail:'Analysis results could not be saved. Check disk space and write access, then retry.', action:'resume', actionLabel:'Retry save and resume' };
  if (analysis?.running || analysis?.pending) {
    const processed=analysis.processed, total=analysis.total, remaining=analysis.remaining;
    return {
      visible:true, busy:!analysis.paused, label:analysis.paused?'Analysis paused':'Processing library…',
      title:analysis.paused?'Library analysis paused':'Analyzing tempo and key…',
      detail:`${number(processed)} of ${number(total)} samples processed · ${number(remaining)} remaining${analysis.failed?` · ${number(analysis.failed)} failed`:''}. You can keep exploring.`,
      current:analysis.running?`${analysis.paused?'Finishing':'Analyzing'}: ${analysis.current}`:null,
      progress:{value:processed,max:total}, action:analysis.paused?'resume':'pause', actionLabel:analysis.paused?'Resume analysis':'Pause analysis'
    };
  }
  if (scan?.error) return { visible:true, busy:false, label:'Scan needs attention', title:'Folder indexing failed', detail:scan.error };
  return { visible:false, busy:false, label:'Library ready' };
}
