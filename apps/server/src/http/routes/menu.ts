/**
 * Menu authoring and menu reading.
 *
 * Two audiences with very different needs share this module:
 *
 *   the **builder** (`menu.manage`) sees everything, including hidden and
 *   unavailable items, because that is what editing means;
 *
 *   the **diner** (`menu.view`) sees the published menu — visible categories,
 *   visible products, prices, and availability flags so a sold-out dish can be
 *   shown greyed rather than vanish mid-meal.
 */

import {
  asObject, EventName, notFound, optionalBoolean, optionalLocalised, optionalNumber,
  optionalString, Permission, requireArray, requireLocalised, requireNumber,
  requireString, requireStringArray, validationError,
} from '@qserve/shared';
import { Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

export function createMenuRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;
  const canView = security.requirePermission(Permission.MENU_VIEW);
  const canManage = security.requirePermission(Permission.MENU_MANAGE);

  const announce = (): void => {
    // Every terminal showing a menu refreshes from this one event, so a price
    // change reaches the tables without anybody reloading a page.
    services.bus.publish({ name: EventName.MENU_UPDATED, payload: { at: new Date().toISOString() } });
  };

  /**
   * Menu edits are audited as carefully as money is. "Who put the price up?"
   * and "who hid that dish?" are questions restaurants really ask, and without
   * a before/after pair the log cannot answer them (spec §19).
   */
  const log = (
    ctx: { state: AppState; ip: string | null },
    action: string,
    entityType: string,
    entityId: string,
    snapshot: { before?: unknown; after?: unknown; detail?: Record<string, unknown> } = {},
  ): void => {
    services.audit.record({
      action,
      actor: ctx.state.auth!.actor,
      entityType,
      entityId,
      ...snapshot,
      clientIp: ctx.ip,
    });
  };

  /* --------------------------------------------------------------- read */

  /** The published menu, as a diner's phone renders it. */
  router.get('/menu', (ctx) => {
    const includeHidden = ctx.query.get('includeHidden') === 'true';
    const showUnavailable = services.settings.get<boolean>('menu.showUnavailableProducts');

    const categories = services.menu.listCategories({ visibleOnly: !includeHidden });
    const products = services.menu.listProducts({ visibleOnly: !includeHidden });
    const profile = services.settings.profile();

    return {
      restaurant: profile
        ? {
            name: profile.name,
            logoAssetId: profile.logoAssetId,
            currency: profile.currency,
            defaultLocale: profile.defaultLocale,
            enabledLocales: profile.enabledLocales,
            themeId: profile.themeId,
            taxInclusive: profile.taxInclusive,
          }
        : null,
      display: {
        showImages: services.settings.get<boolean>('menu.showImages'),
        showPrices: services.settings.get<boolean>('menu.showPrices'),
        showUnavailableProducts: showUnavailable,
      },
      categories,
      products: includeHidden || showUnavailable
        ? products
        : products.filter((product) => product.available),
      addons: services.menu.listAddons(),
    };
  }, [canView]);

  router.get('/menu/stations', () => ({ stations: services.menu.listStations() }), [canView]);

  /* --------------------------------------------------------- categories */

  router.get('/menu/categories', () => ({
    categories: services.menu.listCategories(),
  }), [canManage]);

  router.post('/menu/categories', (ctx) => {
    const body = asObject(ctx.body);
    const category = services.menu.createCategory({
      name: requireLocalised(body, 'name', { max: 120 }),
      description: optionalLocalised(body, 'description', { max: 1000 }),
      imageAssetId: optionalString(body, 'imageAssetId', { max: 64 }),
      visible: optionalBoolean(body, 'visible', true),
    });
    log(ctx, 'menu.category_created', 'category', category.id, { after: category });
    announce();
    return category;
  }, [canManage]);

  router.patch('/menu/categories/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getCategory(id);
    if (!before) throw notFound('category', id);
    const body = asObject(ctx.body);

    services.menu.updateCategory(id, {
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 120 }) } : {}),
      ...(body['description'] !== undefined
        ? { description: optionalLocalised(body, 'description', { max: 1000 }) } : {}),
      ...(body['imageAssetId'] !== undefined
        ? { imageAssetId: optionalString(body, 'imageAssetId', { max: 64 }) } : {}),
      ...(body['visible'] !== undefined ? { visible: optionalBoolean(body, 'visible', true) } : {}),
    });
    const after = services.menu.getCategory(id);
    log(ctx, 'menu.category_updated', 'category', id, { before, after });
    announce();
    return after;
  }, [canManage]);

  router.delete('/menu/categories/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getCategory(id);
    if (!before) throw notFound('category', id);

    // Deleting a category takes its products with it (ON DELETE CASCADE), which
    // is destructive enough to be worth stating out loud in the response.
    const removed = services.menu.listProducts({ categoryId: id });
    services.menu.deleteCategory(id);
    log(ctx, 'menu.category_deleted', 'category', id, {
      before,
      detail: { productsRemoved: removed.length, products: removed.map((p) => p.id) },
    });
    announce();
    return { deleted: id, productsRemoved: removed.length };
  }, [canManage]);

  /* ------------------------------------------------------------ products */

  router.get('/menu/products', (ctx) => {
    const categoryId = ctx.query.get('categoryId');
    return {
      products: services.menu.listProducts(categoryId ? { categoryId } : {}),
    };
  }, [canManage]);

  router.post('/menu/products', (ctx) => {
    const body = asObject(ctx.body);
    const categoryId = requireString(body, 'categoryId', { max: 64 });
    if (!services.menu.getCategory(categoryId)) throw notFound('category', categoryId);

    const product = services.menu.createProduct({
      categoryId,
      name: requireLocalised(body, 'name', { max: 160 }),
      description: optionalLocalised(body, 'description', { max: 2000 }),
      imageAssetId: optionalString(body, 'imageAssetId', { max: 64 }),
      priceMinor: requireNumber(body, 'priceMinor', { min: 0, max: 100_000_000 }),
      visible: optionalBoolean(body, 'visible', true),
      available: optionalBoolean(body, 'available', true),
      station: optionalString(body, 'station', { max: 40 }),
      preparationMinutes: optionalNumber(body, 'preparationMinutes', { min: 0, max: 600 }),
    });

    const addonIds = body['addonIds'] !== undefined
      ? requireStringArray(body, 'addonIds', { max: 100 })
      : null;
    if (addonIds) services.menu.setProductAddons(product.id, addonIds);

    const created = services.menu.getProduct(product.id);
    log(ctx, 'menu.product_created', 'product', product.id, { after: created });
    announce();
    return created;
  }, [canManage]);

  router.get('/menu/products/:id', (ctx) => {
    const product = services.menu.getProduct(ctx.params['id']!);
    if (!product) throw notFound('product', ctx.params['id']!);
    return product;
  }, [canManage]);

  router.patch('/menu/products/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getProduct(id);
    if (!before) throw notFound('product', id);
    const body = asObject(ctx.body);

    services.menu.updateProduct(id, {
      ...(body['categoryId'] !== undefined
        ? { categoryId: requireString(body, 'categoryId', { max: 64 }) } : {}),
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 160 }) } : {}),
      ...(body['description'] !== undefined
        ? { description: optionalLocalised(body, 'description', { max: 2000 }) } : {}),
      ...(body['imageAssetId'] !== undefined
        ? { imageAssetId: optionalString(body, 'imageAssetId', { max: 64 }) } : {}),
      ...(body['priceMinor'] !== undefined
        ? { priceMinor: requireNumber(body, 'priceMinor', { min: 0, max: 100_000_000 }) } : {}),
      ...(body['visible'] !== undefined ? { visible: optionalBoolean(body, 'visible', true) } : {}),
      ...(body['available'] !== undefined
        ? { available: optionalBoolean(body, 'available', true) } : {}),
      ...(body['station'] !== undefined
        ? { station: optionalString(body, 'station', { max: 40 }) } : {}),
      ...(body['preparationMinutes'] !== undefined
        ? { preparationMinutes: optionalNumber(body, 'preparationMinutes', { min: 0, max: 600 }) } : {}),
    });

    if (body['addonIds'] !== undefined) {
      services.menu.setProductAddons(id, requireStringArray(body, 'addonIds', { max: 100 }));
    }

    const after = services.menu.getProduct(id);
    log(ctx, 'menu.product_updated', 'product', id, { before, after });
    announce();
    return after;
  }, [canManage]);

  router.delete('/menu/products/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getProduct(id);
    if (!before) throw notFound('product', id);
    services.menu.deleteProduct(id);
    log(ctx, 'menu.product_deleted', 'product', id, { before });
    announce();
    return { deleted: id };
  }, [canManage]);

  /**
   * Persist a drag-and-drop reorder. Sending the whole ordered list rather than
   * one moved index keeps the client and server from disagreeing about
   * positions after a concurrent edit.
   */
  router.post('/menu/reorder', (ctx) => {
    const body = asObject(ctx.body);
    const target = requireString(body, 'target', { max: 20 });
    if (target !== 'categories' && target !== 'products') {
      throw validationError('target must be "categories" or "products"', { field: 'target' });
    }
    const ids = requireStringArray(body, 'ids', { max: 2000 });
    services.menu.reorder(target, ids);
    log(ctx, 'menu.reordered', target === 'categories' ? 'category' : 'product', target, {
      after: { order: ids },
    });
    announce();
    return { ok: true };
  }, [canManage]);

  /* ------------------------------------------------------------- options */

  router.post('/menu/products/:id/options', (ctx) => {
    const productId = ctx.params['id']!;
    if (!services.menu.getProduct(productId)) throw notFound('product', productId);
    const body = asObject(ctx.body);

    const option = services.menu.createOption(productId, {
      name: requireLocalised(body, 'name', { max: 120 }),
      required: optionalBoolean(body, 'required', false),
      minSelect: optionalNumber(body, 'minSelect', { min: 0, max: 20 }) ?? 0,
      maxSelect: optionalNumber(body, 'maxSelect', { min: 1, max: 20 }) ?? 1,
      sortOrder: optionalNumber(body, 'sortOrder', { min: 0, max: 9999 }) ?? 0,
    });

    // Choices may be supplied inline; a "size" option with no sizes is useless.
    const choices = body['choices'] !== undefined ? requireArray(body, 'choices', { max: 50 }) : [];
    for (const [index, raw] of choices.entries()) {
      const choice = asObject(raw, `choices[${index}]`);
      services.menu.createChoice(option.id, {
        name: requireLocalised(choice, 'name', { max: 120 }),
        priceDeltaMinor: optionalNumber(choice, 'priceDeltaMinor', { min: -1_000_000, max: 1_000_000 }) ?? 0,
        sortOrder: index,
        available: optionalBoolean(choice, 'available', true),
        isDefault: optionalBoolean(choice, 'isDefault', false),
      });
    }

    const created = services.menu.getOption(option.id);
    log(ctx, 'menu.option_created', 'option', option.id, {
      after: created,
      detail: { productId },
    });
    announce();
    return created;
  }, [canManage]);

  router.patch('/menu/options/:optionId', (ctx) => {
    const optionId = ctx.params['optionId']!;
    const before = services.menu.getOption(optionId);
    if (!before) throw notFound('option', optionId);
    const body = asObject(ctx.body);

    services.menu.updateOption(optionId, {
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 120 }) } : {}),
      ...(body['required'] !== undefined ? { required: optionalBoolean(body, 'required', false) } : {}),
      ...(body['minSelect'] !== undefined
        ? { minSelect: requireNumber(body, 'minSelect', { min: 0, max: 20 }) } : {}),
      ...(body['maxSelect'] !== undefined
        ? { maxSelect: requireNumber(body, 'maxSelect', { min: 1, max: 20 }) } : {}),
      ...(body['sortOrder'] !== undefined
        ? { sortOrder: requireNumber(body, 'sortOrder', { min: 0, max: 9999 }) } : {}),
    });
    const after = services.menu.getOption(optionId);
    log(ctx, 'menu.option_updated', 'option', optionId, { before, after });
    announce();
    return after;
  }, [canManage]);

  router.delete('/menu/options/:optionId', (ctx) => {
    const optionId = ctx.params['optionId']!;
    const before = services.menu.getOption(optionId);
    if (!before) throw notFound('option', optionId);
    services.menu.deleteOption(optionId);
    log(ctx, 'menu.option_deleted', 'option', optionId, { before });
    announce();
    return { deleted: optionId };
  }, [canManage]);

  router.post('/menu/options/:optionId/choices', (ctx) => {
    const optionId = ctx.params['optionId']!;
    if (!services.menu.getOption(optionId)) throw notFound('option', optionId);
    const body = asObject(ctx.body);

    const choice = services.menu.createChoice(optionId, {
      name: requireLocalised(body, 'name', { max: 120 }),
      priceDeltaMinor: optionalNumber(body, 'priceDeltaMinor', { min: -1_000_000, max: 1_000_000 }) ?? 0,
      sortOrder: optionalNumber(body, 'sortOrder', { min: 0, max: 9999 }) ?? 0,
      available: optionalBoolean(body, 'available', true),
      isDefault: optionalBoolean(body, 'isDefault', false),
    });
    log(ctx, 'menu.choice_created', 'choice', choice.id, {
      after: choice,
      detail: { optionId },
    });
    announce();
    return choice;
  }, [canManage]);

  router.patch('/menu/choices/:choiceId', (ctx) => {
    const choiceId = ctx.params['choiceId']!;
    const before = services.menu.getChoice(choiceId);
    if (!before) throw notFound('choice', choiceId);
    const body = asObject(ctx.body);

    services.menu.updateChoice(choiceId, {
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 120 }) } : {}),
      ...(body['priceDeltaMinor'] !== undefined
        ? { priceDeltaMinor: requireNumber(body, 'priceDeltaMinor', { min: -1_000_000, max: 1_000_000 }) } : {}),
      ...(body['available'] !== undefined
        ? { available: optionalBoolean(body, 'available', true) } : {}),
      ...(body['isDefault'] !== undefined
        ? { isDefault: optionalBoolean(body, 'isDefault', false) } : {}),
      ...(body['sortOrder'] !== undefined
        ? { sortOrder: requireNumber(body, 'sortOrder', { min: 0, max: 9999 }) } : {}),
    });
    const after = services.menu.getChoice(choiceId);
    log(ctx, 'menu.choice_updated', 'choice', choiceId, { before, after });
    announce();
    return after;
  }, [canManage]);

  router.delete('/menu/choices/:choiceId', (ctx) => {
    const choiceId = ctx.params['choiceId']!;
    const before = services.menu.getChoice(choiceId);
    if (!before) throw notFound('choice', choiceId);
    services.menu.deleteChoice(choiceId);
    log(ctx, 'menu.choice_deleted', 'choice', choiceId, { before });
    announce();
    return { deleted: choiceId };
  }, [canManage]);

  /* -------------------------------------------------------------- addons */

  router.get('/menu/addons', () => ({ addons: services.menu.listAddons() }), [canView]);

  router.post('/menu/addons', (ctx) => {
    const body = asObject(ctx.body);
    const addon = services.menu.createAddon({
      name: requireLocalised(body, 'name', { max: 120 }),
      priceMinor: requireNumber(body, 'priceMinor', { min: 0, max: 1_000_000 }),
      sortOrder: optionalNumber(body, 'sortOrder', { min: 0, max: 9999 }) ?? 0,
      available: optionalBoolean(body, 'available', true),
    });
    log(ctx, 'menu.addon_created', 'addon', addon.id, { after: addon });
    announce();
    return addon;
  }, [canManage]);

  router.patch('/menu/addons/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getAddon(id);
    if (!before) throw notFound('addon', id);
    const body = asObject(ctx.body);

    services.menu.updateAddon(id, {
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 120 }) } : {}),
      ...(body['priceMinor'] !== undefined
        ? { priceMinor: requireNumber(body, 'priceMinor', { min: 0, max: 1_000_000 }) } : {}),
      ...(body['available'] !== undefined
        ? { available: optionalBoolean(body, 'available', true) } : {}),
      ...(body['sortOrder'] !== undefined
        ? { sortOrder: requireNumber(body, 'sortOrder', { min: 0, max: 9999 }) } : {}),
    });
    const after = services.menu.getAddon(id);
    log(ctx, 'menu.addon_updated', 'addon', id, { before, after });
    announce();
    return after;
  }, [canManage]);

  router.delete('/menu/addons/:id', (ctx) => {
    const id = ctx.params['id']!;
    const before = services.menu.getAddon(id);
    if (!before) throw notFound('addon', id);
    services.menu.deleteAddon(id);
    log(ctx, 'menu.addon_deleted', 'addon', id, { before });
    announce();
    return { deleted: id };
  }, [canManage]);

  return router;
}
