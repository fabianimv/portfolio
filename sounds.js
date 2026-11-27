// ============================================
// SOUNDS — tactile UI sound effects
// Synthesized with the Web Audio API (no audio files, no dependencies).
// Inspired by https://buttons.joshwcomeau.com/ : every interactive element
// gets a "press" on pointer down and a lighter "release" on pointer up,
// with a little random pitch variation so it never feels robotic.
// A nav toggle mutes everything; the choice is saved in localStorage.
// Exposes window.FMSound.enabled() so other effects can respect the mute.
// ============================================

(function () {
    'use strict';

    const STORAGE_KEY = 'fm-sound';
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    // Elements that make a sound. Opt out with data-no-sound.
    const TARGET = 'a[href], button, [role="button"], summary';
    const lang = () => (document.documentElement.getAttribute('data-lang') === 'es' ? 'es' : 'en');

    // ---------- state ----------
    let on = true;
    try { on = localStorage.getItem(STORAGE_KEY) !== '0'; } catch (e) { /* storage blocked */ }

    let ctx = null;
    let bus = null;
    let noiseBuf = null;

    function ensureCtx() {
        if (!on) return null;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!ctx) {
            ctx = new Ctx();
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -14;
            comp.ratio.value = 6;
            const master = ctx.createGain();
            master.gain.value = 0.55;
            comp.connect(master).connect(ctx.destination);
            bus = comp;
            // One shared 120ms noise buffer, reused by every click
            const len = Math.floor(ctx.sampleRate * 0.12);
            noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
            const ch = noiseBuf.getChannelData(0);
            for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
    }

    // ---------- primitives ----------
    const jitter = (amt) => 1 + (Math.random() * 2 - 1) * amt;

    // Short pitched blip with a fast decay; optional pitch glide
    function tone(c, { type = 'sine', freq, to, dur = 0.06, vol = 0.2, at = 0 }) {
        const t = c.currentTime + at;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(bus);
        osc.start(t);
        osc.stop(t + dur + 0.02);
    }

    // Filtered noise burst: the "plastic click" texture
    function click(c, { freq, q = 1.2, dur = 0.03, vol = 0.2, at = 0 }) {
        const t = c.currentTime + at;
        const src = c.createBufferSource();
        src.buffer = noiseBuf;
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = q;
        const g = c.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(bp).connect(g).connect(bus);
        src.start(t);
        src.stop(t + dur + 0.02);
    }

    // ---------- sound set ----------
    const SOUNDS = {
        // Pointer enters an element: barely-there tick
        hover(c) {
            tone(c, { type: 'triangle', freq: 2200 * jitter(0.08), dur: 0.025, vol: 0.035 });
        },
        // Pointer down: low thump + click
        press(c) {
            const j = jitter(0.07);
            tone(c, { type: 'sine', freq: 190 * j, to: 95 * j, dur: 0.07, vol: 0.28 });
            click(c, { freq: 1800 * j, dur: 0.025, vol: 0.14 });
        },
        // Pointer up: lighter, higher "release"
        release(c) {
            const j = jitter(0.07);
            tone(c, { type: 'sine', freq: 330 * j, to: 240 * j, dur: 0.045, vol: 0.12 });
            click(c, { freq: 3200 * j, q: 2, dur: 0.018, vol: 0.1 });
        },
        // Primary call-to-action: deeper press
        pressPrimary(c) {
            const j = jitter(0.05);
            tone(c, { type: 'sine', freq: 150 * j, to: 70 * j, dur: 0.1, vol: 0.34 });
            tone(c, { type: 'triangle', freq: 600 * j, to: 420 * j, dur: 0.05, vol: 0.08 });
            click(c, { freq: 1500 * j, dur: 0.03, vol: 0.16 });
        },
        // Soft nav-link press
        pressSoft(c) {
            const j = jitter(0.06);
            tone(c, { type: 'sine', freq: 420 * j, to: 300 * j, dur: 0.05, vol: 0.14 });
            click(c, { freq: 2600 * j, dur: 0.02, vol: 0.08 });
        },
        // Switch flipped on / off (language, sound toggle)
        toggleOn(c) {
            tone(c, { type: 'triangle', freq: 520, dur: 0.07, vol: 0.16 });
            tone(c, { type: 'triangle', freq: 780, dur: 0.09, vol: 0.16, at: 0.06 });
        },
        toggleOff(c) {
            tone(c, { type: 'triangle', freq: 780, dur: 0.07, vol: 0.14 });
            tone(c, { type: 'triangle', freq: 480, dur: 0.1, vol: 0.14, at: 0.06 });
        },
        // Toast / notification
        success(c) {
            [659.25, 987.77].forEach((f, i) => tone(c, { type: 'sine', freq: f, dur: 0.14, vol: 0.14, at: i * 0.07 }));
        },
        alert(c) {
            tone(c, { type: 'square', freq: 440, dur: 0.07, vol: 0.05 });
            tone(c, { type: 'square', freq: 440, dur: 0.07, vol: 0.05, at: 0.1 });
        }
    };

    function play(name) {
        const c = ensureCtx();
        if (!c || c.state === 'closed') return;
        SOUNDS[name](c);
    }

    // Pick the press/release flavor for an element
    function flavor(el) {
        if (el.closest('.lang-toggle, #soundToggle')) return 'toggle';
        if (el.closest('.btn-primary, .chat-send, .chat-fab')) return 'primary';
        if (el.closest('.nav-link, .nav-logo, .mobile-menu a')) return 'soft';
        return 'default';
    }

    function targetOf(e) {
        const el = e.target && e.target.closest ? e.target.closest(TARGET) : null;
        if (!el || el.hasAttribute('data-no-sound') || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
        return el;
    }

    function press(el) {
        const f = flavor(el);
        if (f === 'primary') play('pressPrimary');
        else if (f === 'soft') play('pressSoft');
        else play('press');
    }

    function release(el) {
        // Toggles get their own on/off sound on click instead
        if (flavor(el) === 'toggle') return;
        play('release');
    }

    // ---------- events ----------
    let pressed = null;      // element currently held down
    let lastHover = 0;
    let lastHoverEl = null;

    function bind() {
        document.addEventListener('pointerdown', (e) => {
            if (!on || (e.pointerType === 'mouse' && e.button !== 0)) return;
            // Unlock audio on the first gesture even if nothing is clickable
            ensureCtx();
            const el = targetOf(e);
            if (!el) return;
            pressed = el;
            press(el);
        }, true);

        document.addEventListener('pointerup', (e) => {
            if (!on) return;
            const el = pressed;
            pressed = null;
            if (el) release(el);
        }, true);

        document.addEventListener('pointercancel', () => { pressed = null; }, true);

        // Hover ticks only make sense with a real mouse
        if (finePointer) {
            document.addEventListener('pointerover', (e) => {
                if (!on || e.pointerType !== 'mouse') return;
                const el = targetOf(e);
                if (!el || el === lastHoverEl) return;
                lastHoverEl = el;
                const now = performance.now();
                if (now - lastHover < 70) return;
                lastHover = now;
                if (ctx || ensureCtx()) play('hover');
            }, true);
            document.addEventListener('pointerout', (e) => {
                if (lastHoverEl && !lastHoverEl.contains(e.relatedTarget)) lastHoverEl = null;
            }, true);
        }

        // Keyboard: Enter / Space on a focused control
        document.addEventListener('keydown', (e) => {
            if (!on || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
            const t = e.target;
            if (!t || !t.matches || !t.matches('a[href], button, [role="button"], summary')) return;
            if (t.hasAttribute('data-no-sound') || t.disabled) return;
            pressed = t;
            press(t);
        }, true);
        document.addEventListener('keyup', (e) => {
            if (!on || (e.key !== 'Enter' && e.key !== ' ')) return;
            const el = pressed;
            pressed = null;
            if (el) release(el);
        }, true);

        // Language switch: on/off-style sound depending on direction
        const langBtn = document.getElementById('langToggle');
        if (langBtn) {
            // main.js flips data-lang in its own click handler; read it after that runs
            langBtn.addEventListener('click', () => setTimeout(() => play(lang() === 'es' ? 'toggleOn' : 'toggleOff'), 0));
        }

        // Toasts: chime for normal ones, buzz for warnings / critical
        const toasts = document.getElementById('toastContainer');
        if (toasts) {
            new MutationObserver((muts) => {
                if (!on) return;
                muts.forEach((m) => m.addedNodes.forEach((n) => {
                    if (n.nodeType !== 1 || !n.classList.contains('toast')) return;
                    play(n.classList.contains('crit') || n.classList.contains('warn') ? 'alert' : 'success');
                }));
            }).observe(toasts, { childList: true });
        }

        // Save battery: don't keep the audio graph alive in background tabs
        document.addEventListener('visibilitychange', () => {
            if (!ctx) return;
            if (document.hidden) ctx.suspend().catch(() => {});
            else if (on) ctx.resume().catch(() => {});
        });
    }

    // ---------- mute toggle ----------
    function initToggle() {
        const btn = document.getElementById('soundToggle');
        if (!btn) return;

        function render() {
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.classList.toggle('is-muted', !on);
            const label = lang() === 'es'
                ? (on ? 'Sonido activado. Clic para silenciar' : 'Sonido silenciado. Clic para activar')
                : (on ? 'Sound on. Click to mute' : 'Sound muted. Click to unmute');
            btn.setAttribute('aria-label', label);
            btn.title = label;
        }

        btn.addEventListener('click', () => {
            on = !on;
            try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
            render();
            if (on) play('toggleOn');   // confirmation only when turning on
        });

        new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
        render();
    }

    window.FMSound = { enabled: () => on };

    bind();
    initToggle();
})();
