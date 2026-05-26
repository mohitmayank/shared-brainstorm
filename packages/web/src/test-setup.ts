/**
 * Vitest setup file for packages/web/src tests (jsdom environment).
 *
 * Provides shims for browser APIs that jsdom 29 does not implement natively,
 * and a minimal React hook dispatcher for render-free component unit tests.
 */

import React from 'react';

// ---------------------------------------------------------------------------
// 1. document.execCommand shim
//
// jsdom 29 does not implement document.execCommand (deprecated in browsers,
// removed from jsdom in v22+). Define a no-op stub so vi.spyOn(document,
// 'execCommand') can attach to it in clipboard.test.ts. The real implementation
// is never called in tests — tests mock it via mockReturnValue(true/false).
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined' && typeof document.execCommand === 'undefined') {
  Object.defineProperty(document, 'execCommand', {
    value: (_command: string): boolean => false,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// 2. Minimal React hook dispatcher for render-free component tests
//
// Some unit tests call React function components directly as plain functions
// (render-free approach, no @testing-library/react) to inspect the JSX tree
// structure without a DOM render. This works for stateless components but
// fails for components that use hooks because React's dispatcher is null
// outside a render context.
//
// This shim installs a minimal "mount" dispatcher that makes useState /
// useRef / useEffect return stable initial values — enabling render-free
// inspection of the JSX tree shape and the onClick handler. It does NOT
// simulate actual React reconciliation or state updates; that is fine for
// branch-logic tests (onClick invocations) that don't depend on re-renders.
//
// Reference: React's internal dispatcher pattern (react/cjs/react.development.js)
// ---------------------------------------------------------------------------

// Access React internals via unknown cast to avoid TypeScript errors on the
// private __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED field.
// ESM-only project invariant: static import, not require().
const reactInternals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    ReactCurrentDispatcher: { current: unknown };
  };
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

// A minimal dispatcher that returns hook initial values.
// useState returns [initialState, noop-setter] — tests call onClick directly,
// state updates via setCopied do not trigger re-renders in this context.
const renderFreeDispatcher = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useState<S>(initialState: S | (() => S)): [S, (s: S) => void] {
    const value = typeof initialState === 'function' ? (initialState as () => S)() : initialState;
    return [value, () => {}];
  },
  useRef<T>(initialValue: T): { current: T } {
    return { current: initialValue };
  },
  useEffect(_create: () => (() => void) | void, _deps?: ReadonlyArray<unknown>): void {
    // No-op: effects do not run render-free; cleanup is not needed in unit tests.
  },
  useReducer<S, A>(reducer: (state: S, action: A) => S, initialArg: S): [S, (a: A) => void] {
    void reducer;
    return [initialArg, () => {}];
  },
  useCallback<T extends (...args: unknown[]) => unknown>(
    callback: T,
    _deps: ReadonlyArray<unknown>,
  ): T {
    return callback;
  },
  useMemo<T>(create: () => T, _deps: ReadonlyArray<unknown> | undefined): T {
    return create();
  },
  useContext<T>(context: { _currentValue: T }): T {
    return context._currentValue;
  },
  useLayoutEffect(
    _create: () => (() => void) | void,
    _deps?: ReadonlyArray<unknown>,
  ): void {},
  useImperativeHandle<T>(
    _ref: unknown,
    _init: () => T,
    _deps?: ReadonlyArray<unknown>,
  ): void {},
  useDebugValue<T>(_value: T): void {},
  useId(): string {
    return ':test:';
  },
  useTransition(): [boolean, (callback: () => void) => void] {
    return [false, (cb) => cb()];
  },
  useDeferredValue<T>(value: T): T {
    return value;
  },
  useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T): T {
    return getSnapshot();
  },
  useInsertionEffect(
    _create: () => (() => void) | void,
    _deps?: ReadonlyArray<unknown>,
  ): void {},
};

// Install the dispatcher so hook calls inside render-free component calls succeed.
reactInternals.ReactCurrentDispatcher.current = renderFreeDispatcher;
