'use strict';

const { generateTenantApiKey, isGeneratedTenantApiKey } = require('../../../../utils/tenant-api-key');

const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';
const TENANT_UID = 'api::tenant.tenant';

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

const resolveQrInstallBaseUrl = () =>
  String(process.env.QR_INSTALL_BASE_URL || process.env.PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');

const buildQrCodeUrl = (slug) => {
  const normalizedSlug = String(slug || '').trim();
  const baseUrl = resolveQrInstallBaseUrl();
  if (!normalizedSlug || !baseUrl) {
    return '';
  }

  const url = new URL('/qr-install', `${baseUrl}/`);
  url.searchParams.set('tenantCode', normalizedSlug);
  return url.toString();
};

const shouldReplaceGeneratedQrCodeUrl = (value, previousSlug) => {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return true;
  }

  if (!previousSlug) {
    return false;
  }

  return normalizedValue === buildQrCodeUrl(previousSlug);
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

  if (!String(data.qr_code_url || '').trim()) {
    const generatedUrl = buildQrCodeUrl(data.slug || data.name);
    if (generatedUrl) {
      data.qr_code_url = generatedUrl;
    }
  }
};

const ensureTenantApiKeyOnUpdate = async (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'app_api_key') && shouldReplaceTenantApiKey(data.app_api_key)) {
    data.app_api_key = generateTenantApiKey(data);
  }

  if (!String(data.android_deep_link_scheme || '').trim()) {
    data.android_deep_link_scheme =
      deriveDeepLinkScheme(data.slug) ||
      deriveDeepLinkScheme(data.name);
  }

  const tenantId = event.params?.where?.id;
  if (!tenantId) {
    return;
  }

  const existingTenant = await strapi.entityService.findOne(TENANT_UID, tenantId, {
    fields: ['id', 'slug', 'qr_code_url'],
  });
  if (!existingTenant) {
    return;
  }

  const nextSlug = String(data.slug || existingTenant.slug || data.name || '').trim();
  if (!nextSlug) {
    return;
  }

  const explicitQrCodeUrlProvided = Object.prototype.hasOwnProperty.call(data, 'qr_code_url');
  const existingQrCodeUrl = String(existingTenant.qr_code_url || '').trim();
  const nextQrCodeUrl = explicitQrCodeUrlProvided ? data.qr_code_url : existingQrCodeUrl;

  if (shouldReplaceGeneratedQrCodeUrl(nextQrCodeUrl, existingTenant.slug)) {
    const generatedUrl = buildQrCodeUrl(nextSlug);
    if (generatedUrl) {
      data.qr_code_url = generatedUrl;
    }
  }
};

module.exports = {
  beforeCreate(event) {
    ensureTenantApiKeyOnCreate(event);
  },

  async beforeUpdate(event) {
    await ensureTenantApiKeyOnUpdate(event);
  },
};
