/**
 * window.check() - Performance Diagnostics Tool
 * 
 * שימוש:
 *   window.check()        - מתחיל מדידה (5 שניות ברירת מחדל)
 *   window.check(10)      - מדידה של 10 שניות
 *   window.check.stop()   - עוצר ידנית ומציג תוצאות
 *   window.check.report() - מציג את הדוח האחרון שוב
 */
(function () {
  let running = false;
  let observers = [];
  let cleanups = [];
  let results = null;

  // ===== Data collectors =====
  let longAnimFrames = [];
  let longTasks = [];
  let fnTimings = {};        // { name: { calls, totalMs, maxMs, avgMs } }
  let layoutThrash = [];
  let memSnapshots = [];

  function reset() {
    longAnimFrames = [];
    longTasks = [];
    fnTimings = {};
    layoutThrash = [];
    memSnapshots = [];
    observers = [];
    cleanups = [];
  }

  // ===== 1. Long Animation Frames (LoAF) =====
  function observeLoAF() {
    if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      console.warn('[check] LoAF לא נתמך בדפדפן הזה - משתמש ב-longtask בלבד');
      return;
    }
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = (entry.scripts || []).map(s => ({
          name: s.name || s.sourceFunctionName || '(anonymous)',
          sourceURL: s.sourceURL || '',
          invoker: s.invokerType ? `${s.invokerType}: ${s.invoker || s.invokerName || ''}` : '',
          duration: Math.round(s.duration),
          forcedLayout: Math.round(s.forcedStyleAndLayoutDuration || 0),
        }));
        longAnimFrames.push({
          duration: Math.round(entry.duration),
          blockingDuration: Math.round(entry.blockingDuration || 0),
          renderStart: Math.round(entry.renderStart || 0),
          styleLayoutDuration: Math.round(entry.styleAndLayoutStart || 0),
          forcedLayoutDuration: Math.round(entry.forcedStyleAndLayoutDuration || 0),
          scripts,
          timestamp: Date.now(),
        });
      }
    });
    obs.observe({ type: 'long-animation-frame', buffered: false });
    observers.push(obs);
  }

  // ===== 2. Long Tasks =====
  function observeLongTasks() {
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          duration: Math.round(entry.duration),
          startTime: Math.round(entry.startTime),
          attribution: entry.attribution?.map(a => a.containerName || a.name || 'unknown') || [],
          timestamp: Date.now(),
        });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    observers.push(obs);
  }

  // ===== 3. Function Monkey-Patching =====
  function patchFunctions() {
    // Patch all React component functions and event handlers
    // We hook into the global scope and common patterns

    // Patch requestAnimationFrame callbacks
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      return origRAF.call(window, function (ts) {
        const start = performance.now();
        const result = cb(ts);
        const dur = performance.now() - start;
        recordFn('requestAnimationFrame callback', dur);
        return result;
      });
    };
    cleanups.push(() => { window.requestAnimationFrame = origRAF; });

    // Patch setTimeout callbacks
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (cb, delay, ...args) {
      if (typeof cb !== 'function') return origSetTimeout.call(window, cb, delay, ...args);
      return origSetTimeout.call(window, function () {
        const start = performance.now();
        const result = cb.apply(this, args);
        const dur = performance.now() - start;
        if (dur > 1) recordFn(`setTimeout(${delay}ms) callback`, dur);
        return result;
      }, delay);
    };
    cleanups.push(() => { window.setTimeout = origSetTimeout; });

    // Patch setInterval callbacks
    const origSetInterval = window.setInterval;
    window.setInterval = function (cb, delay, ...args) {
      if (typeof cb !== 'function') return origSetInterval.call(window, cb, delay, ...args);
      return origSetInterval.call(window, function () {
        const start = performance.now();
        const result = cb.apply(this, args);
        const dur = performance.now() - start;
        if (dur > 0.5) recordFn(`setInterval(${delay}ms) callback`, dur);
        return result;
      }, delay);
    };
    cleanups.push(() => { window.setInterval = origSetInterval; });

    // Patch addEventListener to track event handler performance
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const patchedListeners = new WeakMap();
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (typeof listener !== 'function') {
        return origAddEventListener.call(this, type, listener, options);
      }
      const wrapped = function (event) {
        const start = performance.now();
        const result = listener.call(this, event);
        const dur = performance.now() - start;
        if (dur > 1) {
          const target = event?.target;
          const targetDesc = target ? (target.id ? `#${target.id}` : target.className ? `.${target.className.split(' ')[0]}` : target.tagName?.toLowerCase()) : '';
          recordFn(`${type} handler on ${targetDesc || 'element'}`, dur);
        }
        return result;
      };
      patchedListeners.set(listener, wrapped);
      return origAddEventListener.call(this, type, wrapped, options);
    };
    cleanups.push(() => { EventTarget.prototype.addEventListener = origAddEventListener; });

    // Patch known expensive DOM APIs
    const domPatches = [
      [Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect'],
      [Element.prototype, 'querySelectorAll', 'querySelectorAll'],
      [Document.prototype, 'querySelectorAll', 'document.querySelectorAll'],
    ];
    for (const [obj, method, label] of domPatches) {
      const orig = obj[method];
      if (!orig) continue;
      obj[method] = function (...args) {
        const start = performance.now();
        const result = orig.apply(this, args);
        const dur = performance.now() - start;
        if (dur > 0.5) recordFn(label, dur);
        return result;
      };
      cleanups.push(() => { obj[method] = orig; });
    }

    // Track layout thrashing: detect read-after-write patterns
    const layoutProps = ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft',
      'clientHeight', 'clientWidth', 'scrollHeight', 'scrollWidth'];
    let lastStyleWrite = 0;
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    const origStyleSet = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');

    // Track style writes
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
      lastStyleWrite = performance.now();
      return origSetProp.apply(this, args);
    };
    cleanups.push(() => { CSSStyleDeclaration.prototype.setProperty = origSetProp; });

    // Track layout reads after style writes
    for (const prop of layoutProps) {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      if (!desc?.get) continue;
      const origGet = desc.get;
      Object.defineProperty(HTMLElement.prototype, prop, {
        get() {
          const now = performance.now();
          if (now - lastStyleWrite < 5) {
            layoutThrash.push({
              property: prop,
              timeSinceWrite: Math.round((now - lastStyleWrite) * 100) / 100,
              timestamp: Date.now(),
              stack: new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()).join(' <- '),
            });
          }
          return origGet.call(this);
        },
        configurable: true,
      });
      cleanups.push(() => {
        Object.defineProperty(HTMLElement.prototype, prop, desc);
      });
    }
  }

  function recordFn(name, durationMs) {
    if (!fnTimings[name]) {
      fnTimings[name] = { calls: 0, totalMs: 0, maxMs: 0 };
    }
    const t = fnTimings[name];
    t.calls++;
    t.totalMs += durationMs;
    if (durationMs > t.maxMs) t.maxMs = durationMs;
  }

  // ===== 4. Memory Monitoring =====
  function snapshotMemory() {
    if (!performance.memory) return;
    memSnapshots.push({
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      timestamp: Date.now(),
    });
  }

  // ===== Report Generation =====
  function generateReport() {
    const report = { timestamp: new Date().toISOString() };

    // Slow functions sorted by total time
    const fns = Object.entries(fnTimings)
      .map(([name, t]) => ({ name, ...t, avgMs: t.totalMs / t.calls }))
      .sort((a, b) => b.totalMs - a.totalMs);

    // Long animation frames
    const sortedLoAF = [...longAnimFrames].sort((a, b) => b.duration - a.duration);

    // Memory trend
    let memoryLeak = null;
    if (memSnapshots.length >= 2) {
      const first = memSnapshots[0];
      const last = memSnapshots[memSnapshots.length - 1];
      const diff = last.usedJSHeapSize - first.usedJSHeapSize;
      memoryLeak = {
        startMB: Math.round(first.usedJSHeapSize / 1048576 * 10) / 10,
        endMB: Math.round(last.usedJSHeapSize / 1048576 * 10) / 10,
        diffMB: Math.round(diff / 1048576 * 10) / 10,
        leaking: diff > 5 * 1048576, // >5MB growth = likely leak
      };
    }

    report.summary = {
      longAnimationFrames: sortedLoAF.length,
      longTasks: longTasks.length,
      trackedFunctions: fns.length,
      layoutThrashEvents: layoutThrash.length,
      memoryLeak,
    };

    report.slowestFunctions = fns.slice(0, 15);
    report.longAnimationFrames = sortedLoAF.slice(0, 10);
    report.longTasks = longTasks.slice(0, 10);
    report.layoutThrashing = layoutThrash.slice(0, 10);
    report.memorySnapshots = memSnapshots;

    return report;
  }

  function printReport(report) {
    console.log('\n');
    console.log('%c╔══════════════════════════════════════════╗', 'color: #ff6b6b; font-size: 14px; font-weight: bold');
    console.log('%c║     🔍 דוח ביצועים - window.check()     ║', 'color: #ff6b6b; font-size: 14px; font-weight: bold');
    console.log('%c╚══════════════════════════════════════════╝', 'color: #ff6b6b; font-size: 14px; font-weight: bold');

    // Summary
    const s = report.summary;
    console.log('\n%c📊 סיכום:', 'color: #4ecdc4; font-size: 13px; font-weight: bold');
    console.log(`   פריימים ארוכים (LoAF): ${s.longAnimationFrames}`);
    console.log(`   חסימות Main Thread:    ${s.longTasks}`);
    console.log(`   פונקציות שנמדדו:       ${s.trackedFunctions}`);
    console.log(`   אירועי Layout Thrash:  ${s.layoutThrashEvents}`);
    if (s.memoryLeak) {
      const ml = s.memoryLeak;
      console.log(`   זיכרון: ${ml.startMB}MB → ${ml.endMB}MB (${ml.diffMB > 0 ? '+' : ''}${ml.diffMB}MB) ${ml.leaking ? '🚨 דליפת זיכרון!' : '✅'}`);
    }

    // Slowest functions
    if (report.slowestFunctions.length > 0) {
      console.log('\n%c🐌 הפונקציות האיטיות ביותר:', 'color: #ff6b6b; font-size: 13px; font-weight: bold');
      console.table(report.slowestFunctions.map(f => ({
        'פונקציה': f.name,
        'קריאות': f.calls,
        'סה"כ (ms)': Math.round(f.totalMs * 10) / 10,
        'מקסימום (ms)': Math.round(f.maxMs * 10) / 10,
        'ממוצע (ms)': Math.round(f.avgMs * 100) / 100,
      })));
    }

    // Long Animation Frames
    if (report.longAnimationFrames.length > 0) {
      console.log('\n%c🎞️ פריימים ארוכים (LoAF):', 'color: #ffd93d; font-size: 13px; font-weight: bold');
      for (const frame of report.longAnimationFrames) {
        console.log(`   ⏱️ ${frame.duration}ms (חסימה: ${frame.blockingDuration}ms, layout כפוי: ${frame.forcedLayoutDuration}ms)`);
        for (const script of frame.scripts) {
          console.log(`      📜 ${script.name} - ${script.duration}ms ${script.forcedLayout ? `(layout: ${script.forcedLayout}ms)` : ''}`);
          if (script.invoker) console.log(`         מופעל ע"י: ${script.invoker}`);
          if (script.sourceURL) console.log(`         מקור: ${script.sourceURL}`);
        }
      }
    }

    // Long Tasks
    if (report.longTasks.length > 0) {
      console.log('\n%c🔥 חסימות Main Thread (Long Tasks):', 'color: #ff9f1c; font-size: 13px; font-weight: bold');
      console.table(report.longTasks.map(t => ({
        'משך (ms)': t.duration,
        'התחלה (ms)': t.startTime,
      })));
    }

    // Layout Thrashing
    if (report.layoutThrashing.length > 0) {
      console.log('\n%c💥 Layout Thrashing (קריאת layout אחרי כתיבת style):', 'color: #e63946; font-size: 13px; font-weight: bold');
      for (const lt of report.layoutThrashing) {
        console.log(`   📐 ${lt.property} - נקרא ${lt.timeSinceWrite}ms אחרי כתיבת style`);
        if (lt.stack) console.log(`      ${lt.stack}`);
      }
    }

    console.log('\n%c✅ סוף הדוח. להצגה חוזרת: window.check.report()', 'color: #2ec4b6; font-size: 12px');
    console.log('%c💡 טיפ: הרץ window.check(15) למדידה של 15 שניות', 'color: #888; font-size: 11px');
    console.log('\n');

    return report;
  }

  // ===== Main API =====
  function check(durationSec) {
    if (running) {
      console.log('[check] כבר רץ! השתמש ב-window.check.stop() לעצירה');
      return;
    }

    durationSec = durationSec || 5;
    running = true;
    reset();

    console.log(`%c🔍 מתחיל מדידת ביצועים ל-${durationSec} שניות...`, 'color: #4ecdc4; font-size: 14px; font-weight: bold');
    console.log('%c   תפעיל את הכפתורים כרגיל - אני מודד הכל!', 'color: #888');

    // Start all observers
    observeLoAF();
    observeLongTasks();
    patchFunctions();

    // Memory snapshots every 500ms
    snapshotMemory();
    const memInterval = setInterval(snapshotMemory, 500);

    // Auto-stop timer
    const timer = setTimeout(() => {
      check.stop();
    }, durationSec * 1000);

    check.stop = function () {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      clearInterval(memInterval);
      snapshotMemory();

      // Disconnect observers
      observers.forEach(o => o.disconnect());
      observers = [];

      // Restore patched functions
      cleanups.forEach(fn => { try { fn(); } catch (e) { } });
      cleanups = [];

      // Generate and print report
      results = generateReport();
      printReport(results);
    };
  }

  check.stop = function () { console.log('[check] לא רץ כרגע'); };
  check.report = function () {
    if (!results) { console.log('[check] אין דוח - הרץ window.check() קודם'); return; }
    return printReport(results);
  };

  window.check = check;

  console.log('%c✅ window.check() מוכן!', 'color: #2ec4b6; font-size: 12px');
  console.log('%c   הרץ window.check() בקונסולה להתחלת מדידה', 'color: #888; font-size: 11px');
})();
