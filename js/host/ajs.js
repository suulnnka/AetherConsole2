/* js/host/ajs.js — aJS 运行环境(§12):JS 源码 + 主机注入环境
 * 环境注入而非虚拟机:以参数遮蔽全部宿主全局(DOM/网络/存储/真实时间/eval/Function),
 * 游戏代码可见的只有主机 API。无字节码、无指令预算、无内存上限(T6/T8/T9)。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  // 遮蔽名单:参数名传 undefined(词法遮蔽外层全局)
  const SHADOW = [
    'window', 'document', 'globalThis', 'self', 'parent', 'top', 'frames', 'opener',
    'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'origin',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'Worker', 'SharedWorker', 'importScripts', 'navigator', 'location', 'history',
    'eval', 'Function',
    'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
    'requestAnimationFrame', 'requestIdleCallback', 'cancelAnimationFrame', 'cancelIdleCallback',
    'queueMicrotask', 'postMessage', 'structuredClone',
    'Date', 'performance', 'console',
    'alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur', // print 由 env 提供(bios.print 语义)
    'crypto', 'Notification', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
    'Audio', 'Image', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
    'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
    'getComputedStyle', 'matchMedia', 'screen', 'innerWidth', 'innerHeight', 'devicePixelRatio',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
    'WebAssembly', 'Realm', 'FinalizationRegistry', 'WeakRef',
    'SharedArrayBuffer', 'Atomics', 'Reflect', 'Proxy'
  ];
  const SHADOW_PARAMS = Array.from(new Set(SHADOW)).filter(n => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));

  function compile(src, machine) {
    const pad = machine.input.pad, mouse = machine.input.mouse, A = machine.A || {}, bios = machine.biosApi || {};
    const cart = machine.cart;
    // 只读卡带视图
    const cartView = Object.freeze({
      id: cart.id, title: cart.title, version: cart.version, mode: cart.mode,
      seg: (t, i) => cart.seg(t, i),
      segs: (t) => cart.segs(t),
      data: (t, i) => { const s = cart.seg(t, i); return s ? s.data : null; },
      meta: cart.meta
    });

    const apiHit = (name) => {
      const dh = machine.debugHooks;
      if (dh && dh.apiBreaks && dh.apiBreaks.has(name) && dh.onApiCall) dh.onApiCall(name);
    };
    const env = {
      S: machine.S, R: machine.R, A: A || {},
      pad, mouse, bios,
      cart: cartView,
      save: (b) => { apiHit('save'); return machine.save(b); },
      load: () => { apiHit('load'); return machine.loadSave(); },
      frame: () => machine.frameCount,
      rng: (s) => machine.rng(s),
      print: (...a) => machine.biosPrint(...a),
      __bp: (line) => machine.lineBpCheck(line)   // 调试设备行断点插桩(无断点时空操作)
    };

    // 参数遮蔽宿主全局(注:严格模式禁止参数名 eval,故包裹层为 sloppy;
    // 隔离为"环境纪律"级 —— 规格定位本就不做安全沙箱,T6)
    const paramNames = Object.keys(env);
    const params = paramNames.concat(SHADOW_PARAMS);
    const body = instrumentLines(src) + '\n;return { init: (typeof init === "function") ? init : null, update: (typeof update === "function") ? update : null };';
    let fn;
    try {
      fn = new Function(...params, body);
    } catch (e) {
      const err = new Error('aJS 语法错误:' + e.message);
      machine._halt && machine._halt(err);
      throw err;
    }
    const args = paramNames.map(k => env[k]).concat(SHADOW_PARAMS.map(() => undefined));
    let exportsObj;
    try {
      exportsObj = fn(...args);
    } catch (e) {
      machine._halt && machine._halt(e);
      throw e;
    }
    return {
      init: exportsObj.init,
      update: exportsObj.update,
      env,
      src
    };
  }

  // 行断点插桩:语句行前插入 __bp(行号);续行/字符串/注释行跳过(保守过滤)
  function instrumentLines(src) {
    const lines = src.split('\n');
    let inBlockComment = false, prevOpen = false, inTemplate = false;
    return lines.map((line, i) => {
      const n = i + 1;
      const trimmed = line.trim();
      let out = line;
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return out;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return out;
      }
      if (trimmed.startsWith('//') || trimmed === '' || trimmed.startsWith('*')) return out;
      // 模板字符串续行(粗略:数反引号奇偶)
      const ticks = (line.match(/`/g) || []).length;
      if (inTemplate) {
        inTemplate = ticks % 2 === 1 ? false : true;
        return out;
      }
      if (ticks % 2 === 1) { inTemplate = true; return out; }
      const startsContinuation = /^[)\]}.,:?+\-*/%&|^<>=~]|^(?:\|\||&&|\?\.|else|in|of|case|default|instanceof)/.test(trimmed);
      const continuers = /[=(,([{+\-*/%&|^<>?:.)\`]$|\b(?:return|typeof|new|throw|else|do|in|of|case|=>)$/;

      if (!startsContinuation && !prevOpen) {
        out = '__bp(' + n + ');' + line;
      }

      const codeOnly = trimmed.replace(/\/\/.*$/, '').trimEnd();
      prevOpen = continuers.test(codeOnly);
      return out;
    }).join('\n');
  }

  AC2.AJS = { compile, SHADOW_PARAMS, instrumentLines };
})();
