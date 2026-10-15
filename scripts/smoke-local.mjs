import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3210';
async function api(route, body, method = 'POST') {
  const response = await fetch(base + route, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${route}: ${payload.message ?? response.status}`);
  return payload;
}
const health = await api('/healthz');
assert.equal(health.codex.mode, 'real');
assert.equal(health.codex.ready, true);
const socket = new WebSocket('ws://127.0.0.1:3210/ws');
const events = [];
const hello = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket hello timeout')), 10000);
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(String(data));
    events.push(event);
    if (event.type === 'hello') { clearTimeout(timer); resolve(event); }
  });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); });
});
try {
  assert.equal((await hello).mode, 'real');
  if (!process.argv.includes('--run')) {
    console.log('PASS: real backend and WebSocket handshake');
  } else {
    let sessionId;
    for (const prompt of [
      '仅回复 LOCAL_BRIDGE_OK。不要使用工具、不读写文件、不运行命令。',
      '这是继续同一会话的连接测试。仅回复 LOCAL_RESUME_OK。不要使用工具、不读写文件、不运行命令。'
    ]) {
      const { run } = await api('/api/runs', {
        ...(sessionId ? { sessionId } : { repoId: 'remoteControlGPT' }), prompt,
        codex: { approvalPolicy: 'on-request', sandbox: 'read-only' }
      });
      sessionId = run.sessionId;
      const deadline = Date.now() + 120000;
      let latest;
      do {
        await new Promise(resolve => setTimeout(resolve, 1000));
        latest = (await api('/api/runs/' + run.id)).run;
      } while (['running', 'queued'].includes(latest.status) && Date.now() < deadline);
      assert.equal(latest.status, 'completed', JSON.stringify(latest));
    }
    const { messages } = await api(`/api/sessions/${sessionId}/messages`);
    const answers = messages.filter(message => message.role === 'assistant').map(message => message.text);
    assert.ok(answers.some(text => text.includes('LOCAL_BRIDGE_OK')));
    assert.ok(answers.some(text => text.includes('LOCAL_RESUME_OK')));
    assert.ok(events.some(event => event.type === 'run.completed' && event.run.sessionId === sessionId));
    assert.ok(events.some(event => event.type === 'message.delta' && event.sessionId === sessionId));
    await api(`/api/sessions/${sessionId}`, { title: '本机连接验证（可删除）' }, 'PATCH');
    console.log(JSON.stringify({ result: 'PASS', sessionId, turns: 2,
      streamingEvents: events.filter(event => event.type === 'message.delta' && event.sessionId === sessionId).length,
      answers }, null, 2));
  }
} finally { socket.close(); }
