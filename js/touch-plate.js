// Touch-plate UI behaviour (Design Lab port, 2026-11-11): fader touch state, keyboard-proportional
// gap between the pitch and LFO strips, and the piano-key press flash on digital buttons.
// Styles: the touch-plate block at the end of styles.css.

// Marks the pitch bend / LFO strips while a finger or mouse is on them, so the fader plate can light up.
(() => {
  const sel = "#keyboardPitchBend, #keyboardLfoStrip, #hexPitchBend, #hexLfoStrip";
  const end = () => document.querySelectorAll(sel).forEach(el => el.classList.remove("is-touching"));
  document.addEventListener("pointerdown", e => {
    const strip = e.target.closest?.(sel);
    if (strip) strip.classList.add("is-touching");
  }, true);
  addEventListener("pointerup", end, true);
  addEventListener("pointercancel", end, true);
  addEventListener("blur", end);
})();

// Keep the strip gap in proportion to the keyboard: copy its natural-key width onto the strips.
(() => {
  const sync = () => {
    const kb = document.getElementById("chromaticKeyboard"), strips = document.querySelector(".keyboard-play-strips");
    const w = kb && parseFloat(getComputedStyle(kb).getPropertyValue("--white-key-width"));
    if (strips && w) strips.style.setProperty("--tp-key-w", w + "px");
  };
  const start = () => {
    sync();
    const kb = document.getElementById("chromaticKeyboard");
    if (kb) new MutationObserver(sync).observe(kb, { attributes: true, attributeFilter: ["style"] });
    addEventListener("resize", () => setTimeout(sync, 50));
  };
  if (document.readyState === "complete") setTimeout(start, 300); else addEventListener("load", () => setTimeout(start, 300));
})();

// Press flash: any switch / digital button lights up like a pressed piano key (solid lit fill, black text,
// big glow), held at least 90ms so a quick click still reads, then fades out like phosphor. The glow takes the button's own colour and follows its
// shape (drop-shadow), so slanted tabs and hex legends glow along their edges.
(() => {
  // No <select>: its native menu swallows the pointerup, so the flash would stick (box looks empty) until the next click.
  const SEL = 'button, [role="button"], [role="switch"], [role="tab"], .pushable, label:has(> input[type="checkbox"]), .kb-step-btn';
  // .pushable = the chunky physical-style buttons (Play, Rev, Rec, Acid Mode…): they keep their own press, no flash
  const SKIP = '.pushable, .pushable *, .piano-key, #hexGrid, #hexGrid *, .keyboard-pitch-bend, .keyboard-lfo-strip, .synth-knob-dial, [disabled], .is-locked';
  const rgb = c => { const m = c && c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return m ? [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]] : null; };
  const vivid = v => v && v[3] > 0.3 && Math.max(v[0], v[1], v[2]) > 70 && (Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2])) / Math.max(v[0], v[1], v[2]) > 0.4;
  const pick = el => {
    const cs = getComputedStyle(el), fallback = getComputedStyle(document.documentElement).getPropertyValue('--tp-lit').trim() || '#5ced90';
    for (const c of [cs.borderTopColor, cs.backgroundColor, cs.color, cs.getPropertyValue('--tab-stroke')]) { const v = rgb(c); if (vivid(v)) return v; }
    const v = rgb(fallback) || (fallback.startsWith('#') ? [1, 3, 5].map(i => parseInt(fallback.slice(i, i + 2), 16)).concat(1) : null);
    return v || [82, 255, 131, 1];
  };
  const style = document.createElement('style');
  style.textContent = `
    /* lit like a pressed piano key: solid fill in the lit colour, black text, big glow */
    .tp-flash { color: #000 !important; text-shadow: none !important;
      box-shadow: inset 0 0 0 999px var(--tpf-fill) !important;
      filter: drop-shadow(0 0 4px var(--tpf-a)) drop-shadow(0 0 12px var(--tpf-b)) drop-shadow(0 0 26px var(--tpf-c)) !important;
      transition: none !important; }
    .tp-flash * { color: #000 !important; text-shadow: none !important; }
    /* icons: turn lines black, and only fill shapes that were filled to begin with (open lines like the
       waveform icons must not get a fill, or they turn into blobs) */
    .tp-flash svg * { stroke: #000 !important; }
    .tp-flash svg [fill]:not([fill="none"]) { fill: #000 !important; }
    /* folder tabs are drawn by clip-path pseudos: fill the tab shape instead of the box */
    .keyboard-tab.tp-flash { box-shadow: none !important; --tab-bg: var(--tpf-fill); --tab-stroke: var(--tpf-fill); }
    /* the XY puck only glows (it's dragged, not clicked) */
    .xy-pointer.tp-flash { box-shadow: none !important; }
    /* bare icon buttons (no box of their own: top-bar play, mute, share, menu…): light the icon, not a square */
    .tp-flash.tp-icon { box-shadow: none !important; color: var(--tpf-fill) !important;
      filter: drop-shadow(0 0 3px var(--tpf-a)) drop-shadow(0 0 10px var(--tpf-b)) drop-shadow(0 0 22px var(--tpf-c)) brightness(1.35) !important; }
    .tp-flash.tp-icon *, .tp-flash.tp-icon svg, .tp-flash.tp-icon svg * { color: inherit !important; }
    .tp-flash.tp-icon svg, .tp-flash.tp-icon svg * { fill: revert-layer !important; stroke: revert-layer !important; }
    .tp-flash-out { transition: box-shadow .22s ease-out, filter .26s ease-out, color .22s ease-out !important; }`;
  document.head.append(style);
  const lit = new Set();
  document.addEventListener('pointerdown', e => {
    // XY pad: the puck glows for as long as you drag it
    const pad = e.target.closest?.('.xy-pad-wrapper');
    let el = pad ? pad.querySelector('.xy-pointer') : e.target.closest?.(SEL);
    if (!el || (!pad && el.closest(SKIP))) return;
    // bare icon buttons take the colour of the symbol itself (red stop square glows red, green play glows green)
    const csEl = getComputedStyle(el), bwEl = ['Top', 'Right', 'Bottom', 'Left'].reduce((n, k) => n + parseFloat(csEl['border' + k + 'Width']), 0);
    const bgEl = rgb(csEl.backgroundColor), iconOnly = !pad && bwEl === 0 && (!bgEl || bgEl[3] < 0.05) && !el.classList.contains('keyboard-tab');
    const iconColour = () => {
      for (const d of el.querySelectorAll('*')) {
        const c = getComputedStyle(d);
        for (const v of [c.backgroundColor, c.borderLeftColor, c.borderTopColor, c.fill, c.stroke, c.color]) { const x = rgb(v); if (vivid(x)) return x; }
      }
      return null;
    };
    const [r, g, b] = (iconOnly && iconColour()) || pick(el);
    el.style.setProperty('--tpf-a', `rgba(${r},${g},${b},.95)`);
    el.style.setProperty('--tpf-b', `rgba(${r},${g},${b},.6)`);
    el.style.setProperty('--tpf-c', `rgba(${r},${g},${b},.3)`);
    // greens light in the keyboard's lit green; other colours (cyan…) light in a brighter version of themselves
    const mx = Math.max(r, g, b), hue = mx === g && g > r && g > b ? 'green' : 'other';
    el.style.setProperty('--tpf-fill', hue === 'green' ? 'var(--tp-lit, #5ced90)' : `color-mix(in srgb, rgb(${r},${g},${b}) 75%, #fff)`);
    // no border and no background = a bare icon: glow it instead of filling a square
    el.classList.toggle('tp-icon', iconOnly);
    el.classList.remove('tp-flash-out'); el.classList.add('tp-flash'); el.__tpDown = performance.now(); lit.add(el);
  }, true);
  const release = () => {
    for (const el of lit) {
      // a quick click still shows a full flash: stay lit at least 90ms, then decay
      const wait = Math.max(0, 90 - (performance.now() - (el.__tpDown || 0)));
      setTimeout(() => {
        el.classList.add('tp-flash-out'); el.classList.remove('tp-flash');
        setTimeout(() => { if (!el.classList.contains('tp-flash')) el.classList.remove('tp-flash-out'); }, 300);
      }, wait);
    }
    lit.clear();
  };
  addEventListener('pointerup', release, true);
  addEventListener('pointercancel', release, true);
  addEventListener('blur', release);
  // belt and braces: anything that opens a native popup or changes value ends the flash too
  addEventListener('change', release, true);
  addEventListener('focusout', release, true);
})();
