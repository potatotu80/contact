'use strict';

const { generateTenantApiKey, isGeneratedTenantApiKey } = require('../../../../utils/tenant-api-key');

const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';

const deriveDeepLinkScheme = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return '';
  }

  return /^[a-z]/.test(normalized) ? normalized : '';
};

const shouldReplaceTenantApiKey = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return true;
  }

  if (normalized === MANAGED_API_KEY_PLACEHOLDER) {
    return true;
  }

  return !isGeneratedTenantApiKey(normalized);
};

const ensureTenantApiKeyOnCreate = (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (shouldReplaceTenantApiKey(data.app_api_key)) {
    data.app_api_key = generateTenantApiKey(data);
  }

  if (!String(data.android_deep_link_scheme || '').trim()) {
    data.android_deep_link_scheme =
      deriveDeepLinkScheme(data.slug) ||
      deriveDeepLinkScheme(data.name) ||
      'memberreward';
  }
};

const ensureTenantApiKeyOnUpdate = (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(data, 'app_api_key')) {
    return;
  }

  if (shouldReplaceTenantApiKey(data.app_api_key)) {
    data.app_api_key = generateTenantApiKey(data);
  }

  if (!String(data.android_deep_link_scheme || '').trim()) {
    data.android_deep_link_scheme =
      deriveDeepLinkScheme(data.slug) ||
      deriveDeepLinkScheme(data.name);
  }
};

module.exports = {
  beforeCreate(event) {
    ensureTenantApiKeyOnCreate(event);
  },

  beforeUpdate(event) {
    ensureTenantApiKeyOnUpdate(event);
  },
};
