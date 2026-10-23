import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export async function serveLocal(runtime, service, shutdown, {log=()=>{}}={}) {
  const endpoint = path.join(runtime, 'control.sock'), sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';const controller=new AbortController();
    socket.on('error', () => {}); socket.on('close', () => {sockets.delete(socket);controller.abort();});
    socket.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 128 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        void (async () => {
          let request;const receivedAt=Date.now();
          try {
            request = JSON.parse(line);
            const dispatchedAt=Date.now();const result = request.operation === 'stop' ? { stopping: true } : await service.execute({...request,signal:controller.signal});
            if(!['status','inbox_queue_status','inbox_job'].includes(request.operation))log({event:'queue.control.completed',threadId:request.threadId,operation:request.operation,intentId:request.intentId,receivedAt,dispatchedAt,completedAt:Date.now()});
            if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + '\n');
            if (request.operation === 'stop') setTimeout(shutdown, 50);
          } catch (error) {
            if (!socket.destroyed) socket.write(JSON.stringify({ id: request?.id, error: { code: error.code ?? 'operation_failed' } }) + '\n');
          }
        })();
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  fs.chmodSync(endpoint, 0o600);
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
}
