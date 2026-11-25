const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'chatgpt_auto_continue.user.js'), 'utf8');

function functionSource(name) {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name);
    const end = source.indexOf('\n    }', start);
    assert.ok(end >= 0, name);
    return source.slice(start, end + 6);
}

function fixture() {
    const state = { sidebar: 'working', stop: false, busy: false, now: 1000, text: 'complete', editable: true };
    const turn = { get textContent() { return state.text; } };
    const ctx = vm.createContext({
        Date: { now: () => state.now },
        TAB_ACTIVITY_WINDOW_MS: 2400,
        SIDEBAR_STALE_MS: 30000, UNCORROBORATED_BUSY_STALE_MS: 45000, UNCERTAIN_BUSY_STALE_MS: 120000,
        sidebarOnlySinceMs: null, sidebarOnlyFingerprint: null,
        assistantActivityFingerprint: null, assistantActivityAt: null,
        weakBusySinceMs: 0, weakBusyTextFingerprint: null,
        getCurrentSidebarGenerationState: () => state.sidebar,
        getStopButton: () => state.stop,
        hasUnansweredUserTurn: () => Boolean(state.unanswered),
        getAssistantStreamingFlag: () => ({active: state.busy, lastTurn: turn}),
        getAssistantElements: () => [turn],
        getSendButton: () => null,
        getComposerInput: () => ({isConnected: true, disabled: !state.editable, value: '', getAttribute: () => null})
    });
    vm.runInContext(functionSource('getGenerationSignals') + '\n' + functionSource('generationBlocksSend'), ctx);
    return {state, signals: () => ctx.getGenerationSignals(), blocked: (s, manual) => ctx.generationBlocksSend(s, manual)};
}

test('sidebar alone blocks auto but not intentional manual send', () => {
    const f = fixture(), s = f.signals();
    assert.equal(s.active, true);
    assert.equal(f.blocked(s, false), true);
    assert.equal(f.blocked(s, true), false);
});
test('Stop, busy, and changing assistant text block manual and automatic send', () => {
    const f = fixture(); f.signals();
    for (const key of ['stop', 'busy']) {
        f.state[key] = true;
        const s = f.signals();
        assert.equal(f.blocked(s, true), true);
        assert.equal(f.blocked(s, false), true);
        f.state[key] = false;
    }
    f.state.sidebar = 'unknown'; f.state.text += ' streaming';
    const s = f.signals();
    assert.equal(s.recentActivity, true);
    assert.equal(f.blocked(s, true), true);
    assert.equal(f.blocked(s, false), true);
});
test('stale sidebar after 30s pauses automatic continuation but allows manual retry', () => {
    const f = fixture(); f.signals();
    f.state.now += 29999;
    assert.equal(f.signals().staleSidebar, false);
    f.state.now++;
    const s = f.signals();
    assert.equal(s.staleSidebar, true);
    assert.equal(s.active, false);
    assert.equal(f.blocked(s, false), true);
    assert.equal(f.blocked(s, true), false);
    f.state.text += ' updated';
    assert.equal(f.signals().staleSidebar, false);
});
test('collapsed sidebar does not imply generation; Stop still blocks', () => {
    const f = fixture(); f.state.sidebar = 'unknown';
    assert.equal(f.blocked(f.signals(), true), false);
    f.state.stop = true;
    assert.equal(f.blocked(f.signals(), true), true);
});
test('visibility rejects hidden, clipped, offscreen and disconnected rows', () => {
    const ctx = vm.createContext({window: {innerWidth: 1000, innerHeight: 800, getComputedStyle: n => n.style}});
    vm.runInContext(functionSource('isVisibleControl'), ctx);
    const rect = {left: 10, top: 10, right: 200, bottom: 40};
    function el(overrides = {}) {
        return {isConnected:true, closest:()=>null, getClientRects:()=>[rect], getBoundingClientRect:()=>rect,
            style:{display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'}, parentElement:null,...overrides};
    }
    assert.equal(ctx.isVisibleControl(el()), true);
    assert.equal(ctx.isVisibleControl(el({isConnected:false})), false);
    assert.equal(ctx.isVisibleControl(el({closest:()=>({})})), false);
    assert.equal(ctx.isVisibleControl(el({getBoundingClientRect:()=>({left:-250,right:-10,top:10,bottom:40})})), false);
    const hidden = el(); hidden.style.display = 'none';
    assert.equal(ctx.isVisibleControl(el({parentElement:hidden})), false);
    const clipped = el({getBoundingClientRect:()=>({left:0,right:0,top:0,bottom:800})});
    clipped.style.overflowX = 'hidden';
    assert.equal(ctx.isVisibleControl(el({parentElement:clipped})), false);
});

test('click or unchanged previous user turn is not confirmation', () => {
    const ctx = vm.createContext({normalizeText: value => String(value || '').trim().replace(/\s+/g, ' ')});
    vm.runInContext(functionSource('isSubmissionConfirmed'), ctx);
    const before = {count: 4, id: 'old', text: 'Continue'};
    assert.equal(ctx.isSubmissionConfirmed(before, before, 'Continue', 'Continue', false), false);
    assert.equal(ctx.isSubmissionConfirmed(before, before, 'Continue', '', false), false);
    assert.equal(ctx.isSubmissionConfirmed(before, {count:5,id:'new',text:'Different'}, 'Continue', '', false), false);
    assert.equal(ctx.isSubmissionConfirmed(before, {count:5,id:'new',text:'Continue'}, 'Continue', '', false), true);
    assert.equal(ctx.isSubmissionConfirmed(before, {count:4,id:'new',text:'Continue'}, 'Continue', '', false), true);
    assert.equal(ctx.isSubmissionConfirmed(before, before, 'Continue', 'Continue', true), false);
    assert.equal(ctx.isSubmissionConfirmed(before, before, 'Continue', '', true), true);
});

test('finds enabled real send button even when preferred selector is disabled', () => {
    const disabled = {disabled:true, matches:()=>false,getAttribute:()=>null};
    const ready = {disabled:false,matches:()=>false,getAttribute:()=>null};
    const hidden = {disabled:false,matches:()=>false,getAttribute:()=>null};
    const stop = {disabled:false,matches:()=>true,getAttribute:()=>null};
    const ctx = vm.createContext({
        isVisibleControl: btn => btn !== hidden,
        getComposerRoot:()=>({querySelectorAll: selector =>
            selector === 'button[data-testid="send-button"]' ? [hidden,disabled,stop] :
            selector === 'button#composer-submit-button' ? [ready] : []})
    });
    vm.runInContext(functionSource('getSendButton'),ctx);
    assert.equal(ctx.getSendButton(),ready);
});

test('status tooltip preserves the full status and latest diagnostics', () => {
    const statusBadgeEl = {textContent: 'Черновик не пуст — отправка отменена', dataset: {}};
    const ctx = vm.createContext({statusBadgeEl});
    vm.runInContext(functionSource('updateStatusTooltip'), ctx);
    ctx.updateStatusTooltip('Sidebar: unknown');
    assert.equal(statusBadgeEl.title, 'Черновик не пуст — отправка отменена\n\nSidebar: unknown');
    statusBadgeEl.textContent = 'Ожидание';
    ctx.updateStatusTooltip();
    assert.equal(statusBadgeEl.title, 'Ожидание\n\nSidebar: unknown');
    ctx.updateStatusTooltip('Отправка: клик');
    assert.equal(statusBadgeEl.title, 'Ожидание\n\nОтправка: клик');
});

test('header status can shrink while action buttons retain their width', () => {
    const header = functionSource('createFloatingPanel');
    const statusStyle = header.split('statusBadgeEl.style.cssText = [')[1].split("].join(';')")[0];
    assert.ok(statusStyle.includes("'min-width: 0'"));
    assert.ok(statusStyle.includes("'overflow: hidden'"));
    assert.ok(statusStyle.includes("'text-overflow: ellipsis'"));
    assert.ok(statusStyle.includes("'flex: 1 1 auto'"));
    assert.ok(header.includes("control.style.flex = '0 0 auto'"));
});

test('unanswered user turn blocks both manual and automatic sends, even with hidden sidebar', () => {
    const f = fixture(); f.state.sidebar = 'unknown'; f.state.unanswered = true;
    assert.equal(f.signals().active, true);
    assert.equal(f.blocked(f.signals(), true), true);
    assert.equal(f.blocked(f.signals(), false), true);
    f.state.now += 180000;
    assert.equal(f.signals().active, true);
    f.state.unanswered = false;
    assert.equal(f.signals().active, false);
});

test('finds a visible stop control outside composer form, rejects voice and hidden controls', () => {
    const button = attrs => ({getAttribute: k => attrs[k] || null});
    const voice = button({'aria-label':'Stop recording'});
    const hidden = button({'data-testid':'stop-button'});
    const stop = button({title:'Stop generating'});
    const ctx = vm.createContext({
        getComposerRoot:()=>({querySelectorAll:()=>[voice]}),
        getComposerInput:()=>null,
        document:{querySelectorAll:()=>[hidden,stop]},
        isVisibleControl: btn => btn !== hidden
    });
    vm.runInContext(functionSource('getStopButton'),ctx);
    assert.equal(ctx.getStopButton(),stop);
});

test('streaming indicator on assistant turn wrapper is recognized', () => {
    const wrapper = {matches:()=>true,querySelector:()=>null};
    const turn = {closest:()=>wrapper,matches:()=>false,querySelector:()=>null};
    const ctx = vm.createContext({getAssistantElements:()=>[turn]});
    vm.runInContext(functionSource('getAssistantStreamingFlag'),ctx);
    assert.equal(ctx.getAssistantStreamingFlag().active,true);
});

function submissionFixture({draft = '', accept = true, clickThrows = false, setupThrows = false, enabled = true, acceptance = 'user'} = {}) {
    const state = {now:1000, clicks:0, count:0, user:{count:1,id:'old',text:'Previous'}, errors:[], timer:[], status:'', insertions:0, stop:false, assistantText:'Previous reply'};
    const editor = {value:draft};
    const ctx = vm.createContext({
        Date:{now:()=>state.now},
        SUBMIT_DELAY_MS:450, SEND_READY_TIMEOUT_MS:5000, SEND_CONFIRM_TIMEOUT_MS:15000,
        disposed:false, enabled, manualBlockUntil:0, isSubmitting:false, awaitingReply:false,
        pendingSubmitToken:0, pendingSubmitTimerId:null, pendingOwnedDraft:null, lastSendStage:'',
        completionCandidateSinceMs:0, hasCompletedOnce:false, submittedAssistantCount:0,
        submittedAtMs:0, tabRequestStartedAtMs:null, wasGenerating:false, stopNotifiedForCurrentReply:false,
        setTimeout:(fn,delay)=>{state.timer.push({fn,delay});return state.timer.length;},
        console:{error:()=>{}},
        getGenerationSignals:()=>({active:state.stop,stopButton:state.stop,composerEditable:true}),
        getStopButton:()=>state.stop,
        getExplicitUiFailure:()=>null, clearTabNotice:()=>{},
        getActiveStopWord:()=>'', hasStopWordInLastReply:()=>false,
        getActivePromptText:()=>'Continue', getActiveStopPromptText:()=>'',
        buildFullPrompt:prompt=>prompt, getComposerInput:()=>editor,
        getComposerText:el=>el?.value||'', normalizeText:text=>String(text||'').trim(),
        composerContainsExpectedText:(el,text)=>el?.value===text,
        setComposerText:(el,text)=>{state.insertions++;el.value=text;return true;},
        getConversationKey:()=>{if(setupThrows)throw new ReferenceError('mock failure');return 'chat:abc';},
        getAssistantElements:()=>[{textContent:state.assistantText}], getUserMessageSnapshot:()=>({...state.user}),
        getSendButton:()=>({disabled:false,isConnected:true,getAttribute:()=>null,id:'composer-submit-button',
            click:()=>{
                state.clicks++;
                if(clickThrows)throw new Error('click failed');
                if(!accept)return;
                if(acceptance==='stop') {
                    // Reused message nodes, no recognized new user turn.
                    state.stop=true;editor.value='';
                } else if(acceptance==='assistant') {
                    state.assistantText='A new answer';editor.value='';
                } else if(acceptance==='decorated') {
                    state.user={count:2,id:'new',text:editor.value+' Copy Edit'};editor.value='';
                } else if(acceptance==='delayed-stop') {
                    editor.value='';
                    state.timer.push({delay:9000,fn:()=>{state.stop=true;}});
                } else {
                    state.user={count:2,id:'new',text:editor.value};editor.value='';
                }
            }}),
        recordContinuationSent:()=>{state.count++;}, playTickSound:()=>{},
        setStatus:text=>{state.status=text;},setTabIndicator:()=>{},
        showTabNotice:(mode,reason)=>{state.errors.push(reason);},
        showManualBlock:reason=>{state.errors.push(reason);},
        pauseForUiFailure:(mode,reason)=>{state.errors.push(reason);ctx.isSubmitting=false;ctx.awaitingReply=false;ctx.enabled=false;state.timer=[];},
        cancelPendingSend:()=>{ctx.isSubmitting=false;ctx.pendingSubmitToken++;state.timer=[];}
    });
    vm.runInContext(['generationBlocksSend','getAssistantSnapshot','hasAssistantAdvanced','isSubmissionConfirmed','triggerSend','handleSubmissionException',
        'scheduleSendStep','runContinueNow','performContinuation'].map(functionSource).join('\n'),ctx);
    const drain=()=>{for(let i=0;state.timer.length;i++){assert.ok(i<100,'timer loop');const next=state.timer.shift();state.now+=next.delay;next.fn();}};
    return {ctx,state,editor,drain};
}

test('manual send completes entire workflow from empty editor to confirmation',()=>{
    const f=submissionFixture();
    f.ctx.runContinueNow(true);
    assert.equal(f.editor.value,'Continue');
    assert.equal(f.ctx.isSubmitting,true);
    assert.equal(f.ctx.pendingSubmitToken,1);
    assert.equal(f.state.clicks,0);
    f.drain();
    assert.equal(f.state.clicks,1);
    assert.equal(f.state.count,1);
    assert.equal(f.editor.value,'');
    assert.equal(f.ctx.isSubmitting,false);
    assert.equal(f.ctx.awaitingReply,true);
    assert.deepEqual(f.state.errors,[]);
});

test('manual retry submits matching existing draft without inserting it again',()=>{
    const f=submissionFixture({draft:'Continue'});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.insertions,0);
    assert.equal(f.state.clicks,1);
    assert.equal(f.state.count,1);
});

test('automatic send follows same confirmed submission flow',()=>{
    const f=submissionFixture();
    f.ctx.runContinueNow(false);f.drain();
    assert.equal(f.state.clicks,1);
    assert.equal(f.state.count,1);
});

test('unconfirmed click preserves draft and never clicks twice',()=>{
    const f=submissionFixture({accept:false});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.clicks,1);
    assert.equal(f.state.count,0);
    assert.equal(f.editor.value,'Continue');
    assert.equal(f.ctx.isSubmitting,false);
    assert.match(f.state.errors[0],/не подтверждена/);
});

test('exception after draft insertion is surfaced instead of silently stopping',()=>{
    const f=submissionFixture({setupThrows:true});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.editor.value,'Continue');
    assert.equal(f.state.clicks,0);
    assert.equal(f.ctx.isSubmitting,false);
    assert.match(f.state.errors[0],/ReferenceError/);
});

test('delayed execution exception is surfaced and releases submission lock',()=>{
    const f=submissionFixture();
    f.ctx.runContinueNow(true);
    f.ctx.getGenerationSignals=()=>{throw new TypeError('mock timer failure');};
    f.drain();
    assert.equal(f.editor.value,'Continue');
    assert.equal(f.state.clicks,0);
    assert.equal(f.ctx.isSubmitting,false);
    assert.match(f.state.errors[0],/TypeError/);
});

test('real Stop transition confirms submission despite reused message nodes',()=>{
    const f=submissionFixture({acceptance:'stop'});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.clicks,1);
    assert.equal(f.state.count,1);
    assert.equal(f.ctx.enabled,true);
    assert.equal(f.ctx.isSubmitting,false);
    assert.equal(f.ctx.awaitingReply,false);
    assert.equal(f.ctx.wasGenerating,true);
    assert.deepEqual(f.state.errors,[]);
});

test('new response content confirms submission even when assistant count is unchanged',()=>{
    const f=submissionFixture({acceptance:'assistant'});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.count,1);
    assert.equal(f.ctx.wasGenerating,true);
    assert.equal(f.ctx.enabled,true);
    assert.deepEqual(f.state.errors,[]);
});

test('user turn with UI decoration confirms submission after composer clears',()=>{
    const f=submissionFixture({acceptance:'decorated'});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.count,1);
    assert.equal(f.ctx.awaitingReply,true);
    assert.equal(f.ctx.enabled,true);
});

test('late Stop appearance confirms instead of disabling automation',()=>{
    const f=submissionFixture({acceptance:'delayed-stop'});
    f.ctx.runContinueNow(true);f.drain();
    assert.equal(f.state.count,1);
    assert.equal(f.ctx.wasGenerating,true);
    assert.equal(f.ctx.enabled,true);
    assert.deepEqual(f.state.errors,[]);
});

test('production script contains no accidental secret-redaction placeholder',()=>{
    assert.equal(source.includes('['+'REDACTED_SECRET'+']'),false);
});

function languageFixture(storage = {}) {
    const writes = [];
    let refreshes = 0;
    const ctx = vm.createContext({
        loadJSON:(key,fallback)=>Object.hasOwn(storage,key)?storage[key]:fallback,
        saveJSON:(key,value)=>{storage[key]=value;writes.push([key,value]);},
        STORAGE_DEFAULTS_KEY:'defaults', STORAGE_CHATS_KEY:'chats', DEFAULT_STOP_WORD:'STOP_IT'
    });
    const start = source.indexOf("    const STORAGE_LANGUAGE_KEY =");
    const end = source.indexOf("    let disposed = false;",start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start,end),ctx);
    ctx.refresh=()=>{refreshes++;};
    vm.runInContext("refreshLanguageUI = refresh",ctx);
    vm.runInContext(functionSource('getChatConfig')+'\n'+functionSource('formatDuration')+'\n'+functionSource('stripTabPrefix'),ctx);
    return {ctx,writes,refreshes:()=>refreshes,language:()=>vm.runInContext('language',ctx)};
}

test('English is the default locale for new installs',()=>{
    const f=languageFixture();
    assert.equal(f.language(),'en');
    assert.equal(f.ctx.tr('Черновик готов'),'Draft ready');
    assert.equal(f.ctx.tr('Проверка завершения: 5с'),'Checking completion: 5s');
    assert.equal(f.ctx.tr('Ошибка отправки: ReferenceError'),'Submission error: ReferenceError');
    assert.equal(f.ctx.getChatConfig('new').prompt,'Continue');
    assert.match(f.ctx.getChatConfig('new').stopPrompt,/\{STOP_WORD\}/);
    assert.equal(f.ctx.formatDuration(65000),'1m 05s');
});

test('language preference persists without changing saved prompts',()=>{
    const storage={chats:{chat:{prompt:'продолжай',stopPrompt:'custom rule',stopWord:'CUSTOM'}}};
    const f=languageFixture(storage);
    f.ctx.setLanguage('ru');
    assert.equal(f.ctx.tr('Черновик готов'),'Черновик готов');
    assert.equal(f.ctx.getChatConfig('new').prompt,'Продолжай');
    assert.equal(f.ctx.getChatConfig('chat').prompt,'продолжай');
    assert.equal(f.ctx.getChatConfig('chat').stopWord,'CUSTOM');
    assert.equal(f.refreshes(),1);
    assert.equal(languageFixture(storage).language(),'ru');
    f.ctx.setLanguage('en',false);
    assert.equal(f.ctx.getChatConfig('chat').stopPrompt,'custom rule');
    assert.equal(f.writes.length,1);
    assert.equal(f.refreshes(),2);
});

test('tab title accepts both language prefixes without duplication',()=>{
    const f=languageFixture();
    assert.equal(f.ctx.stripTabPrefix('[DONE] My chat'),'My chat');
    assert.equal(f.ctx.stripTabPrefix('[ГОТОВО] My chat'),'My chat');
    assert.equal(f.ctx.stripTabPrefix('[CHECK] My chat'),'My chat');
});
