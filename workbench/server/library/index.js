// Product library + scene library + project persistence. REST wiring lives in routes.js.
import * as products from './products.js';
import { getSceneAsset } from './scene.js';

export { listProducts, getProduct, deleteProduct, builtinProducts, validateProduct } from './products.js';
export { listSceneAssets, getSceneAsset, importUpload, deleteSceneAsset, readSceneText, MAX_UPLOAD_BYTES } from './scene.js';
export { getProjectState, saveProjectState, listProjectStateVersions, getProjectStateVersion, getChatHistory, appendChatHistory, KEEP_VERSIONS, KEEP_MESSAGES } from './projects.js';
export { detectFormat } from './detect.js';
export { LibraryError, dataRoot } from './store.js';

// input.modelAssetId may point at an uploaded, converted model.
export async function saveProduct(input, options = {}) {
  const { product } = await products.saveProduct(input, { ...options, resolveAsset: getSceneAsset });
  return product;
}

export async function saveProductDetailed(input, options = {}) {
  return products.saveProduct(input, { ...options, resolveAsset: getSceneAsset });
}
