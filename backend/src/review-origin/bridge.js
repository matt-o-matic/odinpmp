/*
 * Odin review bridge. The review origin injects this script into every HTML document it
 * serves from a review package. It runs inside a sandboxed, opaque-origin frame and talks
 * to the Odin app (the parent window) with postMessage only.
 *
 * Messages to the parent always carry `source: 'odin-review-bridge'` and `version: 1`, and
 * are posted only to an allowed app origin. Commands from the parent are accepted only
 * when `event.source === window.parent`.
 *
 * The server replaces the configuration argument at the bottom of this file.
 */
(function (config) {
  'use strict';

  if (window.OdinReview && window.OdinReview.bridge === true) return;

  var SOURCE = 'odin-review-bridge';
  var VERSION = 1;
  var ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var CAPTURE_TIMEOUT_MS = 20000;
  var MAX_INLINE_BYTES = 8 * 1024 * 1024;
  var allowedOrigins = (config && Array.isArray(config.allowedParentOrigins)) ? config.allowedParentOrigins.slice() : [];

  // ---------------------------------------------------------------------------
  // Parent origin
  // ---------------------------------------------------------------------------

  function resolveParentOrigin() {
    if (window.parent === window) return null;
    var requested = null;
    try {
      requested = new URLSearchParams(location.search).get('odin-parent');
    } catch (_error) {
      requested = null;
    }
    if (requested && allowedOrigins.indexOf(requested) !== -1) return requested;
    var ancestors = location.ancestorOrigins;
    if (ancestors && ancestors.length > 0 && allowedOrigins.indexOf(ancestors[0]) !== -1) return ancestors[0];
    if (allowedOrigins.length === 1) return allowedOrigins[0];
    return null;
  }

  var parentOrigin = resolveParentOrigin();

  function post(message) {
    if (!parentOrigin) return;
    message.source = SOURCE;
    message.version = VERSION;
    try {
      window.parent.postMessage(message, parentOrigin);
    } catch (_error) {
      // The parent navigated away or the origin no longer matches; nothing to report to.
    }
  }

  // ---------------------------------------------------------------------------
  // State, viewport, and scroll
  // ---------------------------------------------------------------------------

  // Package URLs look like /p/<packageId>/<grant>/<path>. The grant changes per viewer and
  // over time, so state keys use only the path inside the package.
  var basePrefix = (location.pathname.match(/^\/p\/[^/]+\/[^/]+\//) || ['/'])[0];

  function packagePath() {
    var raw = location.pathname.indexOf(basePrefix) === 0 ? location.pathname.slice(basePrefix.length) : location.pathname;
    try {
      return decodeURIComponent(raw);
    } catch (_error) {
      return raw;
    }
  }

  var declaredKey = null;
  var stateTimer = null;

  function currentState() {
    var path = packagePath();
    return {
      declared: declaredKey !== null,
      hash: location.hash,
      key: declaredKey !== null ? declaredKey : path + location.hash,
      path: path,
    };
  }

  function viewportInfo() {
    return {
      devicePixelRatio: window.devicePixelRatio || 1,
      height: window.innerHeight,
      width: window.innerWidth,
    };
  }

  function scrollInfo() {
    var root = document.scrollingElement || document.documentElement;
    return {
      height: root ? root.scrollHeight : 0,
      width: root ? root.scrollWidth : 0,
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
    };
  }

  var readySent = false;

  function reportState() {
    stateTimer = null;
    // Until `ready` goes out, the ready message carries the state itself.
    if (!readySent) return;
    var state = currentState();
    post({ declared: state.declared, hash: state.hash, key: state.key, path: state.path, type: 'state' });
  }

  // A prototype usually calls setState from its own hashchange handler. Waiting one task
  // lets that call win over the default path-plus-hash key.
  function scheduleState() {
    if (stateTimer !== null) clearTimeout(stateTimer);
    stateTimer = setTimeout(reportState, 0);
  }

  function onNavigation() {
    declaredKey = null;
    scheduleState();
  }

  window.addEventListener('hashchange', onNavigation);
  window.addEventListener('popstate', onNavigation);

  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer !== null) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      post({ scroll: scrollInfo(), type: 'scroll' });
    }, 100);
  }, { passive: true });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      post({ scroll: scrollInfo(), type: 'viewport', viewport: viewportInfo() });
    }, 100);
  });

  function setState(key) {
    var value = String(key == null ? '' : key);
    if (!ID_PATTERN.test(value) || value.length > 64) {
      if (window.console && console.warn) console.warn('OdinReview.setState expects a state key like "pick-time".');
      return false;
    }
    declaredKey = value;
    scheduleState();
    return true;
  }

  function sendReady() {
    readySent = true;
    var state = currentState();
    post({
      scroll: scrollInfo(),
      state: { declared: state.declared, hash: state.hash, key: state.key, path: state.path },
      type: 'ready',
      viewport: viewportInfo(),
    });
  }

  // ---------------------------------------------------------------------------
  // Element hints
  // ---------------------------------------------------------------------------

  function collapseText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function elementHint(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    var target = hit.closest ? (hit.closest('[data-odin-id]') || hit) : hit;
    var rect = target.getBoundingClientRect();
    return {
      box: { height: Math.round(rect.height), width: Math.round(rect.width), x: Math.round(rect.left), y: Math.round(rect.top) },
      odinId: target.getAttribute('data-odin-id') || null,
      tag: String(target.localName || target.tagName || '').toLowerCase(),
      text: collapseText(target.innerText !== undefined ? target.innerText : target.textContent),
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot capture: DOM -> SVG foreignObject -> canvas -> PNG
  // ---------------------------------------------------------------------------
  // The frame has an opaque origin, so every package file is cross-origin to it. Images,
  // fonts, and stylesheets are fetched with CORS (the review origin answers with
  // Access-Control-Allow-Origin: *) and inlined as data: URLs, which never taint a canvas.

  var XHTML_NS = 'http://www.w3.org/1999/xhtml';
  var SKIP_TAGS = { base: 1, head: 1, link: 1, meta: 1, noscript: 1, script: 1, style: 1, template: 1, title: 1 };
  var URL_PROPERTIES = ['background-image', 'border-image-source', 'list-style-image', 'mask-image', '-webkit-mask-image'];

  function sameOriginAsPackage(url) {
    try {
      var parsed = new URL(url, location.href);
      return parsed.protocol === location.protocol && parsed.host === location.host;
    } catch (_error) {
      return false;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsDataURL(blob);
    });
  }

  function createCaptureContext() {
    var cache = {};
    var budget = { bytes: 0 };
    return {
      inline: function (url) {
        if (!url || /^data:/i.test(url)) return Promise.resolve(url || null);
        var absolute;
        try {
          absolute = new URL(url, location.href).href;
        } catch (_error) {
          return Promise.resolve(null);
        }
        if (!sameOriginAsPackage(absolute)) return Promise.resolve(null);
        if (!cache[absolute]) {
          cache[absolute] = fetch(absolute, { cache: 'force-cache', credentials: 'omit', mode: 'cors' })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.blob();
            })
            .then(function (blob) {
              budget.bytes += blob.size;
              if (budget.bytes > MAX_INLINE_BYTES) return null;
              return blobToDataUrl(blob);
            })
            .catch(function () { return null; });
        }
        return cache[absolute];
      },
      text: function (url) {
        return fetch(url, { cache: 'force-cache', credentials: 'omit', mode: 'cors' })
          .then(function (response) { return response.ok ? response.text() : ''; })
          .catch(function () { return ''; });
      },
    };
  }

  var defaultStyles = {};
  var defaultsHost = null;
  var defaultsRoot = null;

  // Default values per tag come from probes inside a shadow root under a host reset with
  // `all: initial`. Page stylesheets do not reach into the shadow tree, so the probes see
  // only the user-agent stylesheet, which is all the snapshot image has.
  function defaultStyleFor(element) {
    var ns = element.namespaceURI || XHTML_NS;
    var cacheKey = ns + ' ' + element.localName;
    if (defaultStyles[cacheKey]) return defaultStyles[cacheKey];
    if (!defaultsHost) {
      defaultsHost = document.createElement('div');
      defaultsHost.setAttribute('aria-hidden', 'true');
      defaultsHost.style.setProperty('all', 'initial', 'important');
      defaultsHost.style.setProperty('display', 'none', 'important');
      document.documentElement.appendChild(defaultsHost);
      defaultsRoot = defaultsHost.attachShadow ? defaultsHost.attachShadow({ mode: 'open' }) : defaultsHost;
    }
    var probe = document.createElementNS(ns, element.localName);
    defaultsRoot.appendChild(probe);
    var computed = getComputedStyle(probe);
    var values = {};
    for (var index = 0; index < computed.length; index += 1) {
      values[computed[index]] = computed.getPropertyValue(computed[index]);
    }
    defaultsRoot.removeChild(probe);
    defaultStyles[cacheKey] = values;
    return values;
  }

  function releaseDefaultsHost() {
    if (defaultsHost && defaultsHost.parentNode) defaultsHost.parentNode.removeChild(defaultsHost);
    defaultsHost = null;
    defaultsRoot = null;
  }

  function skipProperty(name) {
    return name.indexOf('transition') === 0 || name.indexOf('animation') === 0 || name === 'will-change';
  }

  function urlsIn(value) {
    var found = [];
    var pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    var match;
    while ((match = pattern.exec(value)) !== null) found.push(match[2]);
    return found;
  }

  function copyStyle(source, target, computed, parentComputed, isRoot, ctx, tasks) {
    var defaults = defaultStyleFor(source);
    target.removeAttribute('style');
    for (var index = 0; index < computed.length; index += 1) {
      var name = computed[index];
      if (skipProperty(name)) continue;
      var value = computed.getPropertyValue(name);
      // Skip only what the clone reproduces on its own: the tag's default value that the
      // parent also has, so inheritance and the user-agent stylesheet give the same result.
      if (!isRoot && value === defaults[name] && parentComputed && parentComputed.getPropertyValue(name) === value) continue;
      target.style.setProperty(name, value, computed.getPropertyPriority(name));
    }
    URL_PROPERTIES.forEach(function (name) {
      var value = computed.getPropertyValue(name);
      if (!value || value.indexOf('url(') === -1) return;
      var urls = urlsIn(value);
      tasks.push(Promise.all(urls.map(function (url) { return ctx.inline(url); })).then(function (inlined) {
        var next = value;
        urls.forEach(function (url, position) {
          next = next.split(url).join(inlined[position] || '');
        });
        if (inlined.some(function (item) { return !item; })) next = 'none';
        target.style.setProperty(name, next);
      }));
    });
  }

  var pseudoCounter = 0;

  function clonePseudo(source, target, pseudo, rules) {
    var computed = getComputedStyle(source, pseudo);
    var content = computed.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal') return;
    pseudoCounter += 1;
    var className = 'odin-snapshot-' + pseudoCounter;
    var declarations = [];
    for (var index = 0; index < computed.length; index += 1) {
      var name = computed[index];
      if (skipProperty(name)) continue;
      var value = computed.getPropertyValue(name);
      if (name !== 'content' && value.indexOf('url(') !== -1) continue;
      declarations.push(name + ':' + value);
    }
    target.classList.add(className);
    rules.push('.' + className + pseudo + '{' + declarations.join(';') + '}');
  }

  function copyFormState(source, target) {
    var tag = source.localName;
    if (tag === 'input') {
      var type = String(source.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (source.checked) target.setAttribute('checked', ''); else target.removeAttribute('checked');
      } else if (type !== 'file' && type !== 'password') {
        target.setAttribute('value', source.value);
      }
    } else if (tag === 'textarea') {
      target.textContent = source.value;
    } else if (tag === 'select') {
      Array.prototype.forEach.call(target.options || [], function (option, index) {
        if (source.options[index] && source.options[index].selected) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      });
    }
  }

  function replacementBox(source, computed) {
    var box = document.createElementNS(XHTML_NS, 'div');
    var rect = source.getBoundingClientRect();
    box.style.setProperty('display', computed.getPropertyValue('display') === 'inline' ? 'inline-block' : computed.getPropertyValue('display'));
    box.style.setProperty('width', rect.width + 'px');
    box.style.setProperty('height', rect.height + 'px');
    return box;
  }

  function cloneElement(source, parentComputed, isRoot, ctx, tasks, rules) {
    if (source.nodeType === 3) return document.createTextNode(source.nodeValue);
    if (source.nodeType !== 1) return null;
    var tag = source.localName;
    if (SKIP_TAGS[tag] || source === defaultsHost) return null;
    var computed = getComputedStyle(source);
    if (computed.getPropertyValue('display') === 'none') return null;

    var clone;
    if (tag === 'canvas') {
      clone = document.createElementNS(XHTML_NS, 'img');
      try {
        clone.setAttribute('src', source.toDataURL('image/png'));
      } catch (_error) {
        clone = replacementBox(source, computed);
      }
    } else if (tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'object' || tag === 'embed') {
      clone = replacementBox(source, computed);
      var poster = tag === 'video' ? source.getAttribute('poster') : null;
      if (poster) {
        tasks.push(ctx.inline(poster).then(function (dataUrl) {
          if (dataUrl) {
            clone.style.setProperty('background', 'center / cover no-repeat url("' + dataUrl + '")');
          }
        }));
      }
    } else {
      clone = source.cloneNode(false);
    }

    Array.prototype.slice.call(clone.attributes || []).forEach(function (attribute) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcset' || attribute.name === 'sizes' || attribute.name === 'loading') {
        clone.removeAttribute(attribute.name);
      }
    });

    copyStyle(source, clone, computed, parentComputed, isRoot, ctx, tasks);

    if (tag === 'img' && clone.localName === 'img' && source.localName === 'img') {
      var src = source.currentSrc || source.src;
      clone.removeAttribute('src');
      if (src) {
        tasks.push(ctx.inline(src).then(function (dataUrl) {
          if (dataUrl) clone.setAttribute('src', dataUrl);
        }));
      }
    } else if (tag === 'image' && source.namespaceURI === 'http://www.w3.org/2000/svg') {
      var href = source.getAttribute('href') || source.getAttribute('xlink:href');
      clone.removeAttribute('href');
      clone.removeAttribute('xlink:href');
      if (href) {
        tasks.push(ctx.inline(href).then(function (dataUrl) {
          if (dataUrl) clone.setAttribute('href', dataUrl);
        }));
      }
    }

    copyFormState(source, clone);
    clonePseudo(source, clone, '::before', rules);
    clonePseudo(source, clone, '::after', rules);

    if (clone.localName === tag && tag !== 'canvas') {
      var scrolledX = source.scrollLeft || 0;
      var scrolledY = source.scrollTop || 0;
      var isDocumentScroller = source === document.documentElement || source === document.body;
      var children = source.shadowRoot ? source.shadowRoot.childNodes : source.childNodes;
      for (var index = 0; index < children.length; index += 1) {
        if (tag === 'picture' && children[index].localName === 'source') continue;
        var childClone = cloneElement(children[index], computed, false, ctx, tasks, rules);
        if (!childClone) continue;
        if (!isDocumentScroller && (scrolledX || scrolledY) && childClone.nodeType === 1) {
          // Emulate an inner scroll position by shifting the children of the scroller.
          var existing = childClone.style.getPropertyValue('transform');
          childClone.style.setProperty('transform', 'translate(' + (-scrolledX) + 'px, ' + (-scrolledY) + 'px)' + (existing && existing !== 'none' ? ' ' + existing : ''));
        }
        clone.appendChild(childClone);
      }
    }
    return clone;
  }

  function collectFontCss(ctx) {
    var sources = [];
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var text = null;
      try {
        text = Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join('\n');
      } catch (_error) {
        text = null;
      }
      var base = sheet.href || location.href;
      if (text !== null) sources.push(Promise.resolve({ base: base, text: text }));
      else if (sheet.href && sameOriginAsPackage(sheet.href)) {
        sources.push(ctx.text(sheet.href).then(function (body) { return { base: base, text: body }; }));
      }
    });
    return Promise.all(sources).then(function (sheets) {
      var faces = [];
      sheets.forEach(function (sheet) {
        var blocks = sheet.text.match(/@font-face\s*\{[^}]*\}/g) || [];
        blocks.forEach(function (block) {
          faces.push(Promise.all(urlsIn(block).map(function (url) {
            var absolute;
            try {
              absolute = new URL(url, sheet.base).href;
            } catch (_error) {
              absolute = null;
            }
            return absolute ? ctx.inline(absolute).then(function (dataUrl) { return { dataUrl: dataUrl, url: url }; }) : { dataUrl: null, url: url };
          })).then(function (resolved) {
            var next = block;
            resolved.forEach(function (item) {
              next = next.split(item.url).join(item.dataUrl || 'about:invalid');
            });
            return next;
          }));
        });
      });
      return Promise.all(faces);
    }).then(function (blocks) { return blocks.join('\n'); });
  }

  function isTransparent(computed) {
    var color = computed.getPropertyValue('background-color');
    return (color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color)) && computed.getPropertyValue('background-image') === 'none';
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.decoding = 'sync';
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('The snapshot image could not be decoded.')); };
      image.src = url;
    });
  }

  function captureViewport(options) {
    var scale = Math.min(2, Math.max(0.25, Number(options && options.scale) || 1));
    var width = Math.max(1, window.innerWidth);
    var height = Math.max(1, window.innerHeight);
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    var ctx = createCaptureContext();
    var tasks = [];
    var rules = [];
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready.catch(function () {}) : Promise.resolve();

    return ready.then(function () {
      var root = cloneElement(document.documentElement, null, true, ctx, tasks, rules);
      var body = document.body ? root.querySelector('body') : null;
      if (body) {
        var bodyComputed = getComputedStyle(document.body);
        for (var index = 0; index < bodyComputed.length; index += 1) {
          var name = bodyComputed[index];
          if (!skipProperty(name) && !body.style.getPropertyValue(name)) body.style.setProperty(name, bodyComputed.getPropertyValue(name));
        }
      }
      releaseDefaultsHost();
      var scroller = document.scrollingElement || document.documentElement;
      var frame = document.createElementNS(XHTML_NS, 'div');
      frame.style.setProperty('position', 'relative');
      frame.style.setProperty('left', (-scrollX) + 'px');
      frame.style.setProperty('top', (-scrollY) + 'px');
      frame.style.setProperty('width', Math.max(width, scroller.scrollWidth) + 'px');
      frame.style.setProperty('height', Math.max(height, scroller.scrollHeight) + 'px');
      // The page background paints the whole viewport (CSS background propagation). Inside
      // the snapshot it would cover only the root box, so the frame carries it instead.
      var canvasSource = getComputedStyle(document.documentElement);
      if (isTransparent(canvasSource) && document.body) canvasSource = getComputedStyle(document.body);
      frame.style.setProperty('background-color', canvasSource.getPropertyValue('background-color'));
      frame.appendChild(root);
      return Promise.all([Promise.all(tasks), collectFontCss(ctx)]).then(function (results) {
        var css = (results[1] + '\n' + rules.join('\n')).replace(/\]\]>/g, ']] >');
        var markup = new XMLSerializer().serializeToString(frame);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">'
          + '<defs><style type="text/css"><![CDATA[' + css + ']]></style></defs>'
          + '<foreignObject x="0" y="0" width="' + width + '" height="' + height + '">' + markup + '</foreignObject></svg>';
        return loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      });
    }).then(function (image) {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      var context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL('image/png'), height: canvas.height, width: canvas.width };
    }, function (error) {
      releaseDefaultsHost();
      throw error;
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('The snapshot timed out.')); }, ms);
      promise.then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });
    });
  }

  // ---------------------------------------------------------------------------
  // Commands from the parent
  // ---------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || window.parent === window) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    var requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 80) : undefined;

    if (data.type === 'capture') {
      var state = currentState();
      var scroll = scrollInfo();
      withTimeout(captureViewport(data), CAPTURE_TIMEOUT_MS).then(function (result) {
        post({ dataUrl: result.dataUrl, height: result.height, requestId: requestId, scroll: scroll, stateKey: state.key, type: 'capture', width: result.width });
      }, function (error) {
        var reason = error && error.name === 'SecurityError'
          ? 'The browser blocked reading the snapshot.'
          : String((error && error.message) || error || 'The snapshot failed.').slice(0, 300);
        post({ reason: reason, requestId: requestId, type: 'capture-failed' });
      });
    } else if (data.type === 'hint') {
      var x = Number(data.x);
      var y = Number(data.y);
      var hint = Number.isFinite(x) && Number.isFinite(y) ? elementHint(x, y) : null;
      post({ hint: hint, requestId: requestId, type: 'hint', x: x, y: y });
    } else if (data.type === 'goto-state') {
      var key = String(data.key == null ? '' : data.key);
      if (!ID_PATTERN.test(key) || key.length > 64) return;
      if (location.hash === '#' + key) scheduleState();
      else location.hash = key;
    } else if (data.type === 'ping') {
      sendReady();
    }
  });

  var api = { bridge: true, setState: setState, version: VERSION };
  try {
    Object.defineProperty(window, 'OdinReview', { configurable: false, enumerable: false, value: Object.freeze(api), writable: false });
  } catch (_error) {
    window.OdinReview = api;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendReady, { once: true });
  } else {
    sendReady();
  }
})(/*__ODIN_BRIDGE_CONFIG__*/{ "allowedParentOrigins": [] });
