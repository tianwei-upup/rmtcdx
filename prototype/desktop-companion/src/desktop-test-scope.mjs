// Fixed local acceptance targets. Lifecycle permits history inspection only.
const scopes=new Map([
 ['01a13feb-ce80-7ca3-aa1e-17814542b353',{conversationId:'01a13feb-ce80-7ca3-aa1e-17814542b353',cwd:'/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015',title:'rmtcdx companion acceptance',allowApprovals:true}],
 ['01a13fef-a018-7303-a2a6-f5903548537f',{conversationId:'01a13fef-a018-7303-a2a6-f5903548537f',cwd:'/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-lifecycle-20261015',title:'rmtcdx companion lifecycle',allowApprovals:false}]
]);
export function desktopTestScope(config){
 const scope=scopes.get(config?.conversationId);
 if(config?.localOnly!==true||!scope||config.expectedCwd!==scope.cwd)throw Error('dedicated_desktop_sync_only');
 if(config.approvals===true&&!scope.allowApprovals)throw Error('dedicated_desktop_sync_read_only');
 return {...scope};
}
