/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
  disposeFocusEvent,
  KeyborgFocusInEvent,
  KEYBORG_FOCUSIN,
  setupFocusEvent,
} from "./FocusEvent";
import { Disposable, WeakRefInstance } from "./WeakRefInstance";

interface WindowWithKeyborg extends Window {
  __keyborg?: {
    core: KeyborgCore;
    refs: { [id: string]: Keyborg };
  };
}

const _dismissTimeout = 500; // When a key from dismissKeys is pressed and the focus is not moved
// during _dismissTimeout time, dismiss the keyboard navigation mode.

let _lastId = 0;

export interface KeyborgProps {
  // Keys to be used to trigger keyboard navigation mode. By default, any key will trigger
  // it. Could be limited to, for example, just Tab (or Tab and arrow keys).
  triggerKeys?: number[];
  // Keys to be used to dismiss keyboard navigation mode using keyboard (in addition to
  // mouse clicks which dismiss it). For example, Esc could be used to dismiss.
  dismissKeys?: number[];
}

export type KeyborgCallback = (isNavigatingWithKeyboard: boolean) => void;

/**
 * Source of truth for all the keyborg core instances and the current keyboard navigation state
 */
export class KeyborgState {
  private __keyborgCoreRefs: { [id: string]: WeakRefInstance<KeyborgCore> } =
    {};
  private _isNavigatingWithKeyboard = false;

  add(keyborg: KeyborgCore): void {
    const id = keyborg.id;

    if (!(id in this.__keyborgCoreRefs)) {
      this.__keyborgCoreRefs[id] = new WeakRefInstance<KeyborgCore>(keyborg);
    }
  }

  remove(id: string): void {
    delete this.__keyborgCoreRefs[id];

    if (Object.keys(this.__keyborgCoreRefs).length === 0) {
      this._isNavigatingWithKeyboard = false;
    }
  }

  setVal(isNavigatingWithKeyboard: boolean): void {
    if (this._isNavigatingWithKeyboard === isNavigatingWithKeyboard) {
      return;
    }

    this._isNavigatingWithKeyboard = isNavigatingWithKeyboard;

    for (const id of Object.keys(this.__keyborgCoreRefs)) {
      const ref = this.__keyborgCoreRefs[id];
      const keyborg = ref.deref();

      if (keyborg) {
        keyborg.update(isNavigatingWithKeyboard);
      } else {
        this.remove(id);
      }
    }
  }

  getVal(): boolean {
    return this._isNavigatingWithKeyboard;
  }
}

const _state = new KeyborgState();

/**
 * Manages a collection of Keyborg instances in a window/document and updates keyborg state
 */
class KeyborgCore implements Disposable {
  readonly id: string;

  private _win?: WindowWithKeyborg;
  private _isMouseUsedTimer: number | undefined;
  private _dismissTimer: number | undefined;
  private _triggerKeys?: Set<number>;
  private _dismissKeys?: Set<number>;

  constructor(win: WindowWithKeyborg, props?: KeyborgProps) {
    this.id = "c" + ++_lastId;
    this._win = win;
    const doc = win.document;

    if (props) {
      const triggerKeys = props.triggerKeys;
      const dismissKeys = props.dismissKeys;

      if (triggerKeys?.length) {
        this._triggerKeys = new Set(triggerKeys);
      }

      if (dismissKeys?.length) {
        this._dismissKeys = new Set(dismissKeys);
      }
    }

    doc.addEventListener(KEYBORG_FOCUSIN, this._onFocusIn, true); // Capture!
    doc.addEventListener("mousedown", this._onMouseDown, true); // Capture!
    win.addEventListener("keydown", this._onKeyDown, true); // Capture!

    setupFocusEvent(win);

    _state.add(this);
  }

  dispose(): void {
    const win = this._win;

    if (win) {
      if (this._isMouseUsedTimer) {
        win.clearTimeout(this._isMouseUsedTimer);
        this._isMouseUsedTimer = undefined;
      }

      if (this._dismissTimer) {
        win.clearTimeout(this._dismissTimer);
        this._dismissTimer = undefined;
      }

      disposeFocusEvent(win);

      const doc = win.document;

      doc.removeEventListener(KEYBORG_FOCUSIN, this._onFocusIn, true); // Capture!
      doc.removeEventListener("mousedown", this._onMouseDown, true); // Capture!
      win.removeEventListener("keydown", this._onKeyDown, true); // Capture!

      delete this._win;

      _state.remove(this.id);
    }
  }

  isDisposed(): boolean {
    return !!this._win;
  }

  /**
   * Updates all keyborg instances with the keyboard navigation state
   */
  update(isNavigatingWithKeyboard: boolean): void {
    const keyborgs = this._win?.__keyborg?.refs;

    if (keyborgs) {
      for (const id of Object.keys(keyborgs)) {
        Keyborg.update(keyborgs[id], isNavigatingWithKeyboard);
      }
    }
  }

  private _onFocusIn = (e: KeyborgFocusInEvent) => {
    // When the focus is moved not programmatically and without keydown events,
    // it is likely that the focus is moved by screen reader (as it might swallow
    // the events when the screen reader shortcuts are used). The screen reader
    // usage is keyboard navigation.

    if (this._isMouseUsedTimer) {
      // There was a mouse event recently.
      return;
    }

    if (_state.getVal()) {
      return;
    }

    const details = e.details;

    if (!details.relatedTarget) {
      return;
    }

    if (
      details.isFocusedProgrammatically ||
      details.isFocusedProgrammatically === undefined
    ) {
      // The element is focused programmatically, or the programmatic focus detection
      // is not working.
      return;
    }

    _state.setVal(true);
  };

  private _onMouseDown = (e: MouseEvent): void => {
    if (
      e.buttons === 0 ||
      (e.clientX === 0 && e.clientY === 0 && e.screenX === 0 && e.screenY === 0)
    ) {
      // This is most likely an event triggered by the screen reader to perform
      // an action on an element, do not dismiss the keyboard navigation mode.
      return;
    }

    const win = this._win;

    if (win) {
      if (this._isMouseUsedTimer) {
        win.clearTimeout(this._isMouseUsedTimer);
      }

      this._isMouseUsedTimer = win.setTimeout(() => {
        delete this._isMouseUsedTimer;
      }, 1000); // Keeping the indication of the mouse usage for some time.
    }

    _state.setVal(false);
  };

  private _onKeyDown = (e: KeyboardEvent): void => {
    const isNavigatingWithKeyboard = _state.getVal();

    const keyCode = e.keyCode;
    const triggerKeys = this._triggerKeys;

    if (
      !isNavigatingWithKeyboard &&
      (!triggerKeys || triggerKeys.has(keyCode))
    ) {
      _state.setVal(true);
    } else if (isNavigatingWithKeyboard && this._dismissKeys?.has(keyCode)) {
      this._scheduleDismiss();
    }
  };

  private _scheduleDismiss(): void {
    const win = this._win;

    if (win) {
      if (this._dismissTimer) {
        win.clearTimeout(this._dismissTimer);
        this._dismissTimer = undefined;
      }

      const was = win.document.activeElement;

      this._dismissTimer = win.setTimeout(() => {
        this._dismissTimer = undefined;

        const cur = win.document.activeElement;

        if (was && cur && was === cur) {
          // Esc was pressed, currently focused element hasn't changed.
          // Just dismiss the keyboard navigation mode.
          _state.setVal(false);
        }
      }, _dismissTimeout);
    }
  }
}

/**
 * Used to determine the keyboard navigation state
 */
export class Keyborg {
  private _id: string;
  private _win?: WindowWithKeyborg;
  private _core?: KeyborgCore;
  private _cb: KeyborgCallback[] = [];

  static create(win: WindowWithKeyborg, props?: KeyborgProps): Keyborg {
    return new Keyborg(win, props);
  }

  static dispose(instance: Keyborg): void {
    instance.dispose();
  }

  /**
   * Updates all subscribed callbacks with the keyboard navigation state
   */
  static update(instance: Keyborg, isNavigatingWithKeyboard: boolean): void {
    instance._cb.forEach((callback) => callback(isNavigatingWithKeyboard));
  }

  private constructor(win: WindowWithKeyborg, props?: KeyborgProps) {
    this._id = "k" + ++_lastId;
    this._win = win;

    const current = win.__keyborg;

    if (current) {
      this._core = current.core;
      current.refs[this._id] = this;
    } else {
      this._core = new KeyborgCore(win, props);
      win.__keyborg = {
        core: this._core,
        refs: { [this._id]: this },
      };
    }
  }

  private dispose(): void {
    const current = this._win?.__keyborg;

    if (current?.refs[this._id]) {
      delete current.refs[this._id];

      if (Object.keys(current.refs).length === 0) {
        current.core.dispose();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        delete this._win!.__keyborg;
      }
    } else if (__DEV__) {
      console.error(
        `Keyborg instance ${this._id} is being disposed incorrectly.`
      );
    }

    this._cb = [];
    delete this._core;
    delete this._win;
  }

  /**
   * @returns Whether the user is navigating with keyboard
   */
  isNavigatingWithKeyboard(): boolean {
    return _state.getVal();
  }

  /**
   * @param callback - Called when the keyboard navigation state changes
   */
  subscribe(callback: KeyborgCallback): void {
    this._cb.push(callback);
  }

  /**
   * @param callback - Registered with subscribe
   */
  unsubscribe(callback: KeyborgCallback): void {
    const index = this._cb.indexOf(callback);

    if (index >= 0) {
      this._cb.splice(index, 1);
    }
  }

  /**
   * Manually set the keyboard navigtion state
   */
  setVal(isNavigatingWithKeyboard: boolean): void {
    _state.setVal(isNavigatingWithKeyboard);
  }
}

export function createKeyborg(win: Window, props?: KeyborgProps): Keyborg {
  return Keyborg.create(win, props);
}

export function disposeKeyborg(instance: Keyborg) {
  Keyborg.dispose(instance);
}
