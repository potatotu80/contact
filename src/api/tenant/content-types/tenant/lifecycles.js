'use strict';

const { generateTenantApiKey } = require('../../../../utils/tenant-api-key');

const ensureTenantApiKey = (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (!String(data.app_api_key || '').trim()) {
    data.app_api_key = generateTenantApiKey(data);
  }
};

module.exports = {
  beforeCreate(event) {
    ensureTenantApiKey(event);
  },

  beforeUpdate(event) {
    ensureTenantApiKey(event);
  },
};
