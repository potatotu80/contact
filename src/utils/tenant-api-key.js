'use strict';

const crypto = require('crypto');

const generateTenantApiKey = (tenant) => {
  const rawPrefix = String(tenant?.slug || tenant?.name || 'tenant')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const prefix = rawPrefix || 'tenant';
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
};

module.exports = {
  generateTenantApiKey,
};
