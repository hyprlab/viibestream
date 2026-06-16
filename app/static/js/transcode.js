// In-browser transcode/remux for video files the <video> element can't
// decode natively (MKV, AVI, WMV, etc.). Wraps ffmpeg.wasm with a tiny
// API exposed as window.Viibestream.Transcode.
//
// Privacy: the file is never sent to a server. ffmpeg.wasm runs entirely
// in a Web Worker inside the user's browser; the only network requests
// are the one-time same-origin fetch of the wasm core (vendored under
// /static/js/vendor/ffmpeg/).

(function () {
  'use strict';

  window.Viibestream = window.Viibestream || {};
  var VENDOR_BASE = '/static/js/vendor/ffmpeg/';

  // Extension hints — exact match means "definitely needs transcode."
  // Anything else, we let the browser try first and fall back on error.
  var KNOWN_INCOMPATIBLE = [
    'mkv', 'avi', 'flv', 'wmv', 'ts', 'm2ts', 'mts',
    'mpg', 'mpeg', 'rm', 'rmvb', 'vob', '3gp', 'asf', 'divx', 'xvid'
  ];
  var KNOWN_COMPATIBLE = [
    'mp4', 'm4v', 'webm', 'mov', 'ogg', 'ogv'
  ];

  var ffmpegPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Lazy-load and initialise ffmpeg.wasm on first use. Subsequent calls
  // reuse the same FFmpeg instance.
  function getFFmpeg() {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (function () {
      return loadScript(VENDOR_BASE + 'ffmpeg.js').then(function () {
        if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
          throw new Error('ffmpeg.wasm wrapper failed to load.');
        }
        var ff = new window.FFmpegWASM.FFmpeg();
        return ff.load({
          classWorkerURL: new URL(VENDOR_BASE + '814.ffmpeg.js', location.href).href,
          coreURL:        new URL(VENDOR_BASE + 'ffmpeg-core.js', location.href).href,
          wasmURL:        new URL(VENDOR_BASE + 'ffmpeg-core.wasm', location.href).href,
        }).then(function () { return ff; });
      });
    })();
    return ffmpegPromise;
  }

  function nameExt(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  }

  // Heuristic: 'transcode' (definitely needs ffmpeg), 'native' (try the
  // browser first), or 'unknown' (try native, fall back on error).
  function classify(file) {
    var ext = nameExt(file.name);
    if (KNOWN_INCOMPATIBLE.indexOf(ext) !== -1) return 'transcode';
    if (KNOWN_COMPATIBLE.indexOf(ext)   !== -1) return 'native';
    return 'unknown';
  }

  // ffmpeg.wasm reads the input into its in-memory filesystem (MEMFS),
  // which means the whole file has to fit in browser RAM. V8 also
  // caps ArrayBuffer allocations at ~2 GB. Above 1.5 GB the chance of
  // OOM / RangeError is very high, so we bail out early with an
  // actionable message instead of crashing several minutes in.
  var MAX_TRANSCODE_BYTES = 1.5 * 1024 * 1024 * 1024;

  function tooLargeToTranscode(file) {
    return file && file.size > MAX_TRANSCODE_BYTES;
  }
  function formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(0) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  function tryNativeLoad(file) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      var url = URL.createObjectURL(file);
      var done = false;
      var settle = function (fn, arg) {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch (_) {}
        v.removeAttribute('src');
        try { v.load(); } catch (_) {}
        fn(arg);
      };
      v.addEventListener('loadedmetadata', function () { settle(resolve, true); }, { once: true });
      v.addEventListener('error',          function () { settle(reject, new Error('decode_failed')); }, { once: true });
      setTimeout(function () { settle(reject, new Error('decode_timeout')); }, 8000);
      v.src = url;
    });
  }

  // Run one ffmpeg attempt. Returns the output Uint8Array on success
  // (non-empty), or null on failure.
  function tryStrategy(ff, args, outputName) {
    return Promise.resolve()
      .then(function () { return ff.deleteFile(outputName).catch(function () {}); })
      .then(function () { return ff.exec(args); })
      .then(function (code) {
        if (code !== 0) return null;
        return ff.readFile(outputName).then(function (data) {
          if (!data || !data.length) return null;
          return data;
        });
      })
      .catch(function () { return null; });
  }

  // Transcode/remux a File into something the browser can play. The
  // strategies are tried in order from cheapest (stream copy) to most
  // expensive (full re-encode). Calls onProgress(0..1) periodically.
  function transcode(file, onProgress) {
    if (tooLargeToTranscode(file)) {
      return Promise.reject(new Error(
        'File is ' + formatSize(file.size) + '. In-browser transcoding ' +
        'maxes out around 1.5 GB because the whole file has to fit in ' +
        'browser memory. Re-encode it to MP4 first (HandBrake, or ' +
        '`ffmpeg -i in.mkv -c copy out.mp4` on the command line) and ' +
        'broadcast that.'
      ));
    }
    console.log('[viibestream] transcode: loading ffmpeg.wasm…');
    return getFFmpeg().then(function (ff) {
      console.log('[viibestream] transcode: ffmpeg loaded, writing input', file.name, formatSize(file.size));
      var inputName  = 'input.' + (nameExt(file.name) || 'bin');
      var outputName = 'output.mp4';

      var progressFn = function (info) {
        if (!onProgress) return;
        var p = info && typeof info.progress === 'number' ? info.progress : 0;
        if (p < 0) p = 0; if (p > 1) p = 1;
        onProgress(p);
      };
      ff.on('progress', progressFn);
      ff.on('log', function (info) { if (info && info.message) console.log('[ffmpeg]', info.message); });

      // Write the user's file into ffmpeg's in-memory filesystem.
      return file.arrayBuffer().catch(function () {
        throw new Error('Could not read the file into memory (it may be too large for the browser to allocate).');
      }).then(function (buf) {
        return ff.writeFile(inputName, new Uint8Array(buf));
      }).then(function () {
        console.log('[viibestream] transcode: trying strategy 1 (stream copy)…');
        // Strategy 1: stream-copy everything (fast remux, no re-encode).
        return tryStrategy(ff, [
          '-y', '-i', inputName,
          '-c', 'copy',
          '-movflags', '+faststart',
          outputName,
        ], outputName);
      }).then(function (data) {
        if (data) return data;
        console.log('[viibestream] transcode: trying strategy 2 (copy video, AAC audio)…');
        return tryStrategy(ff, [
          '-y', '-i', inputName,
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          outputName,
        ], outputName);
      }).then(function (data) {
        if (data) return data;
        console.log('[viibestream] transcode: trying strategy 3 (full re-encode)…');
        return tryStrategy(ff, [
          '-y', '-i', inputName,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          outputName,
        ], outputName);
      }).then(function (data) {
        console.log('[viibestream] transcode: done, output bytes:', data && data.length);
        ff.off('progress', progressFn);
        // Clean up MEMFS so we don't leak across multiple files.
        ff.deleteFile(inputName).catch(function () {});
        ff.deleteFile(outputName).catch(function () {});
        if (!data) throw new Error('ffmpeg could not transcode this file.');
        return new Blob([data], { type: 'video/mp4' });
      }).catch(function (err) {
        ff.off('progress', progressFn);
        ff.deleteFile(inputName).catch(function () {});
        ff.deleteFile(outputName).catch(function () {});
        throw err;
      });
    });
  }

  // Wrap a Blob back up so it looks like the original file to downstream
  // code that reads `file.name`.
  function blobAsFile(blob, originalName) {
    var base = originalName.replace(/\.[^./\\]+$/, '');
    try {
      return new File([blob], base + '.mp4', { type: 'video/mp4' });
    } catch (_) {
      // Older Safari without File constructor — fall back to a Blob with
      // a `name` property tacked on; the rest of our code only reads it.
      blob.name = base + '.mp4';
      return blob;
    }
  }

  window.Viibestream.Transcode = {
    classify: classify,
    tryNativeLoad: tryNativeLoad,
    transcode: transcode,
    blobAsFile: blobAsFile,
  };
})();
