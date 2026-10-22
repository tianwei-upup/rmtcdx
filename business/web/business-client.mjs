const DEFINITIVE = new Set(['device_offline', 'invalid_fields', 'invalid_id', 'invalid_string', 'invalid_turn', 'invalid_image', 'image_type_mismatch']);
export class BusinessClient {
  constructor({ fetcher = (...args) => fetch(...args), storage = sessionStorage, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) { this.fetcher = fetcher; this.storage = storage; this.sleep = sleep; }
  async api(route, body) {
    let response;
    try { response = await this.fetcher(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) }); }
    catch { throw Object.assign(new Error('network_unavailable'), { code: 'network_unavailable', uncertain: body !== undefined }); }
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.code || 'request_failed'), { code: value.code, status: response.status });
    return value;
  }
  key(route, scope = '') { return 'rmt-intent-v3:' + route + ':' + scope; }
  pending(route, scope = '') { try { return JSON.parse(this.storage.getItem(this.key(route, scope))); } catch { return null; } }
  clear(route, scope = '', expectedId) { if(!expectedId||this.pending(route,scope)?.id===expectedId)this.storage.removeItem(this.key(route, scope)); }
  async job(route, body, { writing = false, scope = '', onAccepted = () => {}, onIntent=()=>{}, confirmation } = {}) {
    const signature = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))).map(v => v.toString(16).padStart(2, '0')).join('');
    const key = this.key(route, scope), previous = writing ? this.pending(route, scope) : null;
    const intent = previous ?? { id: crypto.randomUUID(), signature };
    if (intent.signature !== signature) throw Object.assign(new Error('intent_conflict'), { code: 'intent_conflict', uncertain: true, intentKey: key });
    if (writing) this.storage.setItem(key, JSON.stringify(intent));
    onIntent(intent.id);
    const confirmed=confirmation?.(intent.id);let finished=false;
    const deliver=async()=>{
    let accepted;
    try { accepted = await this.api(route, { ...body, clientIntentId: intent.id }); }
    catch (error) { if (DEFINITIVE.has(error.code)) this.clear(route,scope,intent.id); else if (writing) error.uncertain = true; error.intentKey = key; throw error; }
    if(finished)return;
    if (writing) { intent.jobId = accepted.id; this.storage.setItem(key, JSON.stringify(intent)); }
    onAccepted(accepted.id);
    for (let i = 0; i < 120; i++) {
      if(finished)return;
      let current;
      try { current = await this.api('/api/jobs/' + accepted.id); }
      catch (error) { if (writing) { error.uncertain = true; error.intentKey = key; } throw error; }
      if (current.state === 'succeeded') {
        if (writing) this.clear(route,scope,intent.id);
        if (!current.resultAvailable) throw Object.assign(new Error('result_expired'), { code: 'result_expired' });
        return current.result;
      }
      if (['rejected', 'expired'].includes(current.state)) { if (writing) this.clear(route,scope,intent.id); throw Object.assign(new Error(current.code || current.state), { code: current.code || current.state }); }
      if (current.state === 'unknown') throw Object.assign(new Error('execution_unknown'), { code: 'execution_unknown', uncertain: true, intentKey: key, jobId: accepted.id });
      await this.sleep(450);
    }
    throw Object.assign(new Error('task_still_running'), { code: 'task_still_running', uncertain: writing, intentKey: key, jobId: accepted.id });
    };
    try{const value=await (confirmed?Promise.race([deliver(),confirmed.promise]):deliver());if(writing)this.clear(route,scope,intent.id);return value;}finally{finished=true;confirmed?.close();}
  }
}
