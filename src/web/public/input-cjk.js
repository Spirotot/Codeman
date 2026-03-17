/**
 * @fileoverview CJK IME input for xterm.js terminal.
 *
 * Always-visible textarea below the terminal (in index.html).
 * The browser handles IME composition natively — we just read
 * textarea.value on Enter and send it to PTY.
 * While this textarea has focus, window.cjkActive = true blocks xterm's onData.
 * Arrow keys and function keys are forwarded to PTY directly.
 *
 * @dependency index.html (#cjkInput textarea)
 * @globals {object} CjkInput — window.cjkActive (boolean) signals app.js to block xterm onData
 * @loadorder 5.5 of 15 — loaded after keyboard-accessory.js, before app.js
 */

// eslint-disable-next-line no-unused-vars
const CjkInput = (() => {
  let _textarea = null;
  let _send = null;
  let _initialized = false;
  let _onMousedown = null;
  let _onFocus = null;
  let _onBlur = null;
  let _onKeydown = null;

  const PASSTHROUGH_KEYS = {
    ArrowUp:    '\x1b[A',
    ArrowDown:  '\x1b[B',
    ArrowLeft:  '\x1b[D',
    ArrowRight: '\x1b[C',
    Home:       '\x1b[H',
    End:        '\x1b[F',
    Tab:        '\t',
  };

  const CTRL_KEYS = {
    c: '\x03', d: '\x04', l: '\x0c', z: '\x1a', a: '\x01', e: '\x05',
  };

  return {
    init({ send }) {
      // Guard against double-init: remove previous listeners
      if (_initialized) this.destroy();

      _send = send;
      _textarea = document.getElementById('cjkInput');
      if (!_textarea) return this;

      _onMousedown = (e) => { e.stopPropagation(); };
      _onFocus = () => { window.cjkActive = true; };
      _onBlur = () => { window.cjkActive = false; };
      _textarea.addEventListener('mousedown', _onMousedown);
      _textarea.addEventListener('focus', _onFocus);
      _textarea.addEventListener('blur', _onBlur);

      _onKeydown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;

        // Enter: send accumulated text (or bare Enter if empty)
        if (e.key === 'Enter') {
          e.preventDefault();
          if (_textarea.value) {
            _send(_textarea.value + '\r');
            _textarea.value = '';
          } else {
            _send('\r');
          }
          return;
        }

        // Escape: clear textarea
        if (e.key === 'Escape') {
          e.preventDefault();
          _textarea.value = '';
          return;
        }

        // Ctrl combos: forward to PTY
        if (e.ctrlKey && CTRL_KEYS[e.key]) {
          e.preventDefault();
          _send(CTRL_KEYS[e.key]);
          return;
        }

        // Backspace: delete from textarea if has text, else forward to PTY
        if (e.key === 'Backspace' && !_textarea.value) {
          e.preventDefault();
          _send('\x7f');
          return;
        }

        // Arrow/function keys: forward to PTY when textarea is empty
        if (PASSTHROUGH_KEYS[e.key] && !_textarea.value) {
          e.preventDefault();
          _send(PASSTHROUGH_KEYS[e.key]);
          return;
        }
      };
      _textarea.addEventListener('keydown', _onKeydown);

      _initialized = true;
      return this;
    },

    destroy() {
      if (_textarea) {
        if (_onMousedown) _textarea.removeEventListener('mousedown', _onMousedown);
        if (_onFocus) _textarea.removeEventListener('focus', _onFocus);
        if (_onBlur) _textarea.removeEventListener('blur', _onBlur);
        if (_onKeydown) _textarea.removeEventListener('keydown', _onKeydown);
      }
      window.cjkActive = false;
      _onMousedown = _onFocus = _onBlur = _onKeydown = null;
      _initialized = false;
    },

    get element() { return _textarea; },
  };
})();
