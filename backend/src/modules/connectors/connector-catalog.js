import { DEFAULT_CONNECTOR_ADAPTER_REGISTRY } from './connector-adapter-registry.js';

export const CONNECTOR_CATALOG = Object.freeze(DEFAULT_CONNECTOR_ADAPTER_REGISTRY.listCatalog());

export const CONNECTOR_KEYS = Object.freeze(
  CONNECTOR_CATALOG.map((item) => item.key),
);
