/**
 * window.check() - Performance Diagnostics Tool v2
 * 
 * מזהה בדיוק איזה פונקציה איטית - שם, קובץ, ושורה.
 * 
 * שימוש:
 *   window.check()        - מדידה 5 שניות
 *   window.check(10)      - מדידה 10 שניות
 *   window.check.stop()   - עצירה ידנית + דוח
 *   window.check.report() - הצגת דוח אחרון
 *   window.check.live()   - מצב חי - מדפיס כל פונקציה איטית ברגע שהיא קורית
 */
(function () {
  let running = false;
  let liveMode = false;
  let observers = [];
  let cleanups = [];
  let results = null;

  // Data
  let longAnimFrames = [];
  let longTasks = [];
  let fnTimings = {};
  let layoutThrash = [];
  let memSnapshots = [];
  let profilerTrace = null;

  // ===== Utilities =====

  // Parse Error.stack into structured frames
  function parseStack(stack) {
    if (!stack) return [];
    const frames = [];
    const lines = stack.split('\n');
    for (const line of lines) {
      // Chrome: "    at functionName (file:line:col)"
      // Chrome: "    at file:line:col"
      let m = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
      if (m) {
        frames.push({ fn: m[1], file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) });
        continue;
      }
      m = line.match(/at\s+(.+?):(\d+):(\d+)/);
      if (m) {
        frames.push({ fn: '(anonymous)', file: m[1], line: parseInt(m[2]), col: parseInt(m[3]) });
        continue;
      }
      // Firefox: "functionName@file:line:col"
      m = line.match(/^(.+?)@(.+?):(\d+):(\d+)/);
      if (m) {
        frames.push({ fn: m[1] || '(anonymous)', file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) });
      }
    }
    return frames;
  }

  // Get short filename from URL
  function shortFile(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.href);
      let path = u.pathname;
      // Remove hash/query
      path = path.split('?')[0].split('#')[0];
      // Get last 2 segments
      const parts = path.split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    } catch {
      return url.slice(-40);
    }
  }

  // Get caller info from Error.stack (skip N frames)
  function getCallerInfo(skipFrames) {
    const stack = new Error().stack;
    const frames = parseStack(stack);
    // Skip: Error, getCallerInfo, wrapper, ...
    const frame = frames[skipFrames || 3];
    if (!frame) return null;
    return {
      fn: frame.fn,
      file: shortFile(frame.file),
      fullFile: frame.file,
      line: frame.line,
      col: frame.col,
      location: `${shortFile(frame.file)}:${frame.line}`,
    };
  }

  function reset() {
    longAnimFrames = [];
    longTasks = [];
    fnTimings = {};
    layoutThrash = [];
    memSnapshots = [];
    profilerTrace = null;
    observers = [];
    cleanups = [];
  }

  // ===== 1. Long Animation Frames (LoAF) - exact source info =====
  function observeLoAF() {
    if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      console.warn('[check] ⚠️ LoAF לא נתמך - משתמש ב-longtask בלבד (נסה Chrome 123+)');
      return;
    }
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = (entry.scripts || []).map(s => ({
          // PerformanceScriptTiming fields
          functionName: s.sourceFunctionName || '(anonymous)',
          sourceURL: s.sourceURL || '',
          charPosition: s.sourceCharPosition ?? -1,
          invokerType: s.invokerType || '',
          invoker: s.invoker || '',
          duration: Math.round(s.duration),
          executionStart: Math.round(s.executionStart || 0),
          forcedLayout: Math.round(s.forcedStyleAndLayoutDuration || 0),
          pauseDuration: Math.round(s.pauseDuration || 0),
          // Derived
          file: shortFile(s.sourceURL),
          location: s.sourceURL ? `${shortFile(s.sourceURL)}:char${s.sourceCharPosition}` : '',
        }));

        const frameData = {
          duration: Math.round(entry.duration),
          blockingDuration: Math.round(entry.blockingDuration || 0),
          forcedLayoutDuration: Math.round(entry.forcedStyleAndLayoutDuration || 0),
          scripts,
          timestamp: Date.now(),
        };

        longAnimFrames.push(frameData);

        if (liveMode && scripts.length > 0) {
          console.log(`%c⚡ LoAF ${frameData.duration}ms`, 'color: #ff6b6b; font-weight: bold');
          for (const s of scripts) {
            console.log(`   📜 ${s.functionName} - ${s.duration}ms | ${s.location} | ${s.invokerType}: ${s.invoker}`);
          }
        }
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
          timestamp: Date.now(),
        });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    observers.push(obs);
  }

  // ===== 3. JS Self-Profiling API =====
  async function startSelfProfiler() {
    if (typeof Profiler === 'undefined') {
      console.warn('[check] ⚠️ JS Self-Profiling API לא זמין (צריך Document-Policy: js-profiling header)');
      return null;
    }
    try {
      const profiler = new Profiler({ sampleInterval: 10, maxBufferSize: 10000 });
      console.log('[check] ✅ JS Self-Profiler פעיל - דגימה כל 10ms');
      return profiler;
    } catch (e) {
      console.warn('[check] ⚠️ JS Self-Profiler נכשל:', e.message);
      return null;
    }
  }

  function processProfilerTrace(trace) {
    if (!trace || !trace.samples || !trace.frames) return [];
    const { samples, stacks, frames, resources } = trace;

    // Build hot function map
    const hotFns = {};

    for (const sample of samples) {
      let stackId = sample.stackId;
      while (stackId !== undefined && stackId !== null) {
        const stack = stacks[stackId];
        if (!stack) break;
        const frame = frames[stack.frameId];
        if (frame) {
          const resourceUrl = resources[frame.resourceId] || '';
          const key = `${frame.name || '(anonymous)'}|${resourceUrl}|${frame.line}`;
          if (!hotFns[key]) {
            hotFns[key] = {
              fn: frame.name || '(anonymous)',
              file: shortFile(resourceUrl),
              fullFile: resourceUrl,
              line: frame.line,
              col: frame.column,
              samples: 0,
            };
          }
          hotFns[key].samples++;
        }
        stackId = stack.parentId;
      }
    }

    return Object.values(hotFns)
      .sort((a, b) => b.samples - a.samples)
      .map(f => ({
        ...f,
        estimatedMs: f.samples * (trace.sampleInterval || 10),
        location: `${f.file}:${f.line}`,
      }));
  }

  // ===== 4. Smart Monkey-Patching with caller tracking =====
  function patchFunctions() {
    // Wrap all functions on the React fiber tree isn't practical,
    // so we patch the execution boundaries and capture stacks

    function recordFn(name, durationMs, callerInfo) {
      const key = callerInfo ? `${name} @ ${callerInfo.location}` : name;
      if (!fnTimings[key]) {
        fnTimings[key] = { calls: 0, totalMs: 0, maxMs: 0, name, caller: callerInfo };
      }
      const t = fnTimings[key];
      t.calls++;
      t.totalMs += durationMs;
      if (durationMs > t.maxMs) t.maxMs = durationMs;

      if (liveMode && durationMs > 16) {
        const loc = callerInfo ? ` | ${callerInfo.fn} @ ${callerInfo.location}` : '';
        console.log(`%c🐌 ${name} ${Math.round(durationMs)}ms${loc}`, 'color: #ffd93d');
      }
    }

    // setTimeout
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (cb, delay, ...args) {
      if (typeof cb !== 'function') return origSetTimeout.call(window, cb, delay, ...args);
      const callerInfo = getCallerInfo(2);
      return origSetTimeout.call(window, function () {
        const start = performance.now();
        const result = cb.apply(this, args);
        const dur = performance.now() - start;
        if (dur > 2) recordFn(`setTimeout(${delay}ms)`, dur, callerInfo);
        return result;
      }, delay);
    };
    cleanups.push(() => { window.setTimeout = origSetTimeout; });

    // setInterval
    const origSetInterval = window.setInterval;
    window.setInterval = function (cb, delay, ...args) {
      if (typeof cb !== 'function') return origSetInterval.call(window, cb, delay, ...args);
      const callerInfo = getCallerInfo(2);
      return origSetInterval.call(window, function () {
        const start = performance.now();
        const result = cb.apply(this, args);
        const dur = performance.now() - start;
        if (dur > 1) recordFn(`setInterval(${delay}ms)`, dur, callerInfo);
        return result;
      }, delay);
    };
    cleanups.push(() => { window.setInterval = origSetInterval; });

    // requestAnimationFrame
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      const callerInfo = getCallerInfo(2);
      return origRAF.call(window, function (ts) {
        const start = performance.now();
        const result = cb(ts);
        const dur = performance.now() - start;
        if (dur > 2) recordFn('requestAnimationFrame', dur, callerInfo);
        return result;
      });
    };
    cleanups.push(() => { window.requestAnimationFrame = origRAF; });

    // Event listeners - capture handler name + caller location
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (typeof listener !== 'function') {
        return origAddEventListener.call(this, type, listener, options);
      }
      const callerInfo = getCallerInfo(2);
      const handlerName = listener.name || '(anonymous)';
      const wrapped = function (event) {
        const start = performance.now();
        const result = listener.call(this, event);
        const dur = performance.now() - start;
        if (dur > 2) {
          const target = event?.target;
          const tag = target?.tagName?.toLowerCase() || '';
          const id = target?.id ? `#${target.id}` : '';
          const cls = !id && target?.className ? `.${String(target.className).split(' ')[0]}` : '';
          recordFn(`${type}:${handlerName} on <${tag}${id}${cls}>`, dur, callerInfo);
        }
        return result;
      };
      return origAddEventListener.call(this, type, wrapped, options);
    };
    cleanups.push(() => { EventTarget.prototype.addEventListener = origAddEventListener; });

    // Fetch/XHR timing
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const callerInfo = getCallerInfo(2);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const start = performance.now();
      return origFetch.apply(window, args).then(res => {
        const dur = performance.now() - start;
        if (dur > 50) recordFn(`fetch(${shortFile(url)})`, dur, callerInfo);
        return res;
      });
    };
    cleanups.push(() => { window.fetch = origFetch; });

    // Layout thrashing detection with exact location
    const layoutProps = ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft',
      'clientHeight', 'clientWidth', 'scrollHeight', 'scrollWidth'];
    let lastStyleWrite = 0;
    let lastStyleWriteCaller = null;

    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
      lastStyleWrite = performance.now();
      lastStyleWriteCaller = getCallerInfo(2);
      return origSetProp.apply(this, args);
    };
    cleanups.push(() => { CSSStyleDeclaration.prototype.setProperty = origSetProp; });

    // Also track direct style.X = Y via proxy on common properties
    const styleProps = ['width', 'height', 'top', 'left', 'transform', 'display', 'position', 'margin', 'padding'];
    for (const prop of styleProps) {
      const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
      if (!desc?.set) continue;
      const origSet = desc.set;
      Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
        set(val) {
          lastStyleWrite = performance.now();
          lastStyleWriteCaller = getCallerInfo(3);
          return origSet.call(this, val);
        },
        get: desc.get,
        configurable: true,
      });
      cleanups.push(() => { Object.defineProperty(CSSStyleDeclaration.prototype, prop, desc); });
    }

    for (const prop of layoutProps) {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      if (!desc?.get) continue;
      const origGet = desc.get;
      Object.defineProperty(HTMLElement.prototype, prop, {
        get() {
          const now = performance.now();
          if (now - lastStyleWrite < 10) {
            const readCaller = getCallerInfo(2);
            layoutThrash.push({
              property: prop,
              timeSinceWrite: Math.round((now - lastStyleWrite) * 100) / 100,
              writtenBy: lastStyleWriteCaller,
              readBy: readCaller,
              timestamp: Date.now(),
            });
            if (liveMode) {
              console.log(`%c💥 Layout Thrash: קריאת ${prop} אחרי כתיבת style`, 'color: #e63946',
                `\n   כתיבה: ${lastStyleWriteCaller?.fn} @ ${lastStyleWriteCaller?.location}`,
                `\n   קריאה: ${readCaller?.fn} @ ${readCaller?.location}`);
            }
          }
          return origGet.call(this);
        },
        configurable: true,
      });
      cleanups.push(() => { Object.defineProperty(HTMLElement.prototype, prop, desc); });
    }
  }

  // ===== 5. Memory =====
  function snapshotMemory() {
    if (!performance.memory) return;
    memSnapshots.push({
      usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10,
      totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576 * 10) / 10,
      timestamp: Date.now(),
    });
  }

  // ===== Report =====
  function generateReport() {
    const report = { timestamp: new Date().toISOString() };

    // Process function timings
    const fns = Object.entries(fnTimings)
      .map(([key, t]) => ({
        key,
        name: t.name,
        fn: t.caller?.fn || '',
        file: t.caller?.file || '',
        line: t.caller?.line || '',
        location: t.caller?.location || '',
        calls: t.calls,
        totalMs: Math.round(t.totalMs * 10) / 10,
        maxMs: Math.round(t.maxMs * 10) / 10,
        avgMs: Math.round((t.totalMs / t.calls) * 100) / 100,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    // LoAF
    const sortedLoAF = [...longAnimFrames].sort((a, b) => b.duration - a.duration);

    // Memory
    let memoryLeak = null;
    if (memSnapshots.length >= 2) {
      const first = memSnapshots[0];
      const last = memSnapshots[memSnapshots.length - 1];
      const diff = last.usedMB - first.usedMB;
      memoryLeak = { startMB: first.usedMB, endMB: last.usedMB, diffMB: Math.round(diff * 10) / 10, leaking: diff > 5 };
    }

    // Profiler results
    let profilerHotFns = [];
    if (profilerTrace) {
      profilerHotFns = processProfilerTrace(profilerTrace);
    }

    report.summary = {
      longAnimationFrames: sortedLoAF.length,
      longTasks: longTasks.length,
      trackedFunctions: fns.length,
      layoutThrashEvents: layoutThrash.length,
      selfProfilerAvailable: profilerHotFns.length > 0,
      memoryLeak,
    };

    report.slowestFunctions = fns.slice(0, 20);
    report.profilerHotFunctions = profilerHotFns.slice(0, 15);
    report.longAnimationFrames = sortedLoAF.slice(0, 10);
    report.longTasks = longTasks.slice(0, 10);
    report.layoutThrashing = layoutThrash.slice(0, 10);

    return report;
  }

  function printReport(report) {
    const c = (color, size = 13) => `color: ${color}; font-size: ${size}px; font-weight: bold`;

    console.log('\n');
    console.log('%c╔═══════════════════════════════════════════════╗', c('#ff6b6b', 14));
    console.log('%c║   🔍 דוח ביצועים מפורט - window.check() v2   ║', c('#ff6b6b', 14));
    console.log('%c╚═══════════════════════════════════════════════╝', c('#ff6b6b', 14));

    // Summary
    const s = report.summary;
    console.log('\n%c📊 סיכום:', c('#4ecdc4'));
    console.log(`   פריימים ארוכים (LoAF): ${s.longAnimationFrames}`);
    console.log(`   חסימות Main Thread:    ${s.longTasks}`);
    console.log(`   פונקציות שנמדדו:       ${s.trackedFunctions}`);
    console.log(`   אירועי Layout Thrash:  ${s.layoutThrashEvents}`);
    console.log(`   JS Self-Profiler:       ${s.selfProfilerAvailable ? '✅ פעיל' : '❌ לא זמין'}`);
    if (s.memoryLeak) {
      const ml = s.memoryLeak;
      console.log(`   זיכרון: ${ml.startMB}MB → ${ml.endMB}MB (${ml.diffMB > 0 ? '+' : ''}${ml.diffMB}MB) ${ml.leaking ? '🚨 דליפה!' : '✅'}`);
    }

    // === JS Self-Profiler results (most accurate) ===
    if (report.profilerHotFunctions.length > 0) {
      console.log('\n%c🎯 פונקציות חמות (JS Self-Profiler - הכי מדויק!):', c('#ff6b6b'));
      console.log('%c   שם פונקציה | קובץ:שורה | זמן משוער', 'color: #888');
      console.table(report.profilerHotFunctions.map(f => ({
        'פונקציה': f.fn,
        'קובץ': f.file,
        'שורה': f.line,
        'עמודה': f.col,
        'דגימות': f.samples,
        'זמן משוער (ms)': f.estimatedMs,
        'מיקום מלא': f.location,
      })));
    }

    // === Slowest functions (monkey-patched) ===
    if (report.slowestFunctions.length > 0) {
      console.log('\n%c🐌 פונקציות איטיות (מדידה ישירה):', c('#ffd93d'));
      console.table(report.slowestFunctions.map(f => ({
        'מה': f.name,
        'פונקציה קוראת': f.fn,
        'קובץ': f.file,
        'שורה': f.line,
        'סה"כ (ms)': f.totalMs,
        'מקסימום (ms)': f.maxMs,
        'קריאות': f.calls,
        'ממוצע (ms)': f.avgMs,
      })));
    }

    // === LoAF with script attribution ===
    if (report.longAnimationFrames.length > 0) {
      console.log('\n%c🎞️ פריימים ארוכים (LoAF) - עם מיקום מדויק:', c('#4ecdc4'));
      for (const frame of report.longAnimationFrames) {
        console.log(`\n   %c⏱️ ${frame.duration}ms (חסימה: ${frame.blockingDuration}ms, layout כפוי: ${frame.forcedLayoutDuration}ms)`, c('#4ecdc4', 12));
        if (frame.scripts.length === 0) {
          console.log('      (ללא פרטי סקריפט)');
        }
        for (const s of frame.scripts) {
          console.log(
            `      📜 %c${s.functionName}%c - ${s.duration}ms` +
            `${s.forcedLayout ? ` (layout כפוי: ${s.forcedLayout}ms)` : ''}` +
            `${s.pauseDuration ? ` (pause: ${s.pauseDuration}ms)` : ''}`,
            'color: #ff6b6b; font-weight: bold', 'color: inherit'
          );
          console.log(`         📁 קובץ: ${s.file} | מיקום: char ${s.charPosition}`);
          console.log(`         🔗 URL מלא: ${s.sourceURL}`);
          if (s.invoker) console.log(`         🎯 מופעל ע"י: ${s.invokerType} → ${s.invoker}`);
        }
      }
    }

    // === Layout Thrashing ===
    if (report.layoutThrashing.length > 0) {
      console.log('\n%c💥 Layout Thrashing - קריאת layout אחרי כתיבת style:', c('#e63946'));
      for (const lt of report.layoutThrashing) {
        console.log(`\n   📐 ${lt.property} - נקרא ${lt.timeSinceWrite}ms אחרי כתיבת style`);
        if (lt.writtenBy) {
          console.log(`      ✏️  כתיבה: %c${lt.writtenBy.fn}%c @ ${lt.writtenBy.location}`, 'color: #ff6b6b; font-weight: bold', 'color: inherit');
        }
        if (lt.readBy) {
          console.log(`      👁️  קריאה: %c${lt.readBy.fn}%c @ ${lt.readBy.location}`, 'color: #ffd93d; font-weight: bold', 'color: inherit');
        }
      }
    }

    // === Long Tasks ===
    if (report.longTasks.length > 0) {
      console.log('\n%c🔥 חסימות Main Thread:', c('#ff9f1c'));
      console.table(report.longTasks.map(t => ({ 'משך (ms)': t.duration, 'התחלה (ms)': t.startTime })));
    }

    console.log('\n%c═══════════════════════════════════════════════', 'color: #444');
    console.log('%c💡 טיפים:', c('#2ec4b6', 11));
    console.log('   • window.check.live() - מצב חי, מדפיס כל בעיה ברגע שקורית');
    console.log('   • window.check(20) - מדידה ארוכה יותר לתוצאות מדויקות');
    console.log('   • window.check.report() - הצגת דוח אחרון שוב');
    if (!report.summary.selfProfilerAvailable) {
      console.log('   • להפעלת JS Self-Profiler (שם+קובץ+שורה מדויקים):');
      console.log('     הוסף Header: Document-Policy: js-profiling');
      console.log('     ב-Vite: server.headers בקונפיג');
    }
    console.log('\n');

    return report;
  }

  // ===== Main API =====
  async function check(durationSec) {
    if (running) {
      console.log('[check] כבר רץ! window.check.stop() לעצירה');
      return;
    }

    durationSec = durationSec || 5;
    running = true;
    liveMode = false;
    reset();

    console.log(`%c🔍 מתחיל מדידת ביצועים ל-${durationSec} שניות...`, 'color: #4ecdc4; font-size: 14px; font-weight: bold');
    console.log('%c   תפעיל כפתורים - אני מודד הכל עם מיקום מדויק!', 'color: #888');

    observeLoAF();
    observeLongTasks();
    patchFunctions();

    // Try self-profiler
    let profiler = await startSelfProfiler();

    snapshotMemory();
    const memInterval = setInterval(snapshotMemory, 500);

    const timer = setTimeout(() => { check.stop(); }, durationSec * 1000);

    check.stop = async function () {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      clearInterval(memInterval);
      snapshotMemory();

      // Stop self-profiler
      if (profiler) {
        try {
          profilerTrace = await profiler.stop();
          console.log('[check] ✅ JS Self-Profiler - נאספו', profilerTrace?.samples?.length || 0, 'דגימות');
        } catch (e) {
          console.warn('[check] Self-Profiler stop failed:', e);
        }
      }

      observers.forEach(o => o.disconnect());
      observers = [];
      cleanups.forEach(fn => { try { fn(); } catch (e) { } });
      cleanups = [];

      results = generateReport();
      printReport(results);
    };
  }

  check.stop = function () { console.log('[check] לא רץ כרגע'); };
  check.report = function () {
    if (!results) { console.log('[check] אין דוח - הרץ window.check() קודם'); return; }
    return printReport(results);
  };

  // Live mode - continuous monitoring
  check.live = function () {
    if (running) {
      console.log('[check] כבר רץ! window.check.stop() לעצירה');
      return;
    }
    running = true;
    liveMode = true;
    reset();

    console.log('%c🔴 מצב חי - כל בעיית ביצועים תודפס ברגע שקורית', 'color: #e63946; font-size: 14px; font-weight: bold');
    console.log('%c   window.check.stop() לעצירה וקבלת דוח מסכם', 'color: #888');

    observeLoAF();
    observeLongTasks();
    patchFunctions();

    snapshotMemory();
    const memInterval = setInterval(snapshotMemory, 1000);

    check.stop = function () {
      if (!running) return;
      running = false;
      liveMode = false;
      clearInterval(memInterval);
      snapshotMemory();
      observers.forEach(o => o.disconnect());
      observers = [];
      cleanups.forEach(fn => { try { fn(); } catch (e) { } });
      cleanups = [];
      results = generateReport();
      printReport(results);
    };
  };

  window.check = check;

  console.log('%c✅ window.check() v2 מוכן!', 'color: #2ec4b6; font-size: 12px');
  console.log('%c   window.check()     - מדידה + דוח', 'color: #888; font-size: 11px');
  console.log('%c   window.check.live() - מצב חי', 'color: #888; font-size: 11px');
})();
