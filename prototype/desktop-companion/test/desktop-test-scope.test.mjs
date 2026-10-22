import test from 'node:test';import assert from 'node:assert/strict';
import {desktopTestScope} from '../src/desktop-test-scope.mjs';
const acceptance={localOnly:true,conversationId:'01a13feb-ce80-7ca3-aa1e-17814542b353',expectedCwd:'/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015',approvals:true};
const lifecycle={localOnly:true,conversationId:'01a13fef-a018-7303-a2a6-f5903548537f',expectedCwd:'/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-lifecycle-20261015',approvals:false};
test('local desktop acceptance binds exact IDs and cwd; lifecycle cannot respond to approvals',()=>{
 assert.equal(desktopTestScope(acceptance).allowApprovals,true);
 assert.equal(desktopTestScope(lifecycle).allowApprovals,false);
 assert.throws(()=>desktopTestScope({...lifecycle,approvals:true}),/dedicated_desktop_sync_read_only/);
 for(const config of [undefined,{...acceptance,localOnly:false},{...acceptance,conversationId:'another-chat'},{...acceptance,expectedCwd:lifecycle.expectedCwd},{...lifecycle,conversationId:acceptance.conversationId}])assert.throws(()=>desktopTestScope(config),/dedicated_desktop_sync_only/);
});
