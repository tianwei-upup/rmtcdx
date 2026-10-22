import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { NativeHistoryQueue, HISTORY_QUEUE_TEST_ID as id, RN_HISTORY_PROJECT, RN_HISTORY_IDS } from '../src/native-history-queue.mjs';
import {PersonalScope} from '../src/personal-scope.mjs';
import { writePrivate } from '../src/state.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('./fixtures/native-queue-schema.json', import.meta.url)));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-queue-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'queue_1.sqlite'), runtime = path.join(root, 'receipts');
  const db = new DatabaseSync(database); db.exec('PRAGMA journal_mode=WAL');
  for (const row of schema.objects) if (row.sql) db.exec(row.sql);
  for (const row of schema.migrations) db.prepare('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)').run(row.version, row.description, Buffer.from(row.checksum, 'hex'));
  const config = { database, runtime, conversationId: id, enabled: true };
  const queue = new NativeHistoryQueue(config); t.after(() => db.close());
  return { root, db, queue, config };
}
test('native append preserves another chat and is idempotent after native consumption', t => {
  const { db, queue, config } = fixture(t), intentId = crypto.randomUUID();
  db.prepare('INSERT INTO queued_items VALUES(?,?,?,?,?,?)').run('desktop-existing', 'other-chat', 'unrelated', 0, 1, 1);
  assert.equal(queue.enqueue({ intentId, text: 'hello' }).state, 'queued');
  assert.equal(queue.enqueue({ intentId, text: 'hello' }).state, 'queued');
  assert.throws(() => queue.enqueue({ intentId, text: 'different' }), /native_intent_conflict/);
  db.prepare('DELETE FROM queued_items WHERE id=?').run(intentId);
  assert.equal(new NativeHistoryQueue(config).enqueue({ intentId, text: 'hello' }).state, 'accepted');
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_items').get().n, 1);
  assert.equal(db.prepare('SELECT payload_json FROM queued_items').get().payload_json, 'unrelated');
});
test('RN grant stays bound to exact project membership and current native archive metadata', t => {
  const { root, db, config } = fixture(t), conversationId = [...RN_HISTORY_IDS][0], other = [...RN_HISTORY_IDS][1];
  const desktopStateFile = path.join(root, 'desktop.json'), metadataDatabase = path.join(root, 'state_5.sqlite');
  const state = { 'local-projects': { [RN_HISTORY_PROJECT]: { name: '壳工程RN UI相关', rootPaths: [root] }, other: { name: 'shared cwd', rootPaths: [root] } }, 'thread-project-assignments': { [conversationId]: { projectKind: 'local', projectId: RN_HISTORY_PROJECT }, [other]: { projectKind: 'local', projectId: 'other' } } };
  const save = () => fs.writeFileSync(desktopStateFile, JSON.stringify(state)); save();
  const metadata = new DatabaseSync(metadataDatabase); t.after(() => metadata.close());
  metadata.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,archived INTEGER)');
  metadata.prepare('INSERT INTO threads VALUES(?,?,0)').run(conversationId, root);
  const grant = { mode: 'project-readonly', projectId: RN_HISTORY_PROJECT, projectName: '壳工程RN UI相关', conversations: [{ id: conversationId, archived: false }, { id: other, archived: false }] };
  const rn = { ...config, runtime: path.join(root, 'rn-receipts'), conversationId, grant, desktopStateFile, metadataDatabase };
  const queue = new NativeHistoryQueue(rn); queue.enqueue({ intentId: crypto.randomUUID(), text: 'read-only context test' });
  assert.throws(() => new NativeHistoryQueue({ ...rn, conversationId: other }).enqueue({ intentId: crypto.randomUUID(), text: 'same cwd is not membership' }), /native_history_scope_rejected/);
  state['thread-project-assignments'][conversationId].projectId = 'other'; save();
  assert.throws(() => queue.enqueue({ intentId: crypto.randomUUID(), text: 'must reject member removal' }), /native_history_scope_rejected/);
  state['thread-project-assignments'][conversationId].projectId = RN_HISTORY_PROJECT; save();
  metadata.prepare('UPDATE threads SET archived=1 WHERE id=?').run(conversationId);
  assert.throws(() => queue.enqueue({ intentId: crypto.randomUUID(), text: 'must reject archive' }), /native_history_scope_rejected/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_items').get().n, 1);
});
test('a lost admission receipt is reconciled without re-enqueueing an absent item', t => {
  const { db, queue, config } = fixture(t), intentId = crypto.randomUUID(), text = 'possible previous execution';
  const payload = JSON.stringify({ UserInput: { content: [{ type: 'text', text, text_elements: [] }], client_id: intentId } });
  writePrivate(path.join(config.runtime, intentId + '.json'), { intentId, conversationId: id, digest: crypto.createHash('sha256').update(payload).digest('hex'), state: 'prepared' });
  assert.equal(queue.enqueue({ intentId, text }).state, 'unknown');
  assert.equal(queue.inspect(intentId).state, 'unknown');
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_items').get().n, 0);
});
test('schema drift rejects before preparing a receipt or mutating native rows', t => {
  const { db, queue, config } = fixture(t);
  db.exec('ALTER TABLE queued_items ADD COLUMN future_field TEXT');
  assert.throws(() => queue.enqueue({ intentId: crypto.randomUUID(), text: 'do not deliver' }), /native_queue_schema_changed/);
  assert.equal(fs.readdirSync(config.runtime).filter(f => f.endsWith('.json')).length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_items').get().n, 0);
});
test('unapproved real chats and links cannot open the native writer', t => {
  const { config } = fixture(t);
  assert.throws(() => new NativeHistoryQueue({ ...config, conversationId: crypto.randomUUID() }), /native_history_acceptance_only/);
  assert.throws(() => new NativeHistoryQueue({ ...config, enabled: false }), /native_history_acceptance_only/);
  const link = path.join(path.dirname(config.database), 'linked', 'queue_1.sqlite');
  fs.mkdirSync(path.dirname(link)); fs.symlinkSync(config.database, link);
  assert.throws(() => new NativeHistoryQueue({ ...config, database: link }), /unsafe_native_queue_file/);
});
test('two independent phone writers and native desktop SQL append without lost messages', async t => {
  const { db, config } = fixture(t), moduleUrl = new URL('../src/native-history-queue.mjs', import.meta.url).href;
  const child = index => new Promise((resolve, reject) => {
    const source = `import {NativeHistoryQueue} from ${JSON.stringify(moduleUrl)};import crypto from 'node:crypto';const queue=new NativeHistoryQueue(${JSON.stringify(config)});for(let i=0;i<20;i++){const data={intentId:crypto.randomUUID(),text:'writer-${index}-'+i};for(let n=0;;n++){try{queue.enqueue(data);break;}catch(e){if(e.code!=='native_queue_admission_busy'||n>500)throw e;await new Promise(r=>setTimeout(r,5));}}}`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    proc.stderr.on('data', data => { stderr += data; }); proc.once('error', reject); proc.once('exit', code => code ? reject(Error(stderr)) : resolve());
  });
  const first = child(1), second = child(2);
  db.exec('PRAGMA busy_timeout=5000');
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO queued_items SELECT ?,?,?,COALESCE((SELECT MAX(queue_order) FROM queued_items WHERE thread_id=?),-1)+1,1,1').run(crypto.randomUUID(), id, 'desktop-' + i, id);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await Promise.all([first, second]);
  const rows = db.prepare('SELECT id,queue_order,payload_json FROM queued_items ORDER BY queue_order').all();
  assert.equal(rows.length, 60); assert.equal(new Set(rows.map(r => r.id)).size, 60);
  assert.deepEqual(rows.map(r => r.queue_order), Array.from({ length: 60 }, (_, i) => i));
  assert.equal(rows.filter(r => r.payload_json.startsWith('desktop-')).length, 20);
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_thread_revisions WHERE thread_id=?').get(id).n, 1);
});

test('personal admission checks live archive and exact named project before every atomic insert',t=>{
 const {root,db,config}=fixture(t),chat=crypto.randomUUID(),desktopStateFile=path.join(root,'personal-desktop.json'),metadataDatabase=path.join(root,'state_5.sqlite'),metadata=new DatabaseSync(metadataDatabase);t.after(()=>metadata.close());metadata.exec('CREATE TABLE threads(id TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,title TEXT)');metadata.prepare('INSERT INTO threads VALUES(?,?,0,?,?)').run(chat,root,'/none','chat');
 const state={'local-projects':{p:{name:'P',rootPaths:[root]},q:{name:'same cwd',rootPaths:[root]}},'thread-project-assignments':{[chat]:{projectKind:'local',projectId:'p'}}};const save=()=>fs.writeFileSync(desktopStateFile,JSON.stringify(state));save();
 const personalScope=new PersonalScope({manifest:{version:1,enabled:true,runtime:path.join(root,'personal'),projects:[{id:'p'}],chats:[{id:chat,projectId:'p',cwd:root}]},desktopStateFile,metadataDatabase}),q=new NativeHistoryQueue({...config,conversationId:chat,personalScope});q.enqueue({intentId:crypto.randomUUID(),text:'one authorized append'});metadata.exec('UPDATE threads SET archived=1');assert.throws(()=>q.enqueue({intentId:crypto.randomUUID(),text:'no archive write'}),{code:'archived_conversation_readonly'});metadata.exec('UPDATE threads SET archived=0');state['thread-project-assignments'][chat].projectId='q';save();assert.throws(()=>q.enqueue({intentId:crypto.randomUUID(),text:'no same cwd expansion'}),{code:'personal_membership_changed'});assert.equal(db.prepare('SELECT count(*) n FROM queued_items').get().n,1);
});
