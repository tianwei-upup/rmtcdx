package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.webkit.WebView;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Physical gestures on the public ECS page; never submits a message or changes a desktop turn. */
@SuppressWarnings("deprecation")
public class SidebarGestureTest extends DesktopSyncTest {
    private void drag(String element,float fromX,float fromY,float toX,float toY) throws Exception {
        android.view.accessibility.AccessibilityNodeInfo active=getInstrumentation().getUiAutomation().getRootInActiveWindow();
        assertNotNull(active);assertEquals("Foreground changed; gesture refused","com.liutw.codexremote",String.valueOf(active.getPackageName()));
        JSONObject rect=new JSONObject(decode(js("(()=>{const r=("+element+").getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,width:innerWidth})})()")));
        int[] offset=new int[2];getInstrumentation().runOnMainSync(()->page.getLocationOnScreen(offset));
        float scale=page.getWidth()/(float)rect.getDouble("width"),x=offset[0]+(float)rect.getDouble("x")*scale,y=offset[1]+(float)rect.getDouble("y")*scale,w=(float)rect.getDouble("w")*scale,h=(float)rect.getDouble("h")*scale;
        long start=SystemClock.uptimeMillis();
        for(int step=0;step<=15;step++){
            float fraction=step/15f;
            MotionEvent event=MotionEvent.obtain(start,SystemClock.uptimeMillis(),step==0?MotionEvent.ACTION_DOWN:step==15?MotionEvent.ACTION_UP:MotionEvent.ACTION_MOVE,x+w*(fromX+(toX-fromX)*fraction),y+h*(fromY+(toY-fromY)*fraction),0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try{assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(event,true));}finally{event.recycle();}
            if(step<15)SystemClock.sleep(18);
        }
        android.os.Bundle timing=new android.os.Bundle();timing.putString("stream","\nGESTURE_DURATION_MS "+(SystemClock.uptimeMillis()-start)+"\n");getInstrumentation().sendStatus(0,timing);
    }
    private void closed()throws Exception{assertEquals("Gesture must not open sidebar","false",js("document.getElementById('drawer').open"));}
    private void tap(String expression)throws Exception {
        android.view.accessibility.AccessibilityNodeInfo active=getInstrumentation().getUiAutomation().getRootInActiveWindow();assertNotNull(active);assertEquals("Foreground changed; tap refused","com.liutw.codexremote",String.valueOf(active.getPackageName()));
        js("("+expression+").scrollIntoView({block:'nearest'});true");
        JSONObject point=new JSONObject(decode(js("(()=>{const r=("+expression+").getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth})})()")));
        int[] offset=new int[2];getInstrumentation().runOnMainSync(()->page.getLocationOnScreen(offset));float scale=page.getWidth()/(float)point.getDouble("width"),x=offset[0]+(float)point.getDouble("x")*scale,y=offset[1]+(float)point.getDouble("y")*scale;long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+80,MotionEvent.ACTION_UP,x,y,0);
        try{assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(down,true));assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(up,true));}finally{down.recycle();up.recycle();}
    }
    public void testCustomProjectPickerVisualAndSelection()throws Exception {
        final String project="54e5cb30-3486-42d8-9612-d0f2c23aea19",id="01a161a3-e9ff-7691-8cd7-3de4e49fcfbe";
        Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
        waitFor("custom project picker document","location.origin==='https://47.95.141.18'&&document.readyState==='complete'&&document.getElementById('workspace')?.hidden===false&&typeof document.getElementById('projectToggle')?.onclick==='function'",60000);
        openPanel();js("(()=>{const s=document.getElementById('projectSelect');s.value="+JSONObject.quote(project)+";s.dispatchEvent(new Event('change',{bubbles:true}));})() ;true");
        waitFor("dedicated chat listed","document.querySelector('.session-row[data-chat-id=\""+id+"\"]')!=null",10000);js("document.querySelector('.session-row[data-chat-id=\""+id+"\"]').click();true");
        waitFor("dedicated history only","localStorage.getItem('rmt-queue-selected:mac-personal')==="+JSONObject.quote(id)+"&&document.querySelector('.desktop-status')?.dataset.complete==='true'",90000);
        String draft=decode(js("document.getElementById('text').value")),theme=decode(js("document.documentElement.dataset.theme??''"));
        try {
            js("window.pickerWrites=[];window.pickerFetch=window.fetch;window.fetch=(...a)=>{if(a[1]?.method&&a[1].method!=='GET')window.pickerWrites.push(String(a[0]));return window.pickerFetch(...a)};document.getElementById('text').value='PROJECT_PICKER_UNSENT';document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));document.documentElement.dataset.theme='light';true");
            openPanel();tap("document.getElementById('projectToggle')");waitFor("in-drawer project list","!document.getElementById('projectPanel').hidden&&document.getElementById('projectToggle').getAttribute('aria-expanded')==='true'",5000);
            assertEquals("Native select is invisible","true",js("document.getElementById('projectSelect').hidden&&getComputedStyle(document.getElementById('projectSelect')).display==='none'"));
            assertEquals("All discovered projects available","true",js("document.querySelectorAll('.project-option').length===document.getElementById('projectSelect').options.length"));
            assertEquals("Current project marked","true",js("document.querySelector('.project-option[aria-current=true]')?.dataset.projectId==="+JSONObject.quote(project)));
            assertEquals("No horizontal page overflow","false",js("document.documentElement.scrollWidth>innerWidth||document.getElementById('drawer').scrollWidth>document.getElementById('drawer').clientWidth"));
            SystemClock.sleep(220);shot("project-picker-light.png");
            js("document.getElementById('projectSearch').value='__NO_SUCH_PROJECT_7319__';document.getElementById('projectSearch').dispatchEvent(new Event('input',{bubbles:true}));true");waitFor("empty search feedback","!document.getElementById('noProjects').hidden&&document.querySelectorAll('.project-option').length===0",5000);
            js("document.getElementById('projectSearch').value='专用测试';document.getElementById('projectSearch').dispatchEvent(new Event('input',{bubbles:true}));true");
            waitFor("project name search","document.querySelector('.project-option[data-project-id=\""+project+"\"]')!=null&&[...document.querySelectorAll('.project-option-name')].every(n=>n.textContent.includes('专用测试'))",5000);
            tap("document.querySelector('.project-option[data-project-id=\""+project+"\"]')");waitFor("choose current project returns to chats","document.getElementById('projectPanel').hidden&&document.getElementById('drawer').open",5000);
            assertEquals("Current chat is retained",id,decode(js("localStorage.getItem('rmt-queue-selected:mac-personal')")));assertEquals("Draft retained","PROJECT_PICKER_UNSENT",decode(js("document.getElementById('text').value")));
            SystemClock.sleep(220);shot("project-switcher-light.png");mark("CUSTOM_PROJECT_SEARCH_SELECTION_AND_DRAFT_PASSED");
            tap("document.getElementById('projectToggle')");js("document.documentElement.dataset.theme='dark';true");SystemClock.sleep(220);shot("project-picker-dark.png");
            assertEquals("Dark panel uses dark background","true",js("getComputedStyle(document.getElementById('drawer')).backgroundColor==='rgb(33, 33, 33)'"));
            back();waitFor("Back closes custom picker with sidebar","!document.getElementById('drawer').open&&document.getElementById('projectPanel').hidden",5000);
            openPanel();assertEquals("Reopen shows chat list","true",js("document.getElementById('projectPanel').hidden&&document.getElementById('projectToggle').getAttribute('aria-expanded')==='false'"));
            tap("document.getElementById('projectToggle')");js("document.getElementById('projectSearch').value='专用测试';document.getElementById('projectSearch').dispatchEvent(new Event('input',{bubbles:true}));true");
            drag("document.querySelector('.project-option[data-project-id=\""+project+"\"]')",.8f,.5f,.2f,.5f);waitFor("left swipe still closes sidebar","!document.getElementById('drawer').open",5000);
            assertEquals("No write requests","[]",decode(js("JSON.stringify(window.pickerWrites)")));
            JSONObject report=new JSONObject();report.put("conversationId",id);report.put("projectId",project);report.put("nativeSelectHidden",true);report.put("projectSearch",true);report.put("emptySearch",true);report.put("sameProjectKeepsChatAndDraft",true);report.put("lightAndDark",true);report.put("backAndLeftSwipeClose",true);report.put("messagesSent",0);report.put("writeRequests",0);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"project-picker-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            mark("HONOR_CUSTOM_PROJECT_PICKER_PASSED");
        } finally {
            if(!activity.isFinishing()&&!activity.isDestroyed())js("document.getElementById('drawer').close();if(window.pickerFetch)window.fetch=window.pickerFetch;document.getElementById('text').value="+JSONObject.quote(draft)+";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));document.documentElement.dataset.theme="+JSONObject.quote(theme)+";true");
        }
    }
    private void openPanel()throws Exception {
        js("document.getElementById('showChats').click();true");
        waitFor("sidebar open","document.getElementById('drawer').open",5000);
        SystemClock.sleep(220);
    }
    private void back()throws Exception {
        android.view.accessibility.AccessibilityNodeInfo active=getInstrumentation().getUiAutomation().getRootInActiveWindow();
        assertNotNull(active);assertEquals("Foreground changed; Back refused","com.liutw.codexremote",String.valueOf(active.getPackageName()));
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
    }
    public void testLeftSwipeAndBackCloseSidebar()throws Exception {
        final String id="01a161a3-e9ff-7691-8cd7-3de4e49fcfbe",project="54e5cb30-3486-42d8-9612-d0f2c23aea19";
        Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
        waitFor("authenticated personal page","location.origin==='https://47.95.141.18'&&document.readyState==='complete'&&document.getElementById('workspace')?.hidden===false&&typeof document.getElementById('composer')?.onsubmit==='function'",60000);
        openPanel();
        js("(()=>{const s=document.getElementById('projectSelect');s.value="+JSONObject.quote(project)+";s.dispatchEvent(new Event('change',{bubbles:true}));})() ;true");
        waitFor("dedicated chat listed","document.querySelector('.session-row[data-chat-id=\""+id+"\"]')!=null",10000);
        js("document.querySelector('.session-row[data-chat-id=\""+id+"\"]').click();true");
        waitFor("dedicated original history","localStorage.getItem('rmt-queue-selected:mac-personal')==="+JSONObject.quote(id)+"&&document.querySelector('.desktop-status')?.dataset.complete==='true'",90000);
        String originalDraft=decode(js("document.getElementById('text').value"));
        try {
            js("window.closeOriginalUrl=location.href;window.closeDocToken=crypto.randomUUID();window.closeRequests=[];window.closeFetch=window.fetch;window.fetch=(...a)=>{if(a[1]?.method&&a[1].method!=='GET')window.closeRequests.push(String(a[0]));return window.closeFetch(...a)};document.getElementById('text').value='SIDEBAR_CLOSE_UNSENT';document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));true");
            String token=decode(js("window.closeDocToken"));
            openPanel();
            drag("document.getElementById('drawer')",.7f,.5f,.64f,.5f);
            assertEquals("Short left swipe stays open","true",js("document.getElementById('drawer').open"));
            drag("document.getElementById('drawer')",.2f,.5f,.7f,.5f);
            assertEquals("Right swipe inside sidebar stays open","true",js("document.getElementById('drawer').open"));
            js("(()=>{const spacer=document.createElement('div');spacer.id='sidebarScrollFixture';spacer.style.height='1200px';document.getElementById('chatList').append(spacer);document.getElementById('chatList').scrollTop=0;})() ;true");
            drag("document.getElementById('chatList')",.5f,.8f,.5f,.2f);
            assertEquals("Vertical sidebar scroll stays open","true",js("document.getElementById('drawer').open&&document.getElementById('chatList').scrollTop>20"));
            js("document.getElementById('sidebarScrollFixture').remove();document.getElementById('chatList').scrollTop=0;true");
            drag("document.querySelector('.session-row[data-chat-id=\"01a13fef-a018-7303-a2a6-f5903548537f\"]')",.8f,.5f,.2f,.5f);
            waitFor("left swipe over another row closes sidebar","!document.getElementById('drawer').open&&document.getElementById('showChats').getAttribute('aria-expanded')==='false'",5000);
            assertEquals("Swiped row must not be selected",id,decode(js("localStorage.getItem('rmt-queue-selected:mac-personal')")));
            mark("LEFT_SWIPE_CLOSES_WITHOUT_ROW_CLICK_OR_VERTICAL_INTERFERENCE");
            openPanel();drag("document.getElementById('search')",.8f,.5f,.2f,.5f);
            assertEquals("Search field left swipe does not dismiss sidebar","true",js("document.getElementById('drawer').open"));
            js("document.getElementById('search').blur();getSelection().removeAllRanges();window.closeViewport=innerHeight;true");
            getInstrumentation().runOnMainSync(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(page.getWindowToken(),0));
            SystemClock.sleep(350);
            js("history.pushState({sidebarBackProbe:true},'',location.pathname+'?sidebar-back-probe');true");
            String probeUrl=decode(js("location.href"));AtomicReference<Boolean> canGoBack=new AtomicReference<>(false);getInstrumentation().runOnMainSync(()->canGoBack.set(page.canGoBack()));assertTrue("Native navigation history is available",canGoBack.get());
            back();
            waitFor("native Back closes sidebar before navigating","!document.getElementById('drawer').open&&document.getElementById('showChats').getAttribute('aria-expanded')==='false'",5000);
            assertEquals("Back must not navigate while sidebar is open",probeUrl,decode(js("location.href")));
            assertFalse("First Back must keep Activity alive",activity.isFinishing());
            assertEquals("Document preserved",token,decode(js("window.closeDocToken")));
            assertEquals("Draft preserved","SIDEBAR_CLOSE_UNSENT",decode(js("document.getElementById('text').value")));
            mark("NATIVE_BACK_CLOSES_SIDEBAR_BEFORE_WEB_HISTORY");
            back();waitFor("Back with closed sidebar follows original history","location.href===window.closeOriginalUrl&&!document.getElementById('drawer').open",5000);
            assertEquals("History Back preserves current chat",id,decode(js("localStorage.getItem('rmt-queue-selected:mac-personal')")));
            // Some WebView versions handle system Back themselves. Also exercise
            // the Activity fallback used by other Android/WebView versions.
            String nativeProbeUrl=decode(js("location.href"));openPanel();
            getInstrumentation().runOnMainSync(activity::onBackPressed);
            waitFor("Activity Back closes panel","!document.getElementById('drawer').open",5000);
            assertEquals("Activity Back preserves page",nativeProbeUrl,decode(js("location.href")));
            assertFalse("Activity Back keeps app alive even at root",activity.isFinishing());
            String diagnostics=DiagnosticLog.get(getInstrumentation().getTargetContext()).snapshot();
            assertTrue("Drawer Back action is logged",diagnostics.contains("\"event\":\"navigation.back\",\"data\":{\"action\":\"drawer_closed\"}"));
            assertTrue("History Back action is logged",diagnostics.contains("\"event\":\"navigation.back\",\"data\":{\"action\":\"history\"}"));
            mark("NATIVE_ACTIVITY_BACK_FALLBACK_AND_DIAGNOSTICS_PASSED");
            assertEquals("No message or control writes","[]",decode(js("JSON.stringify(window.closeRequests)")));
            JSONObject report=new JSONObject();report.put("conversationId",id);report.put("leftSwipeCloses",true);report.put("rowClickSuppressed",true);report.put("sidebarVerticalScrollPreserved",true);report.put("searchGuard",true);report.put("backClosesBeforeHistory",true);report.put("closedSidebarBackNavigates",true);report.put("activityBackFallback",true);report.put("backDiagnostics",true);report.put("draftPreserved",true);report.put("messagesSent",0);report.put("writeRequests",0);report.put("apkVersion",BuildConfig.VERSION_NAME);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"sidebar-close-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            shot("sidebar-closed-after-native-back.png");mark("HONOR_LEFT_SWIPE_AND_NATIVE_BACK_PASSED");
        } finally {
            if(!activity.isFinishing()&&!activity.isDestroyed())js("document.getElementById('sidebarScrollFixture')?.remove();document.getElementById('drawer').close();document.getElementById('search').value='';document.getElementById('search').blur();getSelection().removeAllRanges();if(window.closeFetch)window.fetch=window.closeFetch;if(location.href!==window.closeOriginalUrl)history.replaceState(null,'',window.closeOriginalUrl);document.getElementById('text').value="+JSONObject.quote(originalDraft)+";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));true");
        }
    }
    public void testRightSwipeAndScrollSelectionGuards()throws Exception {
        final String id="01a161a3-e9ff-7691-8cd7-3de4e49fcfbe",project="54e5cb30-3486-42d8-9612-d0f2c23aea19";
        Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
        waitFor("authenticated personal page","location.origin==='https://47.95.141.18'&&document.readyState==='complete'&&document.getElementById('workspace')?.hidden===false&&typeof document.getElementById('composer')?.onsubmit==='function'",60000);
        js("document.getElementById('showChats').click();const s=document.getElementById('projectSelect');s.value="+JSONObject.quote(project)+";s.dispatchEvent(new Event('change',{bubbles:true}));true");
        waitFor("dedicated chat listed","document.querySelector('.session-row[data-chat-id=\""+id+"\"]')!=null",10000);
        js("document.querySelector('.session-row[data-chat-id=\""+id+"\"]').click();true");
        waitFor("dedicated history complete","localStorage.getItem('rmt-queue-selected:mac-personal')==="+JSONObject.quote(id)+"&&document.querySelector('.desktop-status')?.dataset.complete==='true'",90000);
        String originalDraft=decode(js("document.getElementById('text').value"));
        try {
            // DOM-only scroll fixtures, removed in finally; the queue and original messages are untouched.
            js("window.swipeRequests=[];window.swipeOriginalFetch=window.fetch;window.fetch=(...args)=>{if(args[1]?.method&&args[1].method!=='GET')window.swipeRequests.push({url:String(args[0]),method:args[1].method});return window.swipeOriginalFetch(...args)};document.getElementById('text').value='SWIPE_UNSENT_DRAFT';document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));const f=document.createElement('section');f.id='swipeFixture';f.style.cssText='padding:20px 0 1000px';const p=document.createElement('p');p.id='swipePlain';p.style.cssText='height:200px;margin:0';p.textContent='手势验收：右滑展开会话列表，草稿保留。';const pre=document.createElement('pre');pre.id='swipeCode';pre.style.cssText='overflow:auto;white-space:pre;height:120px;margin:0';pre.textContent='0123456789'.repeat(200);f.append(p,pre);document.querySelector('.conversation').append(f);p.scrollIntoView({block:'start'});true");
            SystemClock.sleep(150);
            drag("document.getElementById('swipePlain')",.75f,.5f,.25f,.5f);closed();
            drag("document.getElementById('swipePlain')",.25f,.5f,.31f,.5f);closed();
            mark("LEFT_AND_SHORT_SWIPE_IGNORED");
            js("document.getElementById('swipePlain').scrollIntoView({block:'start'});window.beforeVertical=document.getElementById('chatScroll').scrollTop;true");
            drag("document.getElementById('chatScroll')",.5f,.7f,.5f,.3f);closed();
            assertEquals("Vertical history scrolling works","true",js("document.getElementById('chatScroll').scrollTop>window.beforeVertical+30"));mark("VERTICAL_HISTORY_SCROLL_PRESERVED");
            js("document.getElementById('swipeCode').scrollIntoView({block:'center'});document.getElementById('swipeCode').scrollLeft=300;true");
            drag("document.getElementById('swipeCode')",.25f,.5f,.75f,.5f);closed();
            assertEquals("Code retains horizontal scrolling","true",js("document.getElementById('swipeCode').scrollLeft<270"));mark("HORIZONTAL_CODE_SCROLL_PRESERVED");
            js("document.getElementById('swipePlain').scrollIntoView({block:'start'});const range=document.createRange();range.selectNodeContents(document.getElementById('swipePlain'));getSelection().removeAllRanges();getSelection().addRange(range);true");
            drag("document.getElementById('swipePlain')",.25f,.5f,.75f,.5f);closed();mark("TEXT_SELECTION_DOES_NOT_OPEN_SIDEBAR");
            js("getSelection().removeAllRanges();document.getElementById('swipePlain').scrollIntoView({block:'start'});window.swipeEvents=[];for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.getElementById('chatScroll').addEventListener(type,e=>{const t=e.touches[0]??e.changedTouches[0];window.swipeEvents.push({type,target:e.target.id,x:t.clientX,y:t.clientY,time:performance.now(),cancelable:e.cancelable,selection:getSelection().toString().length})},{passive:true});true");
            drag("document.getElementById('swipePlain')",.25f,.5f,.75f,.5f);
            android.os.Bundle events=new android.os.Bundle();events.putString("stream","\nRIGHT_SWIPE_EVENTS "+decode(js("JSON.stringify(window.swipeEvents)"))+"\n");getInstrumentation().sendStatus(0,events);
            waitFor("right swipe opens sidebar","document.getElementById('drawer').open&&document.getElementById('showChats').getAttribute('aria-expanded')==='true'",5000);
            assertEquals("Selected chat preserved",id,decode(js("localStorage.getItem('rmt-queue-selected:mac-personal')")));
            assertEquals("Unsent draft preserved","SWIPE_UNSENT_DRAFT",decode(js("document.getElementById('text').value")));
            assertEquals("No write requests","[]",decode(js("JSON.stringify(window.swipeRequests)")));
            shot("sidebar-right-swipe.png");js("document.getElementById('closeDrawer').click();true");closed();
            js("document.getElementById('text').blur();getSelection().removeAllRanges();true");
            drag("document.getElementById('text')",.25f,.5f,.75f,.5f);closed();mark("COMPOSER_GESTURE_DOES_NOT_OPEN_SIDEBAR");
            JSONObject report=new JSONObject();report.put("conversationId",id);report.put("rightSwipeOpens",true);report.put("verticalScrollPreserved",true);report.put("codeScrollPreserved",true);report.put("selectionGuard",true);report.put("draftPreserved",true);report.put("messagesSent",0);report.put("writeRequests",0);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"sidebar-gesture-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            mark("HONOR_PHYSICAL_RIGHT_SWIPE_SIDEBAR_PASSED");
        } finally {
            js("document.getElementById('swipeFixture')?.remove();getSelection().removeAllRanges();document.getElementById('drawer').close();if(window.swipeOriginalFetch)window.fetch=window.swipeOriginalFetch;document.getElementById('text').value="+JSONObject.quote(originalDraft)+";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('text').blur();document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;true");
            getInstrumentation().runOnMainSync(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(page.getWindowToken(),0));
        }
    }
}
