'use strict';

const { generateTenantApiKey, isGeneratedTenantApiKey } = require('../../../../utils/tenant-api-key');

const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';

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
};

module.exports = {
  beforeCreate(event) {
    ensureTenantApiKeyOnCreate(event);
  },

  beforeUpdate(event) {
    ensureTenantApiKeyOnUpdate(event);
  },
};
