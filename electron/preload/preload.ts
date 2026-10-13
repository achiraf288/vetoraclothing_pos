import { contextBridge, ipcRenderer } from 'electron';
import type { MaisonApi } from '../shared/api';

// Sandboxed preload: may only require 'electron'. It exposes a fixed, explicit
// allow-list of channels. ipcRenderer, require, fs and raw SQL are never exposed.
const call =
  (channel: string) =>
  (arg?: unknown) =>
    ipcRenderer.invoke(channel, arg);

const api = {
  app: { getInfo: call('app:getInfo') },
  auth: {
    status: call('auth:status'), setupAdmin: call('auth:setupAdmin'), login: call('auth:login'),
    logout: call('auth:logout'), changePassword: call('auth:changePassword'), listUsers: call('auth:listUsers'),
    createUser: call('auth:createUser'), updateUser: call('auth:updateUser'), resetPassword: call('auth:resetPassword'),
  },
  settings: {
    getDisplay: call('settings:getDisplay'), get: call('settings:get'), update: call('settings:update'),
    listPaymentMethods: call('settings:listPaymentMethods'), savePaymentMethod: call('settings:savePaymentMethod'),
    listDiscountCodes: call('settings:listDiscountCodes'), saveDiscountCode: call('settings:saveDiscountCode'),
  },
  dashboard: { get: call('dashboard:get') },
  catalog: {
    listCategories: call('catalog:listCategories'), saveCategory: call('catalog:saveCategory'),
    listProducts: call('catalog:listProducts'), getProduct: call('catalog:getProduct'), checkSku: call('catalog:checkSku'),
    createProduct: call('catalog:createProduct'), updateProduct: call('catalog:updateProduct'),
    setProductArchived: call('catalog:setProductArchived'), createVariant: call('catalog:createVariant'),
    updateVariant: call('catalog:updateVariant'), setVariantArchived: call('catalog:setVariantArchived'),
    getHistory: call('catalog:getHistory'), pickProductImage: call('catalog:pickProductImage'),
    removeProductImage: call('catalog:removeProductImage'),
  },
  inventory: {
    listStock: call('inventory:listStock'), listMovements: call('inventory:listMovements'),
    adjust: call('inventory:adjust'), valuation: call('inventory:valuation'),
  },
  suppliers: { list: call('suppliers:list'), save: call('suppliers:save') },
  purchases: {
    list: call('purchases:list'), get: call('purchases:get'), saveDraft: call('purchases:saveDraft'),
    receive: call('purchases:receive'), cancel: call('purchases:cancel'),
    createSupplierReturn: call('purchases:createSupplierReturn'), listSupplierReturns: call('purchases:listSupplierReturns'),
  },
  sales: {
    previewDiscount: call('sales:previewDiscount'), lookup: call('sales:lookup'), scan: call('sales:scan'), checkout: call('sales:checkout'), list: call('sales:list'),
    get: call('sales:get'), receipt: call('sales:receipt'), cancel: call('sales:cancel'),
  },
  orders: {
    list: call('orders:list'), create: call('orders:create'), updateStatus: call('orders:updateStatus'), settleCourier: call('orders:settleCourier'),
  },
  returns: { getReturnable: call('returns:getReturnable'), create: call('returns:create'), list: call('returns:list') },
  expenses: {
    list: call('expenses:list'), save: call('expenses:save'), void: call('expenses:void'),
    listCategories: call('expenses:listCategories'), saveCategory: call('expenses:saveCategory'),
  },
  reports: {
    sales: call('reports:sales'), bestSellers: call('reports:bestSellers'), lowStock: call('reports:lowStock'),
    purchases: call('reports:purchases'), exportCsv: call('reports:exportCsv'),
    operations: call('reports:operations'),
  },
  audit: { list: call('audit:list') },
  backup: {
    list: call('backup:list'), create: call('backup:create'), chooseDirectory: call('backup:chooseDirectory'),
    pickFile: call('backup:pickFile'), validate: call('backup:validate'), restore: call('backup:restore'),
    runIntegrityCheck: call('backup:runIntegrityCheck'),
  },
} as unknown as MaisonApi;

contextBridge.exposeInMainWorld('maison', Object.freeze(api));
