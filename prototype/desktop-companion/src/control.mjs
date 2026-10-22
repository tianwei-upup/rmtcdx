import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function control(runtime, input, timeoutMs = 30000, {signal} = {}) {
  const endpoint = path.join(path.resolve(runtime), 'control.sock');
  const stat = fs.lstatSync(endpoint);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('unsafe_control_socket');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint), id = randomUUID(); let buffer = '';
    socket.setEncoding('utf8');
    const finish = (error, result) => { clearTimeout(timer);signal?.removeEventListener('abort',abort); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Error('control_timeout')), timeoutMs);
    const abort=()=>finish(Object.assign(Error('inbox_wait_cancelled'),{code:'inbox_wait_cancelled'}));
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    socket.on('connect', () => socket.write(JSON.stringify({ ...input, id }) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('data', data => {
      buffer += data.toString('utf8'); if (buffer.length > 8 * 1024 * 1024) return finish(Error('control_result_too_large'));
      const end = buffer.indexOf('\n'); if (end < 0) return;
      const response = JSON.parse(buffer.slice(0, end)); if (response.id !== id) return;
      if (response.error) finish(Object.assign(Error(response.error.code), response.error)); else finish(null, response.result);
    });
    socket.on('close', () => finish(Error('control_closed')));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [runtime, inputFile] = process.argv.slice(2);
  try { console.log(JSON.stringify(await control(runtime, JSON.parse(fs.readFileSync(inputFile, 'utf8'))))); }
  catch (error) { console.error(JSON.stringify({ code: error.code ?? error.message })); process.exitCode = 1; }
}
