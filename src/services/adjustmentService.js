import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

export function subscribeAdjustmentsWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for adjustments.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchAdjustmentsWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:adjustments');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchAdjustmentsWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for adjustments.');

  const [adjustmentResponse, stockResponse, locationResponse, siteResponse, productResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'adjustments', { query: { limit: 500 } }),
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration'),
    callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }).catch(() => ({ products: [] }))
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  return {
    status: 'ready',
    source: 'Live adjustments',
    adjustments: sortAdjustments(normalizeAdjustmentLogs(adjustmentResponse.adjustments || [])),
    stockItems: sortByName(stockResponse.items || []),
    products: sortByName(normalizeProductsForWastage(productResponse.products || productResponse.items || [])),
    sites: sortByName(sites),
    locations: sortByName(locations),
    loaded: {
      adjustments: true,
      stockItems: true,
      products: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveWastageAdjustment(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save wastage.');

  const draft = normalizeWastagePayload(payload);
  if (!draft.items.length) throw new Error('Select at least one menu item to waste.');
  if (!draft.wasteReason) throw new Error('Select a waste reason.');
  if (!draft.locationId) throw new Error('Select a location.');

  return callCloudflareWorkspaceRoute(workspaceKey, 'wastage-adjustments', {
    method: 'POST',
    payload: draft
  });
}

export async function saveManualAdjustments(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save adjustments.');

  const draft = normalizeAdjustmentPayload(payload);
  if (!draft.items.length) throw new Error('Add at least one stock item to the adjustment.');
  if (!draft.mode) throw new Error('Select an adjustment type first.');

  return callCloudflareWorkspaceRoute(workspaceKey, 'adjustments', {
    method: 'POST',
    payload: draft
  });
}

export function normalizeAdjustmentLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeAdjustmentLog(id, item));
}

function normalizeAdjustmentLog(id, item = {}) {
  return {
    ...item,
    id: String(item.id || id || createId('adj')),
    itemId: String(item.itemId || item.stockItemId || '').trim(),
    itemName: String(item.itemName || item.stockItemName || '').trim(),
    stockItemId: String(item.stockItemId || item.itemId || '').trim(),
    stockItemName: String(item.stockItemName || item.itemName || '').trim(),
    category: String(item.category || item.stockItemCategory || '').trim() || 'General',
    locationId: String(item.locationId || '').trim(),
    locationName: String(item.locationName || '').trim(),
    createdBy: String(item.createdBy || item.created_by || '').trim(),
    createdByName: String(item.createdByName || item.user || item.createdByEmail || '').trim(),
    user: String(item.user || item.createdByName || item.createdByEmail || item.createdBy || '').trim(),
    mode: String(item.mode || '').trim() || 'remove',
    qty: Number(item.qty || item.quantity || 0) || 0,
    unit: String(item.unit || '').trim(),
    prevStock: Number(item.prevStock || 0) || 0,
    impactQty: Number(item.impactQty || 0) || 0,
    impactEx: Number(item.impactEx || 0) || 0,
    newStock: Number(item.newStock || 0) || 0,
    note: String(item.note || item.reason || '').trim(),
    wasteReason: String(item.wasteReason || '').trim(),
    date: String(item.date || item.timestamp || '').slice(0, 10),
    timestamp: item.timestamp || item.createdAt || item.date || '',
    createdAt: item.createdAt || item.timestamp || item.date || ''
  };
}

function normalizeAdjustmentPayload(payload = {}) {
  const mode = String(payload.mode || '').trim();
  return {
    mode,
    date: String(payload.date || todayLocal()).trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    note: String(payload.note || '').trim(),
    wasteReason: String(payload.wasteReason || '').trim(),
    items: (payload.items || []).map((item) => ({
      stockItemId: String(item.stockItemId || item.itemId || item.ingId || '').trim(),
      stockItemName: String(item.stockItemName || item.itemName || item.name || '').trim(),
      quantity: Math.max(parseAdjustmentQuantity(item.quantity ?? item.qty ?? 0), 0),
      unit: String(item.unit || '').trim(),
      unitCost: Number(item.unitCost ?? item.cost ?? item.costEx ?? 0) || 0,
      locationId: String(item.locationId || payload.locationId || '').trim(),
      locationName: String(item.locationName || payload.locationName || '').trim()
    })).filter((item) => item.stockItemId && (mode === 'override' ? item.quantity >= 0 : item.quantity > 0))
  };
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  const isDefault = Number(row.is_default || row.isDefault || 0) === 1 || id === 'main';
  const kind = String(row.kind || (isDefault ? 'storage' : 'selling')).trim();
  return {
    id,
    locationId: id,
    siteId: DEFAULT_SITE_ID,
    name: row.display_name || row.displayName || row.name || row.external_name || row.externalName || 'Location',
    displayName: row.display_name || row.displayName || row.name || '',
    type: kind,
    kind,
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault,
    stockRouting: parseJsonObject(row.stock_routing_json || row.stockRoutingJson || row.stockRouting)
  };
}

function parseAdjustmentQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortAdjustments(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

function normalizeProductsForWastage(products = []) {
  return products
    .filter((p) => p && (p.id || p.productId))
    .map((p) => ({
      id: String(p.id || p.productId || '').trim(),
      name: String(p.name || p.productName || '').trim(),
      category: String(p.category || '').trim() || 'General',
      price: Number(p.price || 0) || 0,
      yocoItemId: String(p.yoco_item_id || p.yocoItemId || '').trim()
    }))
    .filter((p) => p.id && p.name);
}

function normalizeWastagePayload(payload = {}) {
  return {
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    wasteReason: String(payload.wasteReason || '').trim(),
    note: String(payload.note || '').trim(),
    date: String(payload.date || todayLocal()).trim(),
    items: (payload.items || []).map((item) => ({
      productId: String(item.productId || item.id || '').trim(),
      productName: String(item.productName || item.name || '').trim(),
      quantity: Math.max(parseAdjustmentQuantity(item.quantity ?? item.qty ?? 0), 0)
    })).filter((item) => item.productId && item.quantity > 0)
  };
}
