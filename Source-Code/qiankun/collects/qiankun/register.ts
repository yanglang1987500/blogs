import { importEntry, ImportEntryOpts } from 'import-html-entry';
import { concat, flow, identity, isFunction, mergeWith } from 'lodash';
import { registerApplication, start as startSingleSpa } from 'single-spa';
import getAddOns from './addons';
import { RegistrableApp, StartOpts } from './interfaces';
import { prefetchApps } from './prefetch';
import { genSandbox } from './sandbox';
import { getDefaultTplWrapper } from './utils';

type Lifecycle<T extends object> = (app: RegistrableApp<T>) => Promise<any>;

export type LifeCycles<T extends object> = {
  beforeLoad?: Lifecycle<T> | Array<Lifecycle<T>>; // function before app load
  beforeMount?: Lifecycle<T> | Array<Lifecycle<T>>; // function before app mount
  afterMount?: Lifecycle<T> | Array<Lifecycle<T>>; // function after app mount
  beforeUnmount?: Lifecycle<T> | Array<Lifecycle<T>>; // function before app unmount
  afterUnmount?: Lifecycle<T> | Array<Lifecycle<T>>; // function after app unmount
};

let microApps: RegistrableApp[] = [];

function toArray<T>(array: T | T[]): T[] {
  return Array.isArray(array) ? array : [array];
}

function execHooksChain<T extends object>(hooks: Array<Lifecycle<T>>, app: RegistrableApp<T>): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends object>(
  validate: StartOpts['singular'],
  app: RegistrableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

class Deferred<T> {
  promise: Promise<T>;

  resolve!: (value?: T | PromiseLike<T>) => void;

  reject!: (reason?: any) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/*
 * with singular mode, any app will wait to load until other apps are unmouting
 * it is useful for the scenario that only one sub app shown at one time
 */
let singular: StartOpts['singular'] = false;
let useJsSandbox = false;
const frameworkStartedDefer = new Deferred<void>();

let importLoaderConfiguration: ImportEntryOpts = {};
export function getImportLoaderConfiguration() {
  return importLoaderConfiguration;
}

export function registerMicroApps<T extends object = {}>(apps: Array<RegistrableApp<T>>, lifeCycles?: LifeCycles<T>) {
  const unregisteredApps = apps.filter(app => !microApps.some(registeredApp => registeredApp.name === app.name));
  microApps = [...microApps, ...unregisteredApps];
  let prevAppUnmountedDeferred: Deferred<void>;
  
  unregisteredApps.forEach(app => {
    const { name, entry, render, activeRule, props = {} } = app;
    registerApplication(
      name,
      async ({ name: appName }) => {
        await frameworkStartedDefer.promise;
        const { getTemplate = identity, ...settings } = importLoaderConfiguration || {};
        const { template: appContent, execScripts, assetPublicPath } = await importEntry(entry, {
          getTemplate: flow(getTemplate, getDefaultTplWrapper(appName)),
          ...settings,
        });
        if (await validateSingularMode(singular, app)) {
          await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
        }
        render({ appContent, loading: true });

        let jsSandbox: Window = window;
        let mountSandbox = () => Promise.resolve();
        let unmountSandbox = () => Promise.resolve();
        if (useJsSandbox) {
          const sandbox = genSandbox(appName, !!singular);
          jsSandbox = sandbox.sandbox;
          mountSandbox = sandbox.mount;
          unmountSandbox = sandbox.unmount;
        }

        const {
          beforeUnmount = [],
          afterUnmount = [],
          afterMount = [],
          beforeMount = [],
          beforeLoad = [],
        } = mergeWith({}, getAddOns(jsSandbox, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

        await execHooksChain(toArray(beforeLoad), app);

        let { bootstrap: bootstrapApp, mount, unmount } = await execScripts(jsSandbox, !singular);

        if (!isFunction(bootstrapApp) || !isFunction(mount) || !isFunction(unmount)) {
          const global = jsSandbox;
          const globalVariableExports = (global as any)[appName] || {};
          bootstrapApp = globalVariableExports.bootstrap;
          mount = globalVariableExports.mount;
          unmount = globalVariableExports.unmount;
          if (!isFunction(bootstrapApp) || !isFunction(mount) || !isFunction(unmount)) {
            throw new Error(`[qiankun] You need to export lifecycle functions in ${appName} entry`);
          }
        }

        return {
          bootstrap: [bootstrapApp],

          mount: [
            async () => {
              if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
                return prevAppUnmountedDeferred.promise;
              }

              return undefined;
            },
            async () => render({ appContent, loading: true }),
            async () => execHooksChain(toArray(beforeMount), app),
            mountSandbox,
            mount,
            async () => render({ appContent, loading: false }),
            async () => execHooksChain(toArray(afterMount), app),
            async () => {
              if (await validateSingularMode(singular, app)) {
                prevAppUnmountedDeferred = new Deferred<void>();
              }
            },
          ],

          unmount: [
            async () => execHooksChain(toArray(beforeUnmount), app),
            unmount,
            unmountSandbox,
            async () => execHooksChain(toArray(afterUnmount), app),
            async () => render({ appContent: '', loading: false }),
            async () => {
              if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
                prevAppUnmountedDeferred.resolve();
              }
            },
          ],
        };
      },
      activeRule,
      props,
    );
  });
}

export function start(opts: StartOpts = {}) {
  window.__POWERED_BY_QIANKUN__ = true;

  const { prefetch = true, jsSandbox = true, singular: singularMode = true, ...importEntryOpts } = opts;
  importLoaderConfiguration = importEntryOpts;

  if (prefetch) {
    prefetchApps(microApps, prefetch, importLoaderConfiguration);
  }

  if (singularMode) {
    singular = singularMode;
  }

  if (jsSandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox');
      // 快照沙箱不支持非 singular 模式
      if (!singularMode) {
        console.error('[qiankun] singular is forced to be true when jsSandbox enable but proxySandbox unavailable');
        singular = true;
      }
    }

    useJsSandbox = jsSandbox;
  }

  startSingleSpa();

  frameworkStartedDefer.resolve();
}
