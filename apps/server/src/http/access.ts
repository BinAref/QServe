/**
 * Who can reach what, named.
 *
 * The restaurant's data lives on the restaurant's computer and is served by
 * this process. Three different audiences reach it, over three different
 * routes, and the difference between them is the whole of the product's
 * security model — so it is written here as three named surfaces rather than
 * left implicit in which router happened to mount which module.
 *
 *   ADMIN   loopback only. The console: settings, users, backups, the licence,
 *           the menu builder. Never leaves the machine.
 *
 *   LAN     the restaurant's own Wi-Fi. Staff terminals and the diner's menu,
 *           including ordering — because a diner on the restaurant's Wi-Fi is
 *           sitting at one of its tables. No management of any kind.
 *
 *   PUBLIC  a read-only menu, and nothing else. Not served in this release.
 *           It exists here so that adding remote access later is attaching a
 *           listener to a surface that already refuses everything dangerous,
 *           rather than deciding in a hurry what a stranger may see.
 *
 * The last one is the reason this file exists. Remote access is a future
 * subscription, and the temptation when it arrives will be to point a tunnel at
 * the LAN listener because it already serves the menu. That listener also takes
 * orders, enrols terminals and serves the staff applications. Publishing it
 * would put all of that on the internet.
 */

import { Router } from '@qserve/http';
import type { Services } from '../container.js';
import type { AppState } from '../core/security.js';
import { createMenuRoutes } from './routes/menu.js';
import { createContentRoutes } from './routes/content.js';

export const AccessSurface = {
  ADMIN: 'ADMIN',
  LAN: 'LAN',
  PUBLIC: 'PUBLIC',
} as const;
export type AccessSurface = (typeof AccessSurface)[keyof typeof AccessSurface];

/**
 * Everything a menu needs to be read, and nothing that can change anything.
 *
 * `createMenuRoutes` carries both halves — a diner reading the menu and an
 * owner editing it — separated by permissions. That separation is correct and
 * it is not enough here: a surface facing the open internet should not have an
 * editing route behind a permission check, it should not have an editing route.
 * So the router is built and then filtered down to the reads, by method.
 *
 * Content routes come along because a menu without its photographs is not a
 * menu; they are reads of uploaded images and the app icon.
 */
export function createPublicMenuRouter(services: Services): Router<AppState> {
  const router = new Router<AppState>();

  const readsOnly = (source: Router<AppState>): Router<AppState> => {
    const filtered = new Router<AppState>();
    for (const route of source.list()) {
      if (route.method !== 'GET') continue;
      filtered.get(route.path, route.handler, route.middleware);
    }
    return filtered;
  };

  router.mount('/api', readsOnly(createMenuRoutes(services)));
  router.mount('/', readsOnly(createContentRoutes(services)));
  return router;
}

/**
 * What a surface is allowed to carry, as a statement rather than a comment.
 *
 * Used by the test that walks every mounted route and checks none of them
 * contradicts this. A route added to the wrong router is the kind of mistake
 * that is invisible in review and obvious in a breach.
 */
export const SURFACE_RULES: Readonly<Record<AccessSurface, {
  readonly reachableFrom: string;
  readonly allowsWrites: boolean;
  readonly allowsManagement: boolean;
  readonly servedInThisRelease: boolean;
}>> = {
  ADMIN: {
    reachableFrom: 'this computer only',
    allowsWrites: true,
    allowsManagement: true,
    servedInThisRelease: true,
  },
  LAN: {
    reachableFrom: "the restaurant's own network",
    allowsWrites: true,
    allowsManagement: false,
    servedInThisRelease: true,
  },
  PUBLIC: {
    reachableFrom: 'the internet, when a remote subscription is active',
    allowsWrites: false,
    allowsManagement: false,
    servedInThisRelease: false,
  },
};
