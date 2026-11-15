// Button assignments. Each button is 4 bytes in the profile:
//   0x80 0x01 hi lo    mouse button bit mask
//   0x80 0x02 mod key  keyboard usage with modifier bits
//   0x80 0x03 hi lo    consumer usage
//   0x90 fn  ff ff     device function (DPI shift, G-Shift, ...)
(function (OMM) {
  'use strict';

  const YELLOW = '#D29F04';
  const RED = '#CD0535';

  const FN = {
    NONE: 0, TILT_LEFT: 1, TILT_RIGHT: 2, NEXT_DPI: 3, PREVIOUS_DPI: 4, CYCLE_DPIS: 5, DEFAULT_DPI: 6,
    DPI_SHIFT: 7, NEXT_PROFILE: 8, PREVIOUS_PROFILE: 9, CYCLE_PROFILES: 10, G_SHIFT: 11,
    ENABLE_PROFILE: 13, PERFORMANCE_MODE: 14, HOST_BUTTON: 15, SCROLL_DOWN: 16, SCROLL_UP: 17,
  };

  const FN_TITLES = {
    1: 'Tilt Left', 2: 'Tilt Right', 3: 'Next DPI', 4: 'Previous DPI', 5: 'Cycle DPIs', 6: 'Default DPI',
    7: 'DPI Shift', 8: 'Next Profile', 9: 'Previous Profile', 10: 'Cycle Profiles', 11: 'G-Shift',
    13: 'Enable Profile', 14: 'Toggle Performance Mode', 15: 'Host Button', 16: 'Scroll Down', 17: 'Scroll Up',
  };

  const CONSUMER_TITLES = {
    0xb5: 'Next Track', 0xb6: 'Previous Track', 0xb7: 'Stop', 0xcd: 'Play / Pause', 0xe2: 'Mute',
    0xe9: 'Volume Up', 0xea: 'Volume Down', 0xb0: 'Play', 0xb1: 'Pause',
  };

  // Keyboard usage page (0x07): KeyboardEvent.code -> [usage, label]
  const KEYS = {
    Enter: [40, 'Enter'], Escape: [41, 'Escape'], Backspace: [42, 'Backspace'], Tab: [43, 'Tab'],
    Space: [44, 'Space'], Minus: [45, '-'], Equal: [46, '='], BracketLeft: [47, '['], BracketRight: [48, ']'],
    Backslash: [49, '\\'], Semicolon: [51, ';'], Quote: [52, "'"], Backquote: [53, '`'], Comma: [54, ','],
    Period: [55, '.'], Slash: [56, '/'], CapsLock: [57, 'Caps Lock'], PrintScreen: [70, 'Print Screen'],
    ScrollLock: [71, 'Scroll Lock'], Pause: [72, 'Pause'], Insert: [73, 'Insert'], Home: [74, 'Home'],
    PageUp: [75, 'Page Up'], Delete: [76, 'Delete'], End: [77, 'End'], PageDown: [78, 'Page Down'],
    ArrowRight: [79, 'Right Arrow'], ArrowLeft: [80, 'Left Arrow'], ArrowDown: [81, 'Down Arrow'],
    ArrowUp: [82, 'Up Arrow'], NumLock: [83, 'Num Lock'], NumpadDivide: [84, 'Num /'],
    NumpadMultiply: [85, 'Num *'], NumpadSubtract: [86, 'Num -'], NumpadAdd: [87, 'Num +'],
    NumpadEnter: [88, 'Num Enter'], Numpad0: [98, 'Num 0'], NumpadDecimal: [99, 'Num .'],
    IntlBackslash: [100, '<'], ContextMenu: [101, 'Menu'],
    ControlLeft: [224, 'Left Control'], ShiftLeft: [225, 'Left Shift'], AltLeft: [226, 'Left Alt'],
    MetaLeft: [227, 'Left Win'], ControlRight: [228, 'Right Control'], ShiftRight: [229, 'Right Shift'],
    AltRight: [230, 'Right Alt'], MetaRight: [231, 'Right Win'],
  };
  for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = [4 + i, String.fromCharCode(65 + i)];
  for (let i = 1; i <= 9; i++) {
    KEYS['Digit' + i] = [29 + i, String(i)];
    KEYS['Numpad' + i] = [88 + i, 'Num ' + i];
  }
  KEYS.Digit0 = [39, '0'];
  for (let i = 1; i <= 12; i++) KEYS['F' + i] = [57 + i, 'F' + i];
  for (let i = 13; i <= 24; i++) KEYS['F' + i] = [91 + i, 'F' + i];

  const KEY_LABELS = {};
  for (const code in KEYS) KEY_LABELS[KEYS[code][0]] = KEYS[code][1];

  // Media keys the browser reports as key events: code -> consumer usage
  const MEDIA_CODES = {
    MediaPlayPause: 0xcd, MediaTrackNext: 0xb5, MediaTrackPrevious: 0xb6, MediaStop: 0xb7,
    AudioVolumeMute: 0xe2, AudioVolumeUp: 0xe9, AudioVolumeDown: 0xea,
  };

  const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

  const mouse = (mask) => [0x80, 0x01, mask >> 8, mask & 0xff];
  const key = (usage, mod) => [0x80, 0x02, mod || 0, usage];
  const consumer = (usage) => [0x80, 0x03, usage >> 8, usage & 0xff];
  const fn = (code) => [0x90, code, 0xff, 0xff];

  // Decode the 4 stored bytes into the fields that matter for the given behavior
  function parse(b) {
    let behavior = b[0] & 0xf0;
    if (b[0] === 0xff || (b[0] === 0 && b[1] === 0)) behavior = 0xff;
    if (behavior === 0x80) {
      if (b[1] === 1) return { behavior, op: 1, value: (b[2] << 8) | b[3] };
      if (b[1] === 2) return { behavior, op: 2, mod: b[2], value: b[3] };
      if (b[1] === 3) return { behavior, op: 3, value: (b[2] << 8) | b[3] };
      return { behavior, op: b[1], value: 0 };
    }
    if (behavior === 0x90) return { behavior, op: b[1], value: 0 };
    if (behavior === 0x00 || behavior === 0x10) {
      return { behavior, op: 0, value: (((b[0] & 0x0f) << 8) | b[1]) * 65536 + ((b[2] << 8) | b[3]) };
    }
    return { behavior, op: 0, value: 0 };
  }

  // Two assignments are the same action when their ids match
  function id(b) {
    const a = parse(b);
    return a.behavior + ':' + a.op + ':' + (a.mod || 0) + ':' + a.value;
  }

  function isFn(b, code) {
    const a = parse(b);
    return a.behavior === 0x90 && a.op === code;
  }

  function isProfileCycling(b) {
    return isFn(b, FN.CYCLE_PROFILES) || isFn(b, FN.NEXT_PROFILE) || isFn(b, FN.PREVIOUS_PROFILE);
  }

  function modifierText(mod) {
    const parts = [];
    if (mod & 0x11) parts.push('Control');
    if (mod & 0x44) parts.push('Alt');
    if (mod & 0x88) parts.push('Win');
    if (mod & 0x22) parts.push('Shift');
    return parts.join(' ');
  }

  function title(b) {
    const a = parse(b);
    if (a.behavior === 0x00) return 'Macro not supported';
    if (a.behavior === 0x10) return 'Stop Macro';
    if (a.behavior === 0x20) return 'Stop All Macros';
    if (a.behavior === 0x80) {
      if (a.op === 1) {
        switch (a.value) {
          case 0: return 'No Action';
          case 1: return 'Primary Click (Mouse 1)';
          case 2: return 'Secondary Click (Mouse 2)';
          case 4: return 'Middle Click (Mouse 3)';
          case 8: return 'Back Button Click (Mouse 4)';
          case 16: return 'Forward Button Click (Mouse 5)';
          default: return 'Click Mouse Button ' + a.value;
        }
      }
      if (a.op === 2) {
        const label = KEY_LABELS[a.value];
        if (!a.value || !label) return 'Empty';
        const mods = modifierText(a.mod);
        return mods ? mods + ' + ' + label : label;
      }
      if (a.op === 3) return CONSUMER_TITLES[a.value] || 'Media Key';
      return 'No Action';
    }
    if (a.behavior === 0x90) return FN_TITLES[a.op] || 'No Action';
    return 'No Action';
  }

  function color(b) {
    if (isFn(b, FN.DPI_SHIFT)) return YELLOW;
    if (isFn(b, FN.G_SHIFT)) return RED;
    return '';
  }

  // The fixed part of every assignment dropdown, in the order the vendor tool shows it
  function defaults(gshift) {
    const list = [
      mouse(1), mouse(2), mouse(4), mouse(8), mouse(16),
      consumer(0xcd), consumer(0xb6), consumer(0xb5), consumer(0xe2), consumer(0xe9), consumer(0xea),
      fn(FN.DPI_SHIFT), fn(FN.G_SHIFT), fn(FN.CYCLE_PROFILES), fn(FN.CYCLE_DPIS),
      fn(FN.TILT_LEFT), fn(FN.TILT_RIGHT), fn(FN.NONE),
    ];
    return gshift ? list.filter((b) => !isFn(b, FN.DPI_SHIFT) && !isFn(b, FN.G_SHIFT)) : list;
  }

  // Turn a keydown event into an assignment, or null while only modifiers are held
  function fromKeyEvent(e) {
    if (MEDIA_CODES[e.code]) return consumer(MEDIA_CODES[e.code]);
    const entry = KEYS[e.code];
    if (!entry) return null;
    if (MODIFIER_CODES.includes(e.code)) return null;
    let mod = 0;
    if (e.ctrlKey) mod |= 0x01;
    if (e.shiftKey) mod |= 0x02;
    if (e.altKey) mod |= 0x04;
    if (e.metaKey) mod |= 0x08;
    return key(entry[0], mod);
  }

  // A modifier pressed and released on its own becomes a plain key assignment
  function fromModifierCode(code) {
    return MODIFIER_CODES.includes(code) ? key(KEYS[code][0], 0) : null;
  }

  OMM.actions = { FN, parse, id, isFn, isProfileCycling, title, color, defaults, fromKeyEvent, fromModifierCode, mouse, key, consumer, fn };
})(globalThis.OMM = globalThis.OMM || {});
