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
